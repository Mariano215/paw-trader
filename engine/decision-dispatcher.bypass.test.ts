import { describe, it, expect, beforeEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import { initTraderTables } from './db.js'
import { seedMomentumStrategy } from './strategy-manager.js'
import * as bypassCounter from './bypass-counter.js'

// Mock config with bypass ENABLED for these gate tests.
vi.mock('../config.js', async () => {
  const actual = await vi.importActual<typeof import('../config.js')>('../config.js')
  return {
    ...actual,
    TRADER_COMMITTEE_BYPASS: true,
    TRADER_BYPASS_TRADE_TARGET: 20,
    TRADER_DAILY_TRADE_CAP: 20,
  }
})

// Mock engine-client so getEngineClient() doesn't try to hit a real DB.
vi.mock('./engine-client.js', () => ({
  getEngineClient: vi.fn(() => ({
    submitDecision: vi.fn().mockResolvedValue({
      client_order_id: 'coid-bypass', broker_order_id: 'boid-bypass',
      status: 'placed', approved_size_usd: 200,
    }),
    getRiskState: vi.fn(),
    getNav: vi.fn().mockResolvedValue(null),
    getPositions: vi.fn().mockResolvedValue([]),
  })),
}))

// Import dispatcher AFTER the mocks are in place.
import { dispatchApproval } from './decision-dispatcher.js'

function setupTestDb() {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = OFF')
  initTraderTables(db)
  seedMomentumStrategy(db)
  return db
}

function makeTestSignal(db: Database.Database, overrides: { id?: string } = {}) {
  const id = overrides.id ?? 'sig-bypass-1'
  db.prepare(`
    INSERT INTO trader_signals (id, strategy_id, asset, side, raw_score, horizon_days, generated_at, status)
    VALUES (?, 'momentum-stocks', 'AAPL', 'buy', 0.72, 20, ?, 'committee')
  `).run(id, Date.now())
  return id
}

describe('bypass gates', () => {
  beforeEach(() => bypassCounter.resetCountersForTest())

  it('tags bypass thesis as [BYPASS#N/20]', async () => {
    const db = setupTestDb()
    // Seed 7 prior bypass decisions
    for (let i = 1; i <= 7; i++) {
      db.prepare(`INSERT INTO trader_decisions (id, signal_id, action, asset, thesis, confidence, decided_at, status)
        VALUES (?, ?, 'buy', 'AAPL', ?, 0.7, ?, 'approved')`).run(
        `prev-${i}`, `sig-prev-${i}`, `[BYPASS#${i}/20] x`, Date.now() - i * 1000
      )
    }
    const signalId = makeTestSignal(db, { id: 'new-1' })
    // dispatchApproval with bypass=true and no runCommittee needed (bypassed)
    const result = await dispatchApproval(
      db,
      { action: 'approve', approvalId: 'ap-1', decisionId: signalId },
      undefined as any,
      {},
    )
    // The thesis should be tagged [BYPASS#8/20]
    const row = db.prepare(`SELECT thesis FROM trader_decisions WHERE signal_id = ?`).get(signalId) as { thesis: string } | undefined
    expect(row?.thesis).toMatch(/^\[BYPASS#8\/20\]/)
  })

  it('routes to committee when bypass count reaches target', async () => {
    const db = setupTestDb()
    // Seed 20 prior bypass decisions in the past (yesterday) so they count toward
    // the lifetime bypass count but NOT toward today's daily cap.
    const yesterday = Date.now() - 25 * 60 * 60 * 1000  // 25h ago
    for (let i = 1; i <= 20; i++) {
      db.prepare(`INSERT INTO trader_decisions (id, signal_id, action, asset, thesis, confidence, decided_at, status)
        VALUES (?, ?, 'buy', 'AAPL', ?, 0.7, ?, 'approved')`).run(
        `prev-${i}`, `sig-prev-${i}`, `[BYPASS#${i}/20] x`, yesterday - i * 1000
      )
    }
    const runCommittee = vi.fn().mockResolvedValue({
      decision: 'approve', action: 'buy', size_usd: 500, confidence: 0.6,
      thesis: 'committee approved', transcript_id: 'tx-1',
      transcript: {
        signal_id: 's', started_at: 0, finished_at: 0, rounds_executed: 1, round_1: [],
        risk_officer: { role: 'risk_officer', veto: false, reason: '', concerns: [] },
        trader: { role: 'trader', action: 'buy', thesis: '', confidence: 0.6, size_multiplier: 1 },
        errors: [],
      }
    })
    const signalId = makeTestSignal(db, { id: 'new-21' })
    await dispatchApproval(
      db,
      { action: 'approve', approvalId: 'ap-21', decisionId: signalId },
      undefined as any,
      { runCommittee },
    )
    expect(runCommittee).toHaveBeenCalledOnce()
  })

  it('suppresses with daily cap status when daily count reached', async () => {
    const db = setupTestDb()
    const today = bypassCounter.startOfNyDayMs() + 1000
    // Seed 20 decisions today (daily cap hit)
    for (let i = 1; i <= 20; i++) {
      db.prepare(`INSERT INTO trader_decisions (id, signal_id, action, asset, thesis, confidence, decided_at, status)
        VALUES (?, ?, 'buy', 'AAPL', 'x', 0.7, ?, 'approved')`).run(
        `prev-${i}`, `sig-prev-${i}`, today + i
      )
    }
    const signalId = makeTestSignal(db, { id: 'new-cap-1' })
    await dispatchApproval(
      db,
      { action: 'approve', approvalId: 'ap-cap', decisionId: signalId },
      undefined as any,
      {},
    )
    const row = db.prepare(`SELECT status FROM trader_signals WHERE id = ?`).get(signalId) as { status: string }
    expect(row.status).toBe('suppressed_daily_cap')
  })
})
