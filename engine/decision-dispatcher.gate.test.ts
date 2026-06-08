import { describe, it, expect, beforeEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import { initTraderTables } from './db.js'
import { seedMomentumStrategy } from './strategy-manager.js'
import type { PricePoint } from './types.js'

// Mock config with the strategy gate ENABLED.
// Bypass and daily cap kept permissive so gate tests exercise the gate path,
// not unrelated cap logic.
vi.mock('../config.js', async () => {
  const actual = await vi.importActual<typeof import('../config.js')>('../config.js')
  return {
    ...actual,
    TRADER_COMMITTEE_BYPASS: false,
    TRADER_BYPASS_TRADE_TARGET: 20,
    TRADER_DAILY_TRADE_CAP: 20,
    TRADER_STRATEGY_GATE_ENABLED: true,
  }
})

import { dispatchApproval, autoDispatchPendingSignals } from './decision-dispatcher.js'
import type { EngineClient } from './engine-client.js'
import type { CommitteeResult, CommitteeSignalInput } from './committee.js'
import type { LadderResult } from './autonomy-ladder.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDb() {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = OFF')
  initTraderTables(db)
  seedMomentumStrategy(db)
  return db
}

function makeBars(closes: number[]): PricePoint[] {
  return closes.map((close, i) => ({
    date: `2026-01-${String(i + 1).padStart(2, '0')}`,
    close,
    ts_ms: 1_700_000_000_000 + i * 86_400_000,
  }))
}

/** 240 bars of gentle uptrend: last price well above the 200-bar SMA, low vol. */
const UPTREND_BARS = makeBars(Array.from({ length: 240 }, (_, i) => 100 + i * 0.5))

/** 240 bars that rise then sharply fall below the 200-bar SMA. */
const DOWNTREND_BARS = makeBars([
  ...Array.from({ length: 200 }, (_, i) => 100 + i),
  ...Array.from({ length: 40 }, (_, i) => 300 - i * 6),
])

const tier1: LadderResult = { tier: 'tier-1', scale: 1.0, reason: 'test' }

function makeApproveCommittee(sizeUsd = 150) {
  return async (s: CommitteeSignalInput): Promise<CommitteeResult> => ({
    decision: 'approve', action: s.side, thesis: 'stub approve', confidence: 0.78,
    size_usd: sizeUsd, transcript_id: 'tr-gate-test',
    transcript: {
      signal_id: s.id, started_at: Date.now(), finished_at: Date.now(),
      rounds_executed: 1, round_1: [],
      risk_officer: { role: 'risk_officer', veto: false, reason: 'ok', concerns: [] },
      trader: { role: 'trader', action: s.side, thesis: 'ok', confidence: 0.78, size_multiplier: 1 },
      errors: [],
    },
  })
}

function makeEngine(bars: PricePoint[], nav = 100_000): Partial<EngineClient> {
  return {
    submitDecision: vi.fn().mockResolvedValue({
      client_order_id: 'coid-gate', broker_order_id: 'boid-gate',
      status: 'placed', approved_size_usd: 150,
    }),
    getNav: vi.fn().mockResolvedValue(nav),
    getPositions: vi.fn().mockResolvedValue([]),
    getPrices: vi.fn().mockResolvedValue(bars),
  }
}

// ---------------------------------------------------------------------------
// dispatchApproval -- strategy gate
// ---------------------------------------------------------------------------

describe('dispatchApproval: TRADER_STRATEGY_GATE_ENABLED', () => {
  let db: ReturnType<typeof makeDb>

  beforeEach(() => { db = makeDb() })

  it('suppresses a buy below the 200DMA and records regime suppression', async () => {
    const id = 'sig-gate-approval-down'
    db.prepare(`INSERT INTO trader_signals
      (id, strategy_id, asset, side, raw_score, horizon_days, generated_at, status)
      VALUES (?, 'momentum-stocks', 'SPY', 'buy', 0.8, 20, ?, 'committee')`
    ).run(id, Date.now())

    const engine = makeEngine(DOWNTREND_BARS)
    const msg = await dispatchApproval(
      db,
      { action: 'approve', approvalId: 'ap-gate-1', decisionId: id },
      engine as EngineClient,
      { runCommittee: makeApproveCommittee(150), classifyTier: () => tier1 },
    )

    expect(msg).toContain('Suppressed by strategy gate')
    const sig = db.prepare("SELECT status FROM trader_signals WHERE id=?").get(id) as any
    expect(sig.status).toBe('suppressed_regime')
    // Suppression record written (issue #3)
    const sup = db.prepare(
      "SELECT reason FROM trader_signal_suppressions WHERE signal_id=?"
    ).get(id) as any
    expect(sup?.reason).toBe('regime')
    // Engine never called
    expect(engine.submitDecision).not.toHaveBeenCalled()
  })

  it('allows a buy above the 200DMA and does not suppress', async () => {
    const id = 'sig-gate-approval-up'
    db.prepare(`INSERT INTO trader_signals
      (id, strategy_id, asset, side, raw_score, horizon_days, generated_at, status)
      VALUES (?, 'momentum-stocks', 'SPY', 'buy', 0.8, 20, ?, 'committee')`
    ).run(id, Date.now())

    const engine = makeEngine(UPTREND_BARS)
    const msg = await dispatchApproval(
      db,
      { action: 'approve', approvalId: 'ap-gate-2', decisionId: id },
      engine as EngineClient,
      { runCommittee: makeApproveCommittee(150), classifyTier: () => tier1 },
    )

    expect(msg).not.toContain('Suppressed')
    expect(engine.submitDecision).toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// autoDispatchPendingSignals -- strategy gate (issue #2: symmetric path)
// ---------------------------------------------------------------------------

describe('autoDispatchPendingSignals: TRADER_STRATEGY_GATE_ENABLED', () => {
  let db: ReturnType<typeof makeDb>

  beforeEach(() => { db = makeDb() })

  it('suppresses a pending buy below the 200DMA via the auto-dispatch path', async () => {
    const id = 'sig-auto-gate-down'
    db.prepare(`INSERT INTO trader_signals
      (id, strategy_id, asset, side, raw_score, horizon_days, generated_at, status)
      VALUES (?, 'momentum-stocks', 'SPY', 'buy', 0.8, 20, ?, 'pending')`
    ).run(id, Date.now())

    const engine = makeEngine(DOWNTREND_BARS)
    const results = await autoDispatchPendingSignals(
      db,
      { send: async () => {}, runCommittee: makeApproveCommittee(150) },
      engine as EngineClient,
    )

    const suppressed = results.find((r) => r.signalId === id)
    expect(suppressed?.action).toBe('suppressed')
    expect(suppressed?.reason).toContain('below')

    const sig = db.prepare("SELECT status FROM trader_signals WHERE id=?").get(id) as any
    expect(sig.status).toBe('suppressed_regime')

    // Suppression record written (issue #3, auto-dispatch path)
    const sup = db.prepare(
      "SELECT reason FROM trader_signal_suppressions WHERE signal_id=?"
    ).get(id) as any
    expect(sup?.reason).toBe('regime')

    // Engine never called (suppressed before submit)
    expect(engine.submitDecision).not.toHaveBeenCalled()
  })

  it('allows a pending buy above the 200DMA through the auto-dispatch path', async () => {
    const id = 'sig-auto-gate-up'
    db.prepare(`INSERT INTO trader_signals
      (id, strategy_id, asset, side, raw_score, horizon_days, generated_at, status)
      VALUES (?, 'momentum-stocks', 'SPY', 'buy', 0.8, 20, ?, 'pending')`
    ).run(id, Date.now())

    const engine = makeEngine(UPTREND_BARS)
    await autoDispatchPendingSignals(
      db,
      { send: async () => {}, runCommittee: makeApproveCommittee(150) },
      engine as EngineClient,
    )

    // Engine called -- trade went through
    expect(engine.submitDecision).toHaveBeenCalled()
    const sig = db.prepare("SELECT status FROM trader_signals WHERE id=?").get(id) as any
    // Status is dispatching/submitted, not suppressed_regime
    expect(sig.status).not.toBe('suppressed_regime')
  })

  // Issue #1: a sell-side signal must never be zeroed by the gate's sizeUsd=null
  // pass-through. Even with the gate enabled, a sell goes straight to the engine
  // at its original committee-sized amount.
  it('does not zero a sell-side signal (sizeUsd=null pass-through does not shrink)', async () => {
    const id = 'sig-auto-gate-sell'
    db.prepare(`INSERT INTO trader_signals
      (id, strategy_id, asset, side, raw_score, horizon_days, generated_at, status)
      VALUES (?, 'momentum-stocks', 'SPY', 'sell', 0.8, 20, ?, 'pending')`
    ).run(id, Date.now())

    const submitSpy = vi.fn().mockResolvedValue({
      client_order_id: 'coid-sell', broker_order_id: 'boid-sell',
      status: 'placed', approved_size_usd: 150,
    })
    const engine: Partial<EngineClient> = {
      submitDecision: submitSpy,
      getNav: vi.fn().mockResolvedValue(100_000),
      getPositions: vi.fn().mockResolvedValue([]),
      // Return downtrend bars for the sell -- if the gate incorrectly applied
      // to sells, the sizeUsd=null would become 0 and the engine would get a
      // $0 order (422). The gate must pass sells through untouched.
      getPrices: vi.fn().mockResolvedValue(DOWNTREND_BARS),
    }

    await autoDispatchPendingSignals(
      db,
      { send: async () => {}, runCommittee: makeApproveCommittee(150) },
      engine as EngineClient,
    )

    // Engine must have been called with a positive size_usd
    expect(submitSpy).toHaveBeenCalled()
    const submitted = submitSpy.mock.calls[0][0] as { size_usd: number }
    expect(submitted.size_usd).toBeGreaterThan(0)
  })
})

// M2: the markov_gate suppression path must call recordSignalSuppressionBySignalId
// so the re-alert dedup table is populated. Previously it only set
// status='suppressed_markov_gate' with no suppression row.
describe('autoDispatchPendingSignals: markov_gate suppression row', () => {
  let db: ReturnType<typeof makeDb>
  beforeEach(() => { db = makeDb() })

  it('M2: writes a trader_signal_suppressions row with reason=markov_gate on markov conflict', async () => {
    const id = 'sig-markov-gate'
    // enrichment_json with a bearish markov signal (<=−0.30) for a buy-side signal
    // triggers the markov pre-gate in autoDispatchPendingSignals.
    const enrichment = JSON.stringify({ markov_regime: { markov_signal: -0.45 } })
    db.prepare(`INSERT INTO trader_signals
      (id, strategy_id, asset, side, raw_score, horizon_days, generated_at, status, enrichment_json)
      VALUES (?, 'momentum-stocks', 'AAPL', 'buy', 0.8, 20, ?, 'pending', ?)`
    ).run(id, Date.now(), enrichment)

    // Engine returns uptrend bars -- the markov gate fires BEFORE the SMA gate,
    // so the SMA would pass but the markov conflict suppresses first.
    const engine = makeEngine(UPTREND_BARS)
    await autoDispatchPendingSignals(
      db,
      { send: async () => {}, runCommittee: makeApproveCommittee(150) },
      engine as EngineClient,
    )

    // Signal status must be suppressed by markov gate.
    const sig = db.prepare("SELECT status FROM trader_signals WHERE id=?").get(id) as any
    expect(sig.status).toBe('suppressed_markov_gate')

    // M2: suppression row must now exist for re-alert dedup.
    const sup = db.prepare(
      "SELECT reason FROM trader_signal_suppressions WHERE signal_id=?"
    ).get(id) as any
    expect(sup).toBeTruthy()
    expect(sup.reason).toBe('markov_gate')

    // Engine never called.
    expect(engine.submitDecision).not.toHaveBeenCalled()
  })
})
