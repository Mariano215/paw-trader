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
  overrides: Partial<{ asset: string; action: string; transcriptId: string | null; decidedAt: number; thesis: string }> = {},
) {
  db.prepare(`
    INSERT INTO trader_decisions
      (id, signal_id, action, asset, size_usd, entry_type, thesis, confidence,
       committee_transcript_id, decided_at, status)
    VALUES (?, ?, ?, ?, 100, 'limit', ?, 0.7, ?, ?, 'executed')
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
    insertExecutedDecision(db, 'dec-1', 'sig-1', { transcriptId: 'tr-1' })

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
    insertExecutedDecision(db, 'dec-1', 'sig-1', { transcriptId: null })

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
    insertExecutedDecision(db, 'dec-orphan', 'sig-x', { transcriptId: 'tr-1' })
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
    engine = { getPositions, getOrders, getPrices } as unknown as EngineClient
  })

  it('returns zeros when no decisions are open', async () => {
    const result = await runCloseOutSweep(db, engine)
    expect(result).toEqual({ processed: 0, stillOpen: 0, errors: 0 })
    expect(getPositions).not.toHaveBeenCalled()
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
    insertExecutedDecision(db, 'dec-nvda', 'sig-nvda', { asset: 'NVDA', decidedAt: 1000, transcriptId: 'tr-nvda' })

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
    insertExecutedDecision(db, 'dec-good', 'sig-good', { asset: 'AAPL', decidedAt: 1000 })
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

  it('makes exactly one engine round-trip regardless of decision count', async () => {
    for (let i = 0; i < 5; i++) {
      insertSignal(db, `sig-${i}`, { asset: `A${i}` })
      insertExecutedDecision(db, `dec-${i}`, `sig-${i}`, { asset: `A${i}`, decidedAt: 1000 })
    }
    await runCloseOutSweep(db, engine)
    expect(getPositions).toHaveBeenCalledTimes(1)
    expect(getOrders).toHaveBeenCalledTimes(1)
  })
})

// Phase 4 Task B -- bench_return + hold_drawdown population -----------------

function pricePoint(ms: number, close: number): PricePoint {
  return { date: new Date(ms).toISOString().slice(0, 10), close, ts_ms: ms }
}

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
    insertExecutedDecision(db, 'dec-2', 'sig-2', { asset: 'AAPL', decidedAt: 1000 })

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
    insertExecutedDecision(db, 'dec-3', 'sig-3', { asset: 'AAPL', decidedAt: 1000 })

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
    insertExecutedDecision(db, 'dec-fail', 'sig-fail', { asset: 'AAPL', decidedAt: 1000 })

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
})
