/**
 * scripts/backfill-verdict-returns.test.ts -- Phase 4 Task B.
 *
 * Verifies the one-shot migration script:
 *  - picks up only `returns_backfilled=0` rows
 *  - skips rows where the engine returns no prices (and leaves flag 0)
 *  - updates and flips flag to 1 on success
 *  - is idempotent: a second run is a no-op
 *  - --dry-run reports "would update" without touching the DB
 *  - is resilient: one failing row does not stop the rest
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import Database from 'better-sqlite3'

import { initTraderTables } from '../src/trader/db.js'
import { seedAllStrategies } from '../src/trader/strategy-manager.js'
import { listPendingVerdicts, runBackfill } from './backfill-verdict-returns.js'
import type { EngineClient } from '../src/trader/engine-client.js'
import type { PricePoint } from '../src/trader/types.js'

function makeDb() {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = OFF')
  initTraderTables(db)
  seedAllStrategies(db)
  return db
}

function insertVerdict(
  db: Database.Database,
  opts: {
    verdictId: string
    decisionId: string
    signalId: string
    asset: string
    decidedAt: number
    closedAt: number
    strategyId?: string
    returnsBackfilled?: 0 | 1
    benchReturn?: number
    holdDrawdown?: number
  },
) {
  const strategyId = opts.strategyId ?? 'momentum-stocks'
  db.prepare(`
    INSERT INTO trader_signals (id, strategy_id, asset, side, raw_score, horizon_days, generated_at, status)
    VALUES (?, ?, ?, 'buy', 0.7, 20, ?, 'closed')
  `).run(opts.signalId, strategyId, opts.asset, opts.decidedAt)

  db.prepare(`
    INSERT INTO trader_decisions
      (id, signal_id, action, asset, size_usd, entry_type, thesis, confidence,
       committee_transcript_id, decided_at, status)
    VALUES (?, ?, 'buy', ?, 100, 'limit', 'thesis', 0.7, NULL, ?, 'closed')
  `).run(opts.decisionId, opts.signalId, opts.asset, opts.decidedAt)

  db.prepare(`
    INSERT INTO trader_verdicts
      (id, decision_id, pnl_gross, pnl_net, bench_return, hold_drawdown,
       thesis_grade, agent_attribution_json, embedding_id, closed_at,
       returns_backfilled)
    VALUES (?, ?, 50, 50, ?, ?, 'B', '[]', NULL, ?, ?)
  `).run(
    opts.verdictId,
    opts.decisionId,
    opts.benchReturn ?? 0,
    opts.holdDrawdown ?? 0,
    opts.closedAt,
    opts.returnsBackfilled ?? 0,
  )
}

function pricePoint(ms: number, close: number): PricePoint {
  return { date: new Date(ms).toISOString().slice(0, 10), close, ts_ms: ms }
}

describe('listPendingVerdicts', () => {
  let db: ReturnType<typeof makeDb>
  beforeEach(() => { db = makeDb() })

  it('returns only verdicts with returns_backfilled=0', () => {
    insertVerdict(db, {
      verdictId: 'v-pending', decisionId: 'd-pending', signalId: 's-pending',
      asset: 'AAPL', decidedAt: 1000, closedAt: 2000, returnsBackfilled: 0,
    })
    insertVerdict(db, {
      verdictId: 'v-done', decisionId: 'd-done', signalId: 's-done',
      asset: 'NVDA', decidedAt: 1000, closedAt: 2000, returnsBackfilled: 1,
    })
    const pending = listPendingVerdicts(db)
    expect(pending.map(p => p.verdict_id)).toEqual(['v-pending'])
  })

  it('joins in asset_class via strategy', () => {
    insertVerdict(db, {
      verdictId: 'v1', decisionId: 'd1', signalId: 's1',
      asset: 'BTC/USD', decidedAt: 1000, closedAt: 2000,
      strategyId: 'momentum-crypto',
    })
    const pending = listPendingVerdicts(db)
    expect(pending[0].asset_class).toBe('crypto')
  })

  it('orders by closed_at ascending', () => {
    insertVerdict(db, {
      verdictId: 'v-new', decisionId: 'd-new', signalId: 's-new',
      asset: 'AAPL', decidedAt: 1000, closedAt: 5000,
    })
    insertVerdict(db, {
      verdictId: 'v-old', decisionId: 'd-old', signalId: 's-old',
      asset: 'AAPL', decidedAt: 1000, closedAt: 2000,
    })
    const pending = listPendingVerdicts(db)
    expect(pending.map(p => p.verdict_id)).toEqual(['v-old', 'v-new'])
  })
})

describe('runBackfill', () => {
  let db: ReturnType<typeof makeDb>
  beforeEach(() => { db = makeDb() })

  function makeEngine(prices: Record<string, PricePoint[]>): EngineClient {
    return {
      getPrices: vi.fn(async (asset: string) => prices[asset] ?? []),
    } as unknown as EngineClient
  }

  it('returns zeros when no verdicts need backfill', async () => {
    const engine = makeEngine({})
    const summary = await runBackfill(db, engine)
    expect(summary).toEqual({ total: 0, updated: 0, skipped: 0, errors: 0 })
    expect(engine.getPrices).not.toHaveBeenCalled()
  })

  it('updates verdict fields + flips flag to 1 on success', async () => {
    insertVerdict(db, {
      verdictId: 'v1', decisionId: 'd1', signalId: 's1',
      asset: 'AAPL', decidedAt: 1000, closedAt: 2000,
    })
    const engine = makeEngine({
      'AAPL': [
        pricePoint(1000, 100),
        pricePoint(1500, 80),
        pricePoint(2000, 120),
      ],
      'SPY': [
        pricePoint(1000, 400),
        pricePoint(2000, 412),
      ],
    })
    const summary = await runBackfill(db, engine)
    expect(summary).toEqual({ total: 1, updated: 1, skipped: 0, errors: 0 })

    const row = db.prepare('SELECT * FROM trader_verdicts WHERE id=?').get('v1') as any
    expect(row.returns_backfilled).toBe(1)
    expect(row.bench_return).toBeCloseTo(0.03, 10)
    expect(row.hold_drawdown).toBeCloseTo(-0.2, 10)
  })

  it('regrades thesis_grade using real bench_return (beats-bench flip)', async () => {
    // Fixture: pnl_gross=50 on size_usd=100 -> pnl_pct = 0.5 (50%).
    // Initial stored grade is 'B' (fixture default, see insertVerdict).
    // When bench_return comes back < pnl_pct, grade should be 'A'
    // (strong + beat). When bench_return > pnl_pct, grade should be
    // 'C' (positive but did not beat). This test pins the beat-bench
    // flip so future changes cannot silently drop the regrade.
    insertVerdict(db, {
      verdictId: 'v-a', decisionId: 'd-a', signalId: 's-a',
      asset: 'AAPL', decidedAt: 1000, closedAt: 2000,
    })
    insertVerdict(db, {
      verdictId: 'v-c', decisionId: 'd-c', signalId: 's-c',
      asset: 'AAPL', decidedAt: 1000, closedAt: 2000,
    })
    // 'v-a': bench = 3%, pnl = 50% -> strong + beat = 'A'
    // 'v-c': run this after 'v-a' completes (second runBackfill pass)
    const engine = makeEngine({
      'AAPL': [pricePoint(1000, 100), pricePoint(2000, 150)],
      'SPY':  [pricePoint(1000, 400), pricePoint(2000, 412)],
    })
    const first = await runBackfill(db, engine)
    expect(first.updated).toBe(2)

    const rowA = db.prepare('SELECT thesis_grade, bench_return FROM trader_verdicts WHERE id=?').get('v-a') as any
    expect(rowA.thesis_grade).toBe('A')
    expect(rowA.bench_return).toBeCloseTo(0.03, 10)
  })

  it('regrades to C when bench beats pnl (downgrade flip)', async () => {
    // Fixture pnl_pct = 0.5 (50%). Bench_return = 60% -> positive
    // but did not beat bench -> grade 'C'.
    insertVerdict(db, {
      verdictId: 'v-c', decisionId: 'd-c', signalId: 's-c',
      asset: 'AAPL', decidedAt: 1000, closedAt: 2000,
    })
    const engine = makeEngine({
      'AAPL': [pricePoint(1000, 100), pricePoint(2000, 150)],
      'SPY':  [pricePoint(1000, 400), pricePoint(2000, 640)],  // +60%
    })
    const summary = await runBackfill(db, engine)
    expect(summary.updated).toBe(1)

    const row = db.prepare('SELECT thesis_grade, bench_return FROM trader_verdicts WHERE id=?').get('v-c') as any
    expect(row.thesis_grade).toBe('C')
    expect(row.bench_return).toBeCloseTo(0.6, 10)
  })

  it('is idempotent: a second run does not touch already-backfilled rows', async () => {
    insertVerdict(db, {
      verdictId: 'v1', decisionId: 'd1', signalId: 's1',
      asset: 'AAPL', decidedAt: 1000, closedAt: 2000,
    })
    const engine = makeEngine({
      'AAPL': [pricePoint(1000, 100), pricePoint(2000, 105)],
      'SPY':  [pricePoint(1000, 400), pricePoint(2000, 402)],
    })
    const first = await runBackfill(db, engine)
    expect(first.updated).toBe(1)

    // Second run must be a no-op -- no engine calls, no DB mutation.
    ;(engine.getPrices as ReturnType<typeof vi.fn>).mockClear()
    const second = await runBackfill(db, engine)
    expect(second).toEqual({ total: 0, updated: 0, skipped: 0, errors: 0 })
    expect(engine.getPrices).not.toHaveBeenCalled()
  })

  it('skips rows where engine returns no prices and leaves flag=0', async () => {
    insertVerdict(db, {
      verdictId: 'v-empty', decisionId: 'd-empty', signalId: 's-empty',
      asset: 'AAPL', decidedAt: 1000, closedAt: 2000,
    })
    const engine = makeEngine({})  // every getPrices returns []
    const summary = await runBackfill(db, engine)
    expect(summary.skipped).toBe(1)
    expect(summary.updated).toBe(0)

    const row = db.prepare('SELECT returns_backfilled FROM trader_verdicts WHERE id=?').get('v-empty') as any
    expect(row.returns_backfilled).toBe(0)
  })

  it('isolates a failing row from the rest of the sweep (engine exception)', async () => {
    insertVerdict(db, {
      verdictId: 'v-err', decisionId: 'd-err', signalId: 's-err',
      asset: 'AAPL', decidedAt: 1000, closedAt: 2000,
    })
    insertVerdict(db, {
      verdictId: 'v-ok', decisionId: 'd-ok', signalId: 's-ok',
      asset: 'NVDA', decidedAt: 1000, closedAt: 2000,
    })

    // AAPL throws, NVDA succeeds. The isolation proves one bad row
    // does not poison the rest of the sweep.
    //
    // fetchReturnsForDecision catches the thrown error internally and
    // returns success=false, so the row is counted as "skipped" rather
    // than "error". That keeps the next run picking it up without the
    // operator having to re-run anything -- skipped and error are both
    // leave-flag-at-0 outcomes from the DB's perspective.
    const getPrices = vi.fn(async (asset: string) => {
      if (asset === 'AAPL') throw new Error('500 Internal Server Error')
      if (asset === 'NVDA') return [pricePoint(1000, 100), pricePoint(2000, 110)]
      if (asset === 'SPY')  return [pricePoint(1000, 400), pricePoint(2000, 404)]
      return []
    })
    const engine = { getPrices } as unknown as EngineClient

    const summary = await runBackfill(db, engine)
    expect(summary.total).toBe(2)
    expect(summary.updated).toBe(1)
    // AAPL failed + was swallowed -> skipped (not error).
    expect(summary.skipped).toBe(1)

    const errRow = db.prepare('SELECT returns_backfilled FROM trader_verdicts WHERE id=?').get('v-err') as any
    expect(errRow.returns_backfilled).toBe(0)

    const okRow = db.prepare('SELECT returns_backfilled FROM trader_verdicts WHERE id=?').get('v-ok') as any
    expect(okRow.returns_backfilled).toBe(1)
  })

  it('counts DB-layer exceptions as errors and leaves flag=0', async () => {
    insertVerdict(db, {
      verdictId: 'v-dbfail', decisionId: 'd-dbfail', signalId: 's-dbfail',
      asset: 'AAPL', decidedAt: 1000, closedAt: 2000,
    })
    const engine = makeEngine({
      'AAPL': [pricePoint(1000, 100), pricePoint(2000, 110)],
      'SPY':  [pricePoint(1000, 400), pricePoint(2000, 404)],
    })
    // Break the UPDATE by closing the db partway through.
    const origPrepare = db.prepare.bind(db)
    let calls = 0
    db.prepare = ((sql: string) => {
      const stmt = origPrepare(sql)
      if (/UPDATE trader_verdicts/i.test(sql)) {
        calls += 1
        return {
          run: () => { throw new Error('simulated db layer failure') },
        } as unknown as ReturnType<typeof origPrepare>
      }
      return stmt
    }) as typeof db.prepare

    const summary = await runBackfill(db, engine)
    expect(summary.errors).toBe(1)
    expect(summary.updated).toBe(0)
    expect(calls).toBeGreaterThan(0)
  })

  it('--dry-run reports would-update without writing', async () => {
    insertVerdict(db, {
      verdictId: 'v-dry', decisionId: 'd-dry', signalId: 's-dry',
      asset: 'AAPL', decidedAt: 1000, closedAt: 2000,
    })
    const engine = makeEngine({
      'AAPL': [pricePoint(1000, 100), pricePoint(2000, 110)],
      'SPY':  [pricePoint(1000, 400), pricePoint(2000, 412)],
    })
    const summary = await runBackfill(db, engine, { dryRun: true })
    expect(summary.updated).toBe(1)

    // Flag must still be 0 after a dry-run.
    const row = db.prepare('SELECT returns_backfilled, bench_return FROM trader_verdicts WHERE id=?').get('v-dry') as any
    expect(row.returns_backfilled).toBe(0)
    expect(row.bench_return).toBe(0)  // untouched placeholder
  })

  it('crypto strategy routes to BTC/USD benchmark', async () => {
    insertVerdict(db, {
      verdictId: 'v-crypto', decisionId: 'd-crypto', signalId: 's-crypto',
      asset: 'BTC/USD', decidedAt: 1000, closedAt: 2000,
      strategyId: 'momentum-crypto',
    })
    const getPrices = vi.fn(async () => [
      pricePoint(1000, 100), pricePoint(2000, 110),
    ])
    const engine = { getPrices } as unknown as EngineClient

    await runBackfill(db, engine)
    const callSymbols = getPrices.mock.calls.map(c => c[0])
    // One call for the asset itself (BTC/USD) and one for the benchmark
    // (also BTC/USD when the asset IS the benchmark -- both calls
    // happen, that is fine).
    expect(callSymbols.filter(s => s === 'BTC/USD').length).toBeGreaterThan(0)
    // The important assertion: no SPY call for a crypto trade.
    expect(callSymbols).not.toContain('SPY')
  })
})
