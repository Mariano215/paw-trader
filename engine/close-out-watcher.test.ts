/**
 * close-out-watcher.test.ts -- Phase 3 Task 1
 *
 * Verifies the close-out detection + verdict persistence path. Uses an
 * in-memory SQLite DB plus a stub EngineClient -- no real network or
 * subprocess.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import Database from 'better-sqlite3'

import { initTraderTables } from './db.js'
import { seedAllStrategies } from './strategy-manager.js'
import {
  findOpenDecisions,
  processClosure,
  runCloseOutSweep,
  fetchReturnsForDecision,
} from './close-out-watcher.js'
import type { OpenDecisionRow, PriceFetchResult } from './close-out-watcher.js'
import type { EngineClient } from './engine-client.js'
import type { EnginePosition, EngineOrder, PricePoint } from './types.js'
import type { CommitteeTranscript } from './committee.js'
import { recordFill } from './audit-log.js'

function makeDb() {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = OFF')
  initTraderTables(db)
  seedAllStrategies(db)
  return db
}

function insertSignal(
  db: Database.Database,
  id: string,
  overrides: Partial<{ asset: string; side: string; strategy: string }> = {},
) {
  db.prepare(`
    INSERT INTO trader_signals (id, strategy_id, asset, side, raw_score, horizon_days, generated_at, status)
    VALUES (?, ?, ?, ?, 0.7, 20, ?, 'decided')
  `).run(
    id,
    overrides.strategy ?? 'momentum-stocks',
    overrides.asset ?? 'AAPL',
    overrides.side ?? 'buy',
    Date.now(),
  )
}

function insertExecutedDecision(
  db: Database.Database,
  decisionId: string,
  signalId: string,
  overrides: Partial<{ asset: string; action: string; transcriptId: string | null; decidedAt: number; thesis: string; filledQty: number | null; filledAvgPrice: number | null }> = {},
) {
  // filled_qty / filled_avg_price default to the pooled fill most tests mock
  // (10 @ 100): per-decision lot attribution requires a cached fill, and a
  // single-decision lot equal to the pooled rollup keeps legacy expectations.
  const filledQty = overrides.filledQty === undefined ? 10 : overrides.filledQty
  const filledAvgPrice = overrides.filledAvgPrice === undefined ? 100 : overrides.filledAvgPrice
  db.prepare(`
    INSERT INTO trader_decisions
      (id, signal_id, action, asset, size_usd, entry_type, thesis, confidence,
       committee_transcript_id, decided_at, status, filled_qty, filled_avg_price)
    VALUES (?, ?, ?, ?, 100, 'limit', ?, 0.7, ?, ?, 'executed', ${filledQty === null ? 'NULL' : filledQty}, ${filledAvgPrice === null ? 'NULL' : filledAvgPrice})
  `).run(
    decisionId,
    signalId,
    overrides.action ?? 'buy',
    overrides.asset ?? 'AAPL',
    overrides.thesis ?? 'momentum continuation',
    overrides.transcriptId ?? null,
    overrides.decidedAt ?? 1000,
  )
}

function insertTranscript(
  db: Database.Database,
  id: string,
  signalId: string,
  body: Partial<CommitteeTranscript> = {},
) {
  const transcript: CommitteeTranscript = {
    signal_id: signalId,
    started_at: 0,
    finished_at: 1000,
    rounds_executed: 1,
    round_1: [
      { role: 'quant', opinion: 'long', confidence: 0.7, concerns: [] },
      { role: 'fundamentalist', opinion: 'long', confidence: 0.6, concerns: ['valuation'] },
      { role: 'macro', opinion: 'pass', confidence: 0.4, concerns: [] },
      { role: 'sentiment', opinion: 'long', confidence: 0.55, concerns: [] },
    ],
    risk_officer: { role: 'risk_officer', veto: false, reason: 'ok', concerns: [] },
    trader: { role: 'trader', action: 'buy', thesis: 'go long', confidence: 0.65, size_multiplier: 1 },
    errors: [],
    ...body,
  }
  db.prepare(`
    INSERT INTO trader_committee_transcripts
      (id, signal_id, transcript_json, rounds, total_tokens, total_cost_usd, created_at)
    VALUES (?, ?, ?, 1, 0, 0, ?)
  `).run(id, signalId, JSON.stringify(transcript), Date.now())
}

function fillOrder(overrides: Partial<EngineOrder> = {}): EngineOrder {
  return {
    client_order_id: 'co-' + Math.random().toString(36).slice(2, 8),
    broker_order_id: null,
    asset: 'AAPL',
    side: 'buy',
    qty: 1,
    order_type: 'limit',
    limit_price: null,
    status: 'filled',
    filled_qty: 1,
    filled_avg_price: 100,
    source: 'test',
    created_at: 2000,
    updated_at: 2000,
    ...overrides,
  }
}

describe('findOpenDecisions', () => {
  let db: ReturnType<typeof makeDb>
  beforeEach(() => { db = makeDb() })

  it('returns executed decisions with no verdict yet', () => {
    insertSignal(db, 'sig-1')
    insertExecutedDecision(db, 'dec-1', 'sig-1')
    const open = findOpenDecisions(db)
    expect(open.map(d => d.id)).toEqual(['dec-1'])
  })

  it('excludes decisions that already have a verdict', () => {
    insertSignal(db, 'sig-1')
    insertExecutedDecision(db, 'dec-1', 'sig-1')
    db.prepare(`
      INSERT INTO trader_verdicts
        (id, decision_id, pnl_gross, pnl_net, bench_return, hold_drawdown,
         thesis_grade, agent_attribution_json, closed_at)
      VALUES ('v1', 'dec-1', 0, 0, 0, 0, 'D', '[]', 0)
    `).run()
    const open = findOpenDecisions(db)
    expect(open).toEqual([])
  })

  it('excludes committee_abstain decisions', () => {
    insertSignal(db, 'sig-1')
    db.prepare(`
      INSERT INTO trader_decisions
        (id, signal_id, action, asset, size_usd, entry_type, thesis, confidence,
         committee_transcript_id, decided_at, status)
      VALUES ('dec-abstain', 'sig-1', 'abstain', 'AAPL', 0, 'none', 'no', 0.1, NULL, 1000, 'committee_abstain')
    `).run()
    const open = findOpenDecisions(db)
    expect(open).toEqual([])
  })

  it('excludes decisions already marked closed', () => {
    insertSignal(db, 'sig-1')
    insertExecutedDecision(db, 'dec-1', 'sig-1')
    db.prepare("UPDATE trader_decisions SET status='closed' WHERE id='dec-1'").run()
    expect(findOpenDecisions(db)).toEqual([])
  })
})

describe('processClosure', () => {
  let db: ReturnType<typeof makeDb>
  beforeEach(() => { db = makeDb() })

  function getOpen(decisionId: string): OpenDecisionRow {
    return findOpenDecisions(db).find(d => d.id === decisionId)!
  }

  it('returns still-open when asset is in current positions', () => {
    insertSignal(db, 'sig-1')
    insertExecutedDecision(db, 'dec-1', 'sig-1')

    const positions: EnginePosition[] = [
      { asset: 'AAPL', qty: 1, avg_entry_price: 100, market_value: 100, unrealized_pnl: 0, source: 'paper', updated_at: Date.now() },
    ]
    const result = processClosure(db, getOpen('dec-1'), positions, [])
    expect(result.reason).toBe('still-open')
    expect(result.outcome).toBeNull()
    const verdictCount = db.prepare('SELECT COUNT(*) as n FROM trader_verdicts').get() as { n: number }
    expect(verdictCount.n).toBe(0)
  })

  it('writes a verdict + reasoning bank case when fully closed', () => {
    insertSignal(db, 'sig-1', { asset: 'AAPL', strategy: 'momentum-stocks' })
    insertTranscript(db, 'tr-1', 'sig-1')
    insertExecutedDecision(db, 'dec-1', 'sig-1', { transcriptId: 'tr-1' })

    const orders: EngineOrder[] = [
      fillOrder({ side: 'buy',  asset: 'AAPL', filled_qty: 10, filled_avg_price: 100, created_at: 1100, updated_at: 1100 }),
      fillOrder({ side: 'sell', asset: 'AAPL', filled_qty: 10, filled_avg_price: 110, created_at: 5000, updated_at: 5000 }),
    ]
    const result = processClosure(db, getOpen('dec-1'), [], orders)

    expect(result.reason).toBe('closed')
    expect(result.outcome!.pnlGross).toBe(100)
    expect(result.outcome!.thesisGrade).toBe('A')
    expect(result.attribution.length).toBeGreaterThan(0)

    const verdict = db.prepare('SELECT * FROM trader_verdicts WHERE decision_id = ?').get('dec-1') as any
    expect(verdict).toBeDefined()
    expect(verdict.pnl_gross).toBe(100)
    expect(verdict.thesis_grade).toBe('A')
    expect(verdict.closed_at).toBe(5000)

    const decisionAfter = db.prepare('SELECT status FROM trader_decisions WHERE id=?').get('dec-1') as any
    expect(decisionAfter.status).toBe('closed')

    const bankRow = db.prepare('SELECT * FROM trader_reasoning_bank WHERE decision_id=?').get('dec-1') as any
    expect(bankRow).toBeDefined()
    expect(bankRow.outcome).toBe('win')
    expect(bankRow.thesis_grade).toBe('A')
    expect(bankRow.summary).toContain('AAPL buy via momentum-stocks')
  })

  it('records a loss outcome when pnl is negative', () => {
    insertSignal(db, 'sig-1')
    insertTranscript(db, 'tr-1', 'sig-1')
    insertExecutedDecision(db, 'dec-1', 'sig-1', { transcriptId: 'tr-1', filledQty: 5, filledAvgPrice: 100 })

    const orders: EngineOrder[] = [
      fillOrder({ side: 'buy',  filled_qty: 5, filled_avg_price: 100, created_at: 1100, updated_at: 1100 }),
      fillOrder({ side: 'sell', filled_qty: 5, filled_avg_price: 90,  created_at: 5000, updated_at: 5000 }),
    ]
    const result = processClosure(db, getOpen('dec-1'), [], orders)

    expect(result.outcome!.pnlGross).toBe(-50)
    const bankRow = db.prepare('SELECT outcome, thesis_grade FROM trader_reasoning_bank WHERE decision_id=?').get('dec-1') as any
    expect(bankRow.outcome).toBe('loss')
    expect(bankRow.thesis_grade).toBe('D')
  })

  it('writes verdict with empty attribution when transcript is missing', () => {
    insertSignal(db, 'sig-1')
    insertExecutedDecision(db, 'dec-1', 'sig-1', { transcriptId: null, filledQty: 1, filledAvgPrice: 100 })

    const orders: EngineOrder[] = [
      fillOrder({ side: 'buy',  filled_qty: 1, filled_avg_price: 100, created_at: 1100, updated_at: 1100 }),
      fillOrder({ side: 'sell', filled_qty: 1, filled_avg_price: 105, created_at: 5000, updated_at: 5000 }),
    ]
    const result = processClosure(db, getOpen('dec-1'), [], orders)

    expect(result.reason).toBe('closed')
    expect(result.attribution).toEqual([])
    const verdict = db.prepare('SELECT agent_attribution_json FROM trader_verdicts WHERE decision_id=?').get('dec-1') as any
    expect(verdict.agent_attribution_json).toBe('[]')
  })

  it('skips no-fills branch and does not write a verdict', () => {
    insertSignal(db, 'sig-1')
    insertExecutedDecision(db, 'dec-1', 'sig-1', { decidedAt: 1000 })

    // Asset is closed (no position) and no orders match.
    const result = processClosure(db, getOpen('dec-1'), [], [])
    expect(result.reason).toBe('no-fills')
    const count = db.prepare('SELECT COUNT(*) as n FROM trader_verdicts').get() as { n: number }
    expect(count.n).toBe(0)
  })

  it('partial close: defers verdict and returns partial reason', () => {
    insertSignal(db, 'sig-1')
    insertExecutedDecision(db, 'dec-1', 'sig-1', { decidedAt: 1000 })

    const orders: EngineOrder[] = [
      fillOrder({ side: 'buy',  filled_qty: 10, filled_avg_price: 100, created_at: 1100, updated_at: 1100 }),
      fillOrder({ side: 'sell', filled_qty: 5,  filled_avg_price: 110, created_at: 5000, updated_at: 5000 }),
    ]
    const result = processClosure(db, getOpen('dec-1'), [], orders)
    expect(result.reason).toBe('partial')
    const count = db.prepare('SELECT COUNT(*) as n FROM trader_verdicts').get() as { n: number }
    expect(count.n).toBe(0)
  })

  it('recomputes the strategy track record after writing a verdict', () => {
    insertSignal(db, 'sig-tr', { asset: 'AAPL', strategy: 'momentum-stocks' })
    insertExecutedDecision(db, 'dec-tr', 'sig-tr', { asset: 'AAPL', decidedAt: 1000 })

    const orders: EngineOrder[] = [
      fillOrder({ side: 'buy',  filled_qty: 10, filled_avg_price: 100, created_at: 1100, updated_at: 1100 }),
      fillOrder({ side: 'sell', filled_qty: 10, filled_avg_price: 110, created_at: 5000, updated_at: 5000 }),
    ]
    const result = processClosure(db, getOpen('dec-tr'), [], orders)
    expect(result.reason).toBe('closed')

    const tr = db.prepare("SELECT * FROM trader_strategy_track_record WHERE strategy_id='momentum-stocks'").get() as any
    expect(tr).toBeDefined()
    expect(tr.trade_count).toBe(1)
    expect(tr.win_count).toBe(1)
    expect(tr.net_pnl_usd).toBe(100)
  })

  it('still persists verdict if reasoning bank signal lookup fails (signal missing)', () => {
    // Decision exists but signal row was deleted somehow.
    insertSignal(db, 'sig-x')
    insertTranscript(db, 'tr-1', 'sig-x')
    insertExecutedDecision(db, 'dec-orphan', 'sig-x', { transcriptId: 'tr-1', filledQty: 1, filledAvgPrice: 100 })
    db.prepare("DELETE FROM trader_signals WHERE id='sig-x'").run()

    const orders: EngineOrder[] = [
      fillOrder({ side: 'buy',  filled_qty: 1, filled_avg_price: 100, created_at: 1100, updated_at: 1100 }),
      fillOrder({ side: 'sell', filled_qty: 1, filled_avg_price: 110, created_at: 5000, updated_at: 5000 }),
    ]
    const result = processClosure(db, getOpen('dec-orphan'), [], orders)
    expect(result.reason).toBe('closed')
    const verdict = db.prepare('SELECT * FROM trader_verdicts WHERE decision_id=?').get('dec-orphan') as any
    expect(verdict).toBeDefined()
    // Bank row not written because signal lookup returned undefined.
    const bank = db.prepare('SELECT * FROM trader_reasoning_bank WHERE decision_id=?').get('dec-orphan') as any
    expect(bank).toBeUndefined()
  })
})

describe('runCloseOutSweep', () => {
  let db: ReturnType<typeof makeDb>
  let getPositions: ReturnType<typeof vi.fn>
  let getOrders: ReturnType<typeof vi.fn>
  let getPrices: ReturnType<typeof vi.fn>
  let engine: EngineClient

  beforeEach(() => {
    db = makeDb()
    getPositions = vi.fn().mockResolvedValue([])
    getOrders = vi.fn().mockResolvedValue([])
    // Phase 4 Task B: /prices stub returning empty keeps pre-backfill
    // tests focused on orchestration rather than price math. The
    // close-out-watcher treats "no bars" as success=false and leaves
    // placeholders in place, which matches the original assertions.
    getPrices = vi.fn().mockResolvedValue([])
    // P5: writeDailySnapshot calls getNavLatest every tick; stub so tests
    // that don't care about NAV don't throw inside the snapshot writer.
    const getNavLatest = vi.fn().mockResolvedValue(null)
    engine = { getPositions, getOrders, getPrices, getNavLatest } as unknown as EngineClient
  })

  it('returns zeros when no decisions are open', async () => {
    const result = await runCloseOutSweep(db, engine)
    expect(result).toEqual({ processed: 0, stillOpen: 0, errors: 0 })
    // getPositions is called by writeDailySnapshot (open MTM); getOrders is
    // NOT called when open.length === 0 (no close-out processing needed).
    expect(getOrders).not.toHaveBeenCalled()
  })

  it('returns errors=1 when engine fetch fails', async () => {
    insertSignal(db, 'sig-1')
    insertExecutedDecision(db, 'dec-1', 'sig-1')
    getPositions.mockRejectedValue(new Error('engine 503'))

    const result = await runCloseOutSweep(db, engine)
    expect(result).toEqual({ processed: 0, stillOpen: 0, errors: 1 })
    const count = db.prepare('SELECT COUNT(*) as n FROM trader_verdicts').get() as { n: number }
    expect(count.n).toBe(0)
  })

  it('processes a mix of open and closed decisions in one pass', async () => {
    // Two decisions: AAPL still open, NVDA fully closed.
    insertSignal(db, 'sig-aapl', { asset: 'AAPL' })
    insertSignal(db, 'sig-nvda', { asset: 'NVDA' })
    insertTranscript(db, 'tr-nvda', 'sig-nvda')
    insertExecutedDecision(db, 'dec-aapl', 'sig-aapl', { asset: 'AAPL', decidedAt: 1000 })
    insertExecutedDecision(db, 'dec-nvda', 'sig-nvda', { asset: 'NVDA', decidedAt: 1000, transcriptId: 'tr-nvda', filledQty: 5, filledAvgPrice: 200 })

    getPositions.mockResolvedValue([
      { asset: 'AAPL', qty: 1, avg_entry_price: 100, market_value: 100, unrealized_pnl: 0, source: 'paper', updated_at: Date.now() },
    ])
    getOrders.mockResolvedValue([
      fillOrder({ asset: 'NVDA', side: 'buy',  filled_qty: 5, filled_avg_price: 200, created_at: 1100, updated_at: 1100 }),
      fillOrder({ asset: 'NVDA', side: 'sell', filled_qty: 5, filled_avg_price: 220, created_at: 5000, updated_at: 5000 }),
    ])

    const result = await runCloseOutSweep(db, engine)
    expect(result).toEqual({ processed: 1, stillOpen: 1, errors: 0 })

    const verdicts = db.prepare('SELECT decision_id, pnl_gross FROM trader_verdicts ORDER BY decision_id').all() as any[]
    expect(verdicts).toHaveLength(1)
    expect(verdicts[0].decision_id).toBe('dec-nvda')
    expect(verdicts[0].pnl_gross).toBe(100)
  })

  it('isolates a failure in one closure from the rest of the sweep', async () => {
    insertSignal(db, 'sig-good', { asset: 'AAPL' })
    insertSignal(db, 'sig-bad', { asset: 'BAD' })
    insertExecutedDecision(db, 'dec-good', 'sig-good', { asset: 'AAPL', decidedAt: 1000, filledQty: 1, filledAvgPrice: 100 })
    insertExecutedDecision(db, 'dec-bad',  'sig-bad',  { asset: 'BAD',  decidedAt: 1000 })

    getPositions.mockResolvedValue([])
    getOrders.mockResolvedValue([
      fillOrder({ asset: 'AAPL', side: 'buy',  filled_qty: 1, filled_avg_price: 100, created_at: 1100, updated_at: 1100 }),
      fillOrder({ asset: 'AAPL', side: 'sell', filled_qty: 1, filled_avg_price: 105, created_at: 5000, updated_at: 5000 }),
      // BAD asset has no fills -> 'no-fills' branch (counted as error per design)
    ])

    const result = await runCloseOutSweep(db, engine)
    expect(result.processed).toBe(1)
    expect(result.errors).toBe(1)
    // The good decision still got a verdict despite the bad one's no-fills.
    const verdict = db.prepare('SELECT * FROM trader_verdicts WHERE decision_id=?').get('dec-good') as any
    expect(verdict).toBeDefined()
  })

  it('makes exactly one close-out engine round-trip regardless of decision count', async () => {
    for (let i = 0; i < 5; i++) {
      insertSignal(db, `sig-${i}`, { asset: `A${i}` })
      insertExecutedDecision(db, `dec-${i}`, `sig-${i}`, { asset: `A${i}`, decidedAt: 1000 })
    }
    await runCloseOutSweep(db, engine)
    // getOrders: exactly 1 call (shared across all open decisions in the loop).
    expect(getOrders).toHaveBeenCalledTimes(1)
    // getPositions: 1 call in the close-out loop + 1 call in writeDailySnapshot.
    expect(getPositions).toHaveBeenCalledTimes(2)
  })

  it('writes a daily PnL snapshot even when nothing closes', async () => {
    // One executed decision whose asset still has a live position -> no close.
    insertSignal(db, 's-open', { asset: 'AAPL' })
    insertExecutedDecision(db, 'd-open', 's-open', { asset: 'AAPL', decidedAt: 1000 })

    getPositions.mockResolvedValue([
      { asset: 'AAPL', qty: 1, avg_entry_price: 100, market_value: 112, unrealized_pnl: 12, source: 'broker', updated_at: Date.now() },
    ])
    getOrders.mockResolvedValue([])
    ;(engine as any).getNavLatest = vi.fn().mockResolvedValue({ date: '2026-06-07', period: 'day_open', nav: 1010, recorded_at: Date.now() })

    const result = await runCloseOutSweep(db, engine)
    expect(result.processed).toBe(0)

    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' })
    const snap = db.prepare('SELECT * FROM trader_pnl_snapshots WHERE date = ?').get(today) as any
    expect(snap).toBeTruthy()
    expect(snap.open_unrealized_pnl).toBe(12)
    expect(snap.account_nav).toBe(1010)
  })

  it('carries forward the last known NAV when the engine is unreachable (never writes a zero-NAV row)', async () => {
    // Regression (Jun 9 2026): the engine outage day wrote nav 0 / account_nav
    // 0, collapsing the equity curve to zero and breaking cumulative PnL.
    getPositions.mockRejectedValue(new Error('engine down'))
    getOrders.mockRejectedValue(new Error('engine down'))
    ;(engine as any).getNavLatest = vi.fn().mockRejectedValue(new Error('engine down'))

    // Yesterday's snapshot holds the last known equity.
    db.prepare(`INSERT INTO trader_pnl_snapshots
      (date, nav_open, nav_close, pnl_day, trades_count, bench_return, cumulative_pnl, open_unrealized_pnl, account_nav)
      VALUES ('2020-01-01', 99970, 99950, 0, 0, 0, -50, 0, 99950)`).run()

    await runCloseOutSweep(db, engine)

    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' })
    const snap = db.prepare('SELECT * FROM trader_pnl_snapshots WHERE date = ?').get(today) as any
    expect(snap).toBeTruthy()
    expect(snap.account_nav).toBe(99950)   // carried forward, not 0
    expect(snap.nav_close).toBe(99950)     // carried forward, not 0
  })
})

// writeDailySnapshot TZ correctness -------------------------------------------

describe('writeDailySnapshot: verdict-sum uses NY day bounds, not OS localtime', () => {
  it('counts a verdict whose closed_at is after UTC midnight but still the same NY calendar day', async () => {
    // 2026-06-08 01:00 UTC = 2026-06-07 21:00 EDT (UTC-4).
    // A UTC-hosted SQLite 'localtime' modifier treats this as 2026-06-08,
    // so the bug drops the verdict from that day's sum. The fix uses
    // America/New_York ms bounds so it is always counted on 2026-06-07.
    const db = makeDb()

    // Insert the single signal+decision+verdict that must appear in the count.
    // closed_at = 2026-06-08T01:00:00Z (ms)
    const closedAtMs = Date.UTC(2026, 5, 8, 1, 0, 0) // June = month 5 (0-indexed)
    db.prepare(`
      INSERT INTO trader_signals (id, strategy_id, asset, side, raw_score, horizon_days, generated_at, status)
      VALUES ('s-tz', 'momentum-stocks', 'AAPL', 'buy', 0.5, 20, ?, 'closed')
    `).run(closedAtMs)
    db.prepare(`
      INSERT INTO trader_decisions (id, signal_id, action, asset, size_usd, entry_type, thesis, confidence, decided_at, status)
      VALUES ('d-tz', 's-tz', 'buy', 'AAPL', 100, 'limit', 't', 0.7, ?, 'closed')
    `).run(closedAtMs - 86_400_000)
    db.prepare(`
      INSERT INTO trader_verdicts
        (id, decision_id, pnl_gross, pnl_net, bench_return, hold_drawdown, thesis_grade, agent_attribution_json, closed_at, returns_backfilled)
      VALUES ('v-tz', 'd-tz', 7, 6, 0, 0, 'B', '[]', ?, 1)
    `).run(closedAtMs)

    // The snapshot writer uses toLocaleDateString('en-CA', {timeZone:'America/New_York'})
    // on `nowMs` to produce `todayNY`. With nowMs = closedAtMs the NY date is '2026-06-07'.
    // We inject nowMs via the exported helper so the test does not depend on real wall clock.
    const getNavLatest = vi.fn().mockResolvedValue(null)
    const getPositions = vi.fn().mockResolvedValue([])
    const getOrders = vi.fn().mockResolvedValue([])
    const getPrices = vi.fn().mockResolvedValue([])
    const engine = { getNavLatest, getPositions, getOrders, getPrices } as unknown as EngineClient

    // Run the sweep with the injected nowMs so todayNY is deterministic.
    await runCloseOutSweep(db, engine, { nowMs: closedAtMs })

    // The snapshot date must be the NY calendar day for closedAtMs.
    const expectedDate = new Date(closedAtMs).toLocaleDateString('en-CA', { timeZone: 'America/New_York' })
    const snap = db.prepare('SELECT * FROM trader_pnl_snapshots WHERE date = ?').get(expectedDate) as any
    expect(snap).toBeTruthy()
    // The verdict (pnl_net=6) must appear in the sum.
    expect(snap.pnl_day).toBe(6)
    expect(snap.trades_count).toBe(1)
  })
})

// Phase 4 Task B -- bench_return + hold_drawdown population -----------------

function pricePoint(ms: number, close: number): PricePoint {
  return { date: new Date(ms).toISOString().slice(0, 10), close, ts_ms: ms }
}

describe('per-decision lot attribution (Jun 11 2026 multi-count regression)', () => {
  let db: ReturnType<typeof makeDb>
  beforeEach(() => { db = makeDb() })

  it('three decisions on one aggregate close sum to the aggregate PnL, not 3x', () => {
    // Live failure: 30 QQQ decisions each got a verdict claiming the FULL
    // -19.07 aggregate-close PnL (one sweep wrote ~$-800 of phantom losses).
    for (const [i, qty] of [['1', 2], ['2', 3], ['3', 5]] as const) {
      insertSignal(db, `sig-${i}`, { asset: 'QQQ' })
      insertExecutedDecision(db, `dec-${i}`, `sig-${i}`, {
        asset: 'QQQ', decidedAt: 1000, filledQty: qty as number, filledAvgPrice: 100,
      })
    }
    const orders: EngineOrder[] = [
      fillOrder({ asset: 'QQQ', side: 'buy',  filled_qty: 10, filled_avg_price: 100, created_at: 1100, updated_at: 1100 }),
      fillOrder({ asset: 'QQQ', side: 'sell', filled_qty: 10, filled_avg_price: 90,  created_at: 5000, updated_at: 5000 }),
    ]
    for (const id of ['dec-1', 'dec-2', 'dec-3']) {
      const row = findOpenDecisions(db).find(d => d.id === id)!
      const r = processClosure(db, row, [], orders)
      expect(r.reason).toBe('closed')
    }
    const total = db.prepare('SELECT ROUND(SUM(pnl_gross),2) AS t FROM trader_verdicts').get() as { t: number }
    // Aggregate close lost (90-100)*10 = -100; per-lot: -20, -30, -50.
    expect(total.t).toBe(-100)
  })

  it('a decision without cached fill data closes WITHOUT a verdict', () => {
    insertSignal(db, 'sig-legacy', { asset: 'QQQ' })
    insertExecutedDecision(db, 'dec-legacy', 'sig-legacy', {
      asset: 'QQQ', decidedAt: 1000, filledQty: null, filledAvgPrice: null,
    })
    const orders: EngineOrder[] = [
      fillOrder({ asset: 'QQQ', side: 'buy',  filled_qty: 10, filled_avg_price: 100, created_at: 1100, updated_at: 1100 }),
      fillOrder({ asset: 'QQQ', side: 'sell', filled_qty: 10, filled_avg_price: 90,  created_at: 5000, updated_at: 5000 }),
    ]
    const row = findOpenDecisions(db).find(d => d.id === 'dec-legacy')!
    const r = processClosure(db, row, [], orders)
    expect(r.reason).toBe('closed-no-fill-data')
    const v = db.prepare('SELECT COUNT(*) AS n FROM trader_verdicts').get() as { n: number }
    expect(v.n).toBe(0)
  })
})

describe('processClosure with priceFetchResult (Phase 4 Task B)', () => {
  let db: ReturnType<typeof makeDb>
  beforeEach(() => { db = makeDb() })

  function getOpen(decisionId: string): OpenDecisionRow {
    return findOpenDecisions(db).find(d => d.id === decisionId)!
  }

  it('populates bench_return + hold_drawdown when price fetch succeeded', () => {
    insertSignal(db, 'sig-1', { asset: 'AAPL', strategy: 'momentum-stocks' })
    insertExecutedDecision(db, 'dec-1', 'sig-1', { asset: 'AAPL', decidedAt: 1000 })

    const orders: EngineOrder[] = [
      fillOrder({ side: 'buy',  filled_qty: 10, filled_avg_price: 100, created_at: 1100, updated_at: 1100 }),
      fillOrder({ side: 'sell', filled_qty: 10, filled_avg_price: 110, created_at: 5000, updated_at: 5000 }),
    ]
    const priceFetch: PriceFetchResult = {
      success: true,
      benchReturn: 0.03,
      holdDrawdown: -0.08,
    }
    const result = processClosure(db, getOpen('dec-1'), [], orders, priceFetch)
    expect(result.reason).toBe('closed')

    const verdict = db.prepare('SELECT * FROM trader_verdicts WHERE decision_id = ?').get('dec-1') as any
    expect(verdict.bench_return).toBeCloseTo(0.03, 10)
    expect(verdict.hold_drawdown).toBeCloseTo(-0.08, 10)
    expect(verdict.returns_backfilled).toBe(1)
  })

  it('regrades thesis_grade when real bench_return changes the winner status', () => {
    // pnl = 10%, bench = 12% -> trade was positive but failed to beat
    // bench. With bench=0 placeholder this would grade 'A' (strong +
    // beat zero). With real bench=12% it must grade 'C' (positive but
    // did not beat bench). Regrade must close that gap.
    insertSignal(db, 'sig-rg', { asset: 'AAPL', strategy: 'momentum-stocks' })
    insertExecutedDecision(db, 'dec-rg', 'sig-rg', { asset: 'AAPL', decidedAt: 1000 })

    const orders: EngineOrder[] = [
      fillOrder({ side: 'buy',  filled_qty: 10, filled_avg_price: 100, created_at: 1100, updated_at: 1100 }),
      fillOrder({ side: 'sell', filled_qty: 10, filled_avg_price: 110, created_at: 5000, updated_at: 5000 }),
    ]
    const priceFetch: PriceFetchResult = {
      success: true,
      benchReturn: 0.12,   // bench beat us
      holdDrawdown: -0.01,
    }
    const result = processClosure(db, getOpen('dec-rg'), [], orders, priceFetch)
    expect(result.reason).toBe('closed')

    const verdict = db.prepare('SELECT * FROM trader_verdicts WHERE decision_id = ?').get('dec-rg') as any
    expect(verdict.bench_return).toBeCloseTo(0.12, 10)
    expect(verdict.thesis_grade).toBe('C')
    // ClosureResult.outcome must reflect the regraded value so callers
    // (tests, dashboard) do not see a stale outcome.
    expect(result.outcome?.thesisGrade).toBe('C')
  })

  it('preserves thesis_grade when price fetch failed (no regrade on placeholders)', () => {
    // With a failed fetch we keep bench=0 / dd=0 placeholders. The
    // grade computed inside computeVerdict (with bench=0) stays.
    insertSignal(db, 'sig-pg', { asset: 'AAPL', strategy: 'momentum-stocks' })
    insertExecutedDecision(db, 'dec-pg', 'sig-pg', { asset: 'AAPL', decidedAt: 1000 })

    const orders: EngineOrder[] = [
      fillOrder({ side: 'buy',  filled_qty: 10, filled_avg_price: 100, created_at: 1100, updated_at: 1100 }),
      fillOrder({ side: 'sell', filled_qty: 10, filled_avg_price: 110, created_at: 5000, updated_at: 5000 }),
    ]
    const priceFetch: PriceFetchResult = {
      success: false,
      benchReturn: 0,
      holdDrawdown: 0,
    }
    const result = processClosure(db, getOpen('dec-pg'), [], orders, priceFetch)
    const verdict = db.prepare('SELECT * FROM trader_verdicts WHERE decision_id = ?').get('dec-pg') as any
    expect(verdict.bench_return).toBe(0)
    expect(verdict.thesis_grade).toBe('A')  // 10% pnl vs 0% bench -> strong + beat
    expect(result.outcome?.thesisGrade).toBe('A')
  })

  it('keeps placeholders + returns_backfilled=0 when price fetch failed', () => {
    insertSignal(db, 'sig-2', { asset: 'AAPL', strategy: 'momentum-stocks' })
    insertExecutedDecision(db, 'dec-2', 'sig-2', { asset: 'AAPL', decidedAt: 1000, filledQty: 5, filledAvgPrice: 100 })

    const orders: EngineOrder[] = [
      fillOrder({ side: 'buy',  filled_qty: 5, filled_avg_price: 100, created_at: 1100, updated_at: 1100 }),
      fillOrder({ side: 'sell', filled_qty: 5, filled_avg_price: 105, created_at: 5000, updated_at: 5000 }),
    ]
    const priceFetch: PriceFetchResult = {
      success: false,
      benchReturn: 0,
      holdDrawdown: 0,
    }
    const result = processClosure(db, getOpen('dec-2'), [], orders, priceFetch)
    expect(result.reason).toBe('closed')

    const verdict = db.prepare('SELECT * FROM trader_verdicts WHERE decision_id = ?').get('dec-2') as any
    expect(verdict.bench_return).toBe(0)
    expect(verdict.hold_drawdown).toBe(0)
    expect(verdict.returns_backfilled).toBe(0)
  })

  it('defaults to returns_backfilled=0 when no price fetch result is supplied (legacy caller)', () => {
    insertSignal(db, 'sig-3', { asset: 'AAPL' })
    insertExecutedDecision(db, 'dec-3', 'sig-3', { asset: 'AAPL', decidedAt: 1000, filledQty: 1, filledAvgPrice: 100 })

    const orders: EngineOrder[] = [
      fillOrder({ side: 'buy',  filled_qty: 1, filled_avg_price: 100, created_at: 1100, updated_at: 1100 }),
      fillOrder({ side: 'sell', filled_qty: 1, filled_avg_price: 110, created_at: 5000, updated_at: 5000 }),
    ]
    processClosure(db, getOpen('dec-3'), [], orders)

    const verdict = db.prepare('SELECT * FROM trader_verdicts WHERE decision_id = ?').get('dec-3') as any
    expect(verdict.returns_backfilled).toBe(0)
  })
})

describe('fetchReturnsForDecision (Phase 4 Task B)', () => {
  it('returns success=false when closedAt <= decidedAt (guard)', async () => {
    const getPrices = vi.fn()
    const engine = { getPrices } as unknown as EngineClient
    const r = await fetchReturnsForDecision(engine, {
      asset: 'AAPL', assetClass: 'stocks', decidedAtMs: 1000, closedAtMs: 1000,
    })
    expect(r.success).toBe(false)
    expect(getPrices).not.toHaveBeenCalled()
  })

  it('returns success=false + zeros when engine getPrices throws', async () => {
    const engine = {
      getPrices: vi.fn().mockRejectedValue(new Error('network down')),
    } as unknown as EngineClient
    const r = await fetchReturnsForDecision(engine, {
      asset: 'AAPL', assetClass: 'stocks', decidedAtMs: 1000, closedAtMs: 2000,
    })
    expect(r).toEqual({ success: false, benchReturn: 0, holdDrawdown: 0 })
  })

  it('returns success=false when either series has < 2 bars', async () => {
    const engine = {
      getPrices: vi.fn()
        .mockResolvedValueOnce([pricePoint(1, 100)])  // asset: 1 bar
        .mockResolvedValueOnce([pricePoint(1, 500), pricePoint(2, 510)]), // bench: OK
    } as unknown as EngineClient
    const r = await fetchReturnsForDecision(engine, {
      asset: 'AAPL', assetClass: 'stocks', decidedAtMs: 1000, closedAtMs: 2000,
    })
    expect(r.success).toBe(false)
  })

  it('computes bench_return + hold_drawdown when both series are sufficient', async () => {
    const engine = {
      getPrices: vi.fn()
        // Asset goes 100 -> 115 with a dip to 85 in the middle
        .mockResolvedValueOnce([
          pricePoint(1000, 100),
          pricePoint(1500, 85),
          pricePoint(2000, 115),
        ])
        // Bench (SPY) goes 400 -> 412 (+3%)
        .mockResolvedValueOnce([
          pricePoint(1000, 400),
          pricePoint(2000, 412),
        ]),
    } as unknown as EngineClient
    const r = await fetchReturnsForDecision(engine, {
      asset: 'AAPL', assetClass: 'stocks', decidedAtMs: 1000, closedAtMs: 2000,
    })
    expect(r.success).toBe(true)
    expect(r.benchReturn).toBeCloseTo(0.03, 10)
    // drawdown = (85 - 100) / 100 = -0.15
    expect(r.holdDrawdown).toBeCloseTo(-0.15, 10)
  })

  it('picks BTC/USD benchmark for crypto asset_class', async () => {
    const getPrices = vi.fn()
      .mockResolvedValue([pricePoint(1, 1), pricePoint(2, 1)])
    const engine = { getPrices } as unknown as EngineClient
    await fetchReturnsForDecision(engine, {
      asset: 'ETH/USD', assetClass: 'crypto', decidedAtMs: 1000, closedAtMs: 2000,
    })
    const callSymbols = getPrices.mock.calls.map(c => c[0])
    expect(callSymbols).toContain('ETH/USD')
    expect(callSymbols).toContain('BTC/USD')
  })
})

describe('runCloseOutSweep populates bench_return + hold_drawdown (Phase 4 Task B)', () => {
  let db: ReturnType<typeof makeDb>

  beforeEach(() => {
    db = makeDb()
  })

  it('calls getPrices for closed decisions and writes returns_backfilled=1', async () => {
    insertSignal(db, 'sig-1', { asset: 'AAPL', strategy: 'momentum-stocks' })
    insertExecutedDecision(db, 'dec-1', 'sig-1', { asset: 'AAPL', decidedAt: 1000 })

    const engine = {
      getPositions: vi.fn().mockResolvedValue([]),  // asset closed
      getOrders: vi.fn().mockResolvedValue([
        fillOrder({ asset: 'AAPL', side: 'buy',  filled_qty: 10, filled_avg_price: 100, created_at: 1100, updated_at: 1100 }),
        fillOrder({ asset: 'AAPL', side: 'sell', filled_qty: 10, filled_avg_price: 110, created_at: 5000, updated_at: 5000 }),
      ]),
      getPrices: vi.fn()
        .mockResolvedValueOnce([pricePoint(1000, 100), pricePoint(3000, 90), pricePoint(5000, 110)])  // asset
        .mockResolvedValueOnce([pricePoint(1000, 400), pricePoint(5000, 420)]),                        // bench SPY
    } as unknown as EngineClient

    const result = await runCloseOutSweep(db, engine)
    expect(result.processed).toBe(1)

    const verdict = db.prepare('SELECT * FROM trader_verdicts WHERE decision_id = ?').get('dec-1') as any
    expect(verdict.returns_backfilled).toBe(1)
    expect(verdict.bench_return).toBeCloseTo(0.05, 10)      // 400 -> 420 = 5%
    expect(verdict.hold_drawdown).toBeCloseTo(-0.1, 10)     // 100 -> 90 = -10%

    expect(engine.getPrices).toHaveBeenCalledTimes(2)  // asset + bench
  })

  it('skips getPrices entirely when no decision is closing', async () => {
    insertSignal(db, 'sig-still', { asset: 'AAPL' })
    insertExecutedDecision(db, 'dec-still', 'sig-still', { asset: 'AAPL', decidedAt: 1000 })

    const engine = {
      // Asset still open -> no prices fetch.
      getPositions: vi.fn().mockResolvedValue([
        { asset: 'AAPL', qty: 10, avg_entry_price: 100, market_value: 1000, unrealized_pnl: 0, source: 'paper', updated_at: Date.now() },
      ]),
      getOrders: vi.fn().mockResolvedValue([]),
      getPrices: vi.fn(),
    } as unknown as EngineClient

    const result = await runCloseOutSweep(db, engine)
    expect(result.stillOpen).toBe(1)
    expect(engine.getPrices).not.toHaveBeenCalled()
  })

  it('gracefully writes placeholders + returns_backfilled=0 when getPrices fails', async () => {
    insertSignal(db, 'sig-fail', { asset: 'AAPL', strategy: 'momentum-stocks' })
    insertExecutedDecision(db, 'dec-fail', 'sig-fail', { asset: 'AAPL', decidedAt: 1000, filledQty: 1, filledAvgPrice: 100 })

    const engine = {
      getPositions: vi.fn().mockResolvedValue([]),
      getOrders: vi.fn().mockResolvedValue([
        fillOrder({ asset: 'AAPL', side: 'buy',  filled_qty: 1, filled_avg_price: 100, created_at: 1100, updated_at: 1100 }),
        fillOrder({ asset: 'AAPL', side: 'sell', filled_qty: 1, filled_avg_price: 105, created_at: 5000, updated_at: 5000 }),
      ]),
      getPrices: vi.fn().mockRejectedValue(new Error('engine /prices 503')),
    } as unknown as EngineClient

    const result = await runCloseOutSweep(db, engine)
    expect(result.processed).toBe(1)  // verdict still written

    const verdict = db.prepare('SELECT * FROM trader_verdicts WHERE decision_id = ?').get('dec-fail') as any
    expect(verdict).toBeDefined()
    expect(verdict.returns_backfilled).toBe(0)
    expect(verdict.bench_return).toBe(0)
    expect(verdict.hold_drawdown).toBe(0)
  })

  it('grades a reconciler-promoted executed decision once the engine reports fills', async () => {
    const db = makeDb()
    db.prepare(`INSERT INTO trader_signals (id, strategy_id, asset, side, raw_score, horizon_days, generated_at, status)
      VALUES ('s-rec','momentum-stocks','AAPL','buy',0.7,20,?, 'submitted')`).run(1000)
    db.prepare(`INSERT INTO trader_decisions
      (id, signal_id, action, asset, size_usd, entry_type, thesis, confidence, decided_at, status, filled_qty, filled_avg_price)
      VALUES ('d-rec','s-rec','buy','AAPL',150,'market','t',0.8,1000,'executed',10,100)`).run()
    const client = {
      getPositions: vi.fn().mockResolvedValue([]), // closed
      getOrders: vi.fn().mockResolvedValue([
        fillOrder({ asset: 'AAPL', side: 'buy',  filled_qty: 10, filled_avg_price: 100, created_at: 1100, updated_at: 1100 }),
        fillOrder({ asset: 'AAPL', side: 'sell', filled_qty: 10, filled_avg_price: 110, created_at: 5000, updated_at: 5000 }),
      ]),
      getPrices: vi.fn().mockResolvedValue([]),
    }
    const sweep = await runCloseOutSweep(db, client as unknown as EngineClient)
    expect(sweep.processed).toBe(1)
    const verdict = db.prepare("SELECT pnl_gross FROM trader_verdicts WHERE decision_id='d-rec'").get() as any
    expect(verdict).toBeTruthy()
    expect(verdict.pnl_gross).toBeGreaterThan(0)
  })
})

// I1: processClosure must call recomputeRealizedPnl so trader_realized_pnl populates.
describe('I1: processClosure populates trader_realized_pnl via recomputeRealizedPnl', () => {
  let db: ReturnType<typeof makeDb>
  beforeEach(() => { db = makeDb() })

  it('writes a trader_realized_pnl row after a verdict is committed for a fully-closed decision', () => {
    insertSignal(db, 'sig-pnl')
    insertExecutedDecision(db, 'dec-pnl', 'sig-pnl', { decidedAt: 1000 })

    // Seed a trader_fills row directly (as the order-reconciler would have written).
    recordFill(db, {
      decisionId: 'dec-pnl', clientOrderId: 'dec-pnl', asset: 'AAPL',
      side: 'buy', fillQty: 10, fillPrice: 100, fillTsMs: 1100,
    }, 1100, 'fill-buy-pnl')
    recordFill(db, {
      decisionId: 'dec-pnl', clientOrderId: 'dec-pnl', asset: 'AAPL',
      side: 'sell', fillQty: 10, fillPrice: 115, fillTsMs: 5000,
    }, 5000, 'fill-sell-pnl')

    const orders: EngineOrder[] = [
      fillOrder({ asset: 'AAPL', side: 'buy',  filled_qty: 10, filled_avg_price: 100, created_at: 1100, updated_at: 1100 }),
      fillOrder({ asset: 'AAPL', side: 'sell', filled_qty: 10, filled_avg_price: 115, created_at: 5000, updated_at: 5000 }),
    ]
    const result = processClosure(db, findOpenDecisions(db).find(d => d.id === 'dec-pnl')!, [], orders)
    expect(result.reason).toBe('closed')

    const rows = db.prepare(
      "SELECT pnl_gross, pnl_net, lot_match_rule FROM trader_realized_pnl WHERE decision_id = 'dec-pnl'",
    ).all() as Array<{ pnl_gross: number; pnl_net: number; lot_match_rule: string }>
    expect(rows).toHaveLength(1)
    expect(rows[0].pnl_gross).toBeCloseTo(150, 10)   // (115-100)*10
    expect(rows[0].lot_match_rule).toBe('FIFO')
  })
})
