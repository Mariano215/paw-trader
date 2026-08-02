/**
 * track-record.test.ts -- Phase 3 Task 2
 *
 * Verifies the per-strategy verdict rollup used by the dashboard +
 * the autonomy ladder (Task 5).
 */
import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'

import { initTraderTables } from './db.js'
import { seedAllStrategies } from './strategy-manager.js'
import {
  computeTrackRecord,
  recomputeTrackRecord,
  recomputeAllTrackRecords,
  listTrackRecords,
  isAssetHeld,
} from './track-record.js'

function makeDb() {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = OFF')
  initTraderTables(db)
  seedAllStrategies(db)
  return db
}

function insertSignal(db: Database.Database, id: string, strategy = 'momentum-stocks') {
  db.prepare(`
    INSERT INTO trader_signals (id, strategy_id, asset, side, raw_score, horizon_days, generated_at, status)
    VALUES (?, ?, 'AAPL', 'buy', 0.7, 20, ?, 'decided')
  `).run(id, strategy, Date.now())
}

function insertDecision(db: Database.Database, id: string, signalId: string, sizeUsd: number) {
  db.prepare(`
    INSERT INTO trader_decisions
      (id, signal_id, action, asset, size_usd, entry_type, thesis, confidence,
       committee_transcript_id, decided_at, status)
    VALUES (?, ?, 'buy', 'AAPL', ?, 'limit', 't', 0.7, NULL, 1000, 'closed')
  `).run(id, signalId, sizeUsd)
}

function insertVerdict(
  db: Database.Database,
  id: string,
  decisionId: string,
  pnlGross: number,
  closedAt: number,
  pnlNet?: number,
) {
  db.prepare(`
    INSERT INTO trader_verdicts
      (id, decision_id, pnl_gross, pnl_net, bench_return, hold_drawdown,
       thesis_grade, agent_attribution_json, closed_at)
    VALUES (?, ?, ?, ?, 0, 0, ?, '[]', ?)
  `).run(
    id, decisionId, pnlGross,
    pnlNet ?? pnlGross,
    pnlGross > 0 ? 'A' : 'D',
    closedAt,
  )
}

describe('computeTrackRecord (pure function)', () => {
  it('returns zeros for empty verdict list', () => {
    const r = computeTrackRecord('momentum-stocks', [], 1234)
    expect(r.trade_count).toBe(0)
    expect(r.win_count).toBe(0)
    expect(r.rolling_sharpe).toBe(0)
    expect(r.avg_winner_pct).toBe(0)
    expect(r.avg_loser_pct).toBe(0)
    expect(r.max_dd_pct).toBe(0)
    expect(r.net_pnl_usd).toBe(0)
    expect(r.computed_at).toBe(1234)
  })

  it('computes win_count + net_pnl from a mixed list', () => {
    const r = computeTrackRecord('s', [
      { pnl_gross:  10, pnl_net:  10, closed_at: 1, cost_basis_usd: 100 },
      { pnl_gross:  20, pnl_net:  19, closed_at: 2, cost_basis_usd: 100 },
      { pnl_gross: -15, pnl_net: -16, closed_at: 3, cost_basis_usd: 100 },
    ])
    expect(r.trade_count).toBe(3)
    expect(r.win_count).toBe(2)
    expect(r.net_pnl_usd).toBeCloseTo(13, 6)
  })

  it('avg_winner_pct and avg_loser_pct are averaged separately', () => {
    const r = computeTrackRecord('s', [
      { pnl_gross:  10, pnl_net: 10, closed_at: 1, cost_basis_usd: 100 },  // +10%
      { pnl_gross:  30, pnl_net: 30, closed_at: 2, cost_basis_usd: 100 },  // +30%
      { pnl_gross: -10, pnl_net: -10, closed_at: 3, cost_basis_usd: 100 }, // -10%
    ])
    expect(r.avg_winner_pct).toBeCloseTo(0.20, 6)
    expect(r.avg_loser_pct).toBeCloseTo(-0.10, 6)
  })

  it('rolling_sharpe is mean / stdev of per-trade pct returns', () => {
    const r = computeTrackRecord('s', [
      { pnl_gross:  5, pnl_net: 5, closed_at: 1, cost_basis_usd: 100 },  // 5%
      { pnl_gross: 10, pnl_net: 10, closed_at: 2, cost_basis_usd: 100 }, // 10%
      { pnl_gross:  5, pnl_net: 5, closed_at: 3, cost_basis_usd: 100 },  // 5%
    ])
    // pcts = [0.05, 0.10, 0.05], mean = 0.0666..., sd (sample) = sqrt(((0.05-0.0667)^2 * 2 + (0.1-0.0667)^2)/2) ~ 0.02887
    expect(r.rolling_sharpe).toBeGreaterThan(2)
    expect(r.rolling_sharpe).toBeLessThan(3)
  })

  it('rolling_sharpe is 0 when stdev is 0 (single trade)', () => {
    const r = computeTrackRecord('s', [
      { pnl_gross: 10, pnl_net: 10, closed_at: 1, cost_basis_usd: 100 },
    ])
    expect(r.rolling_sharpe).toBe(0)
  })

  it('max_dd_pct is the worst peak-to-trough decline as a fraction of account equity', () => {
    const r = computeTrackRecord('s', [
      { pnl_gross:  20, pnl_net:  20, closed_at: 1, cost_basis_usd: 100 },  // cum=20, peak=20
      { pnl_gross:  30, pnl_net:  30, closed_at: 2, cost_basis_usd: 100 },  // cum=50, peak=50
      { pnl_gross: -40, pnl_net: -40, closed_at: 3, cost_basis_usd: 100 },  // cum=10, dd=$40
      { pnl_gross:  10, pnl_net:  10, closed_at: 4, cost_basis_usd: 100 },  // cum=20
    ], 1, 1000)
    expect(r.max_dd_pct).toBeCloseTo(-0.04, 6)  // $40 drawdown on $1000 equity
  })

  it('max_dd_pct stays in [-1, 0] when a small peak precedes a large decline', () => {
    // The 2026-08-02 report printed -259.20% from this exact shape: dividing
    // the dollar drawdown by the peak of the P&L curve is unbounded when that
    // peak sits near zero.
    const r = computeTrackRecord('s', [
      { pnl_gross:   4.20, pnl_net:   4.20, closed_at: 1, cost_basis_usd: 100 },
      { pnl_gross: -14.88, pnl_net: -14.88, closed_at: 2, cost_basis_usd: 100 },
    ], 1, 1000)
    expect(r.max_dd_pct).toBeGreaterThanOrEqual(-1)
    expect(r.max_dd_pct).toBeLessThanOrEqual(0)
    expect(r.max_dd_pct).toBeCloseTo(-0.01488, 6)
  })

  it('max_dd_pct clamps at -1 rather than reporting more than a total loss', () => {
    const r = computeTrackRecord('s', [
      { pnl_gross:    1, pnl_net:    1, closed_at: 1, cost_basis_usd: 100 },
      { pnl_gross: -900, pnl_net: -900, closed_at: 2, cost_basis_usd: 100 },
    ], 1, 100)
    expect(r.max_dd_pct).toBe(-1)
  })

  it('max_dd_pct is 0 with no equity base, since no honest percentage exists', () => {
    const r = computeTrackRecord('s', [
      { pnl_gross:  20, pnl_net:  20, closed_at: 1, cost_basis_usd: 100 },
      { pnl_gross: -40, pnl_net: -40, closed_at: 2, cost_basis_usd: 100 },
    ], 1, null)
    expect(r.max_dd_pct).toBe(0)
    expect(r.net_pnl_usd).toBe(-20)  // the loss is carried here instead
  })

  it('max_dd_pct is 0 when curve never declines', () => {
    const r = computeTrackRecord('s', [
      { pnl_gross: 10, pnl_net: 10, closed_at: 1, cost_basis_usd: 100 },
      { pnl_gross: 20, pnl_net: 20, closed_at: 2, cost_basis_usd: 100 },
    ])
    expect(r.max_dd_pct).toBe(0)
  })

  it('max_dd_pct is 0 when underwater from the first trade (no positive peak)', () => {
    // Regression: previously divided the dollar drawdown by Math.max(peak, 1),
    // leaking a -$30 curve out as -3000%. With no high-water mark above the 0
    // baseline there is nothing to take a percentage of, so it must be 0 and
    // the loss is carried by net_pnl_usd.
    const r = computeTrackRecord('s', [
      { pnl_gross: -10, pnl_net: -10, closed_at: 1, cost_basis_usd: 100 },
      { pnl_gross: -20, pnl_net: -20, closed_at: 2, cost_basis_usd: 100 },
    ])
    expect(r.max_dd_pct).toBe(0)
    expect(r.net_pnl_usd).toBe(-30)
  })

  it('handles cost_basis_usd of 0 without dividing by zero', () => {
    const r = computeTrackRecord('s', [
      { pnl_gross: 10, pnl_net: 10, closed_at: 1, cost_basis_usd: 0 },
    ])
    expect(r.rolling_sharpe).toBe(0)
    expect(r.avg_winner_pct).toBe(0)
  })
})

describe('recomputeTrackRecord (db-backed)', () => {
  let db: ReturnType<typeof makeDb>
  beforeEach(() => { db = makeDb() })

  it('writes a row when the strategy has verdicts', () => {
    insertSignal(db, 'sig-1')
    insertDecision(db, 'dec-1', 'sig-1', 100)
    insertVerdict(db, 'v-1', 'dec-1', 25, 1000)

    const result = recomputeTrackRecord(db, 'momentum-stocks')
    expect(result).not.toBeNull()
    expect(result!.trade_count).toBe(1)
    expect(result!.win_count).toBe(1)
    expect(result!.net_pnl_usd).toBe(25)

    const row = db.prepare("SELECT * FROM trader_strategy_track_record WHERE strategy_id='momentum-stocks'").get() as any
    expect(row).toBeDefined()
    expect(row.trade_count).toBe(1)
  })

  it('upserts an existing row', () => {
    insertSignal(db, 'sig-1')
    insertDecision(db, 'dec-1', 'sig-1', 100)
    insertVerdict(db, 'v-1', 'dec-1', 25, 1000)
    recomputeTrackRecord(db, 'momentum-stocks')

    insertSignal(db, 'sig-2')
    insertDecision(db, 'dec-2', 'sig-2', 100)
    insertVerdict(db, 'v-2', 'dec-2', -10, 2000)
    recomputeTrackRecord(db, 'momentum-stocks')

    const row = db.prepare("SELECT trade_count, win_count, net_pnl_usd FROM trader_strategy_track_record WHERE strategy_id='momentum-stocks'").get() as any
    expect(row.trade_count).toBe(2)
    expect(row.win_count).toBe(1)
    expect(row.net_pnl_usd).toBe(15)
  })

  it('returns a zero row for a strategy with no verdicts (empty path)', () => {
    const result = recomputeTrackRecord(db, 'momentum-stocks')
    expect(result).not.toBeNull()
    expect(result!.trade_count).toBe(0)
  })
})

describe('recomputeAllTrackRecords', () => {
  let db: ReturnType<typeof makeDb>
  beforeEach(() => { db = makeDb() })

  it('recomputes every strategy that has at least one verdict', () => {
    insertSignal(db, 'sig-mom-1', 'momentum-stocks')
    insertDecision(db, 'dec-mom-1', 'sig-mom-1', 100)
    insertVerdict(db, 'v-mom-1', 'dec-mom-1', 10, 1000)

    insertSignal(db, 'sig-mr-1', 'mean-reversion-stocks')
    insertDecision(db, 'dec-mr-1', 'sig-mr-1', 100)
    insertVerdict(db, 'v-mr-1', 'dec-mr-1', -5, 1000)

    const records = recomputeAllTrackRecords(db)
    expect(records.length).toBe(2)
    const ids = records.map(r => r.strategy_id).sort()
    expect(ids).toEqual(['mean-reversion-stocks', 'momentum-stocks'])
  })

  it('omits strategies with zero verdicts', () => {
    insertSignal(db, 'sig-1', 'momentum-stocks')
    insertDecision(db, 'dec-1', 'sig-1', 100)
    insertVerdict(db, 'v-1', 'dec-1', 10, 1000)

    const records = recomputeAllTrackRecords(db)
    expect(records.map(r => r.strategy_id)).toEqual(['momentum-stocks'])
  })
})

describe('listTrackRecords', () => {
  let db: ReturnType<typeof makeDb>
  beforeEach(() => { db = makeDb() })

  it('returns rows in strategy_id order', () => {
    insertSignal(db, 'sig-mom', 'momentum-stocks')
    insertDecision(db, 'dec-mom', 'sig-mom', 100)
    insertVerdict(db, 'v-mom', 'dec-mom', 10, 1)
    recomputeTrackRecord(db, 'momentum-stocks')

    insertSignal(db, 'sig-mr', 'mean-reversion-stocks')
    insertDecision(db, 'dec-mr', 'sig-mr', 100)
    insertVerdict(db, 'v-mr', 'dec-mr', 5, 1)
    recomputeTrackRecord(db, 'mean-reversion-stocks')

    const rows = listTrackRecords(db)
    expect(rows.map(r => r.strategy_id)).toEqual(['mean-reversion-stocks', 'momentum-stocks'])
  })

  it('returns empty array when no track records exist', () => {
    expect(listTrackRecords(db)).toEqual([])
  })
})

describe('quarantined verdicts (schema v6)', () => {
  let db: ReturnType<typeof makeDb>
  beforeEach(() => { db = makeDb() })

  it('excludes quarantined verdicts from the track record', () => {
    insertSignal(db, 'sig-a')
    insertDecision(db, 'dec-a', 'sig-a', 100)
    insertVerdict(db, 'v-a', 'dec-a', 25, 1000)
    insertSignal(db, 'sig-b')
    insertDecision(db, 'dec-b', 'sig-b', 100)
    insertVerdict(db, 'v-b', 'dec-b', -10, 2000)

    expect(recomputeTrackRecord(db, 'momentum-stocks')!.trade_count).toBe(2)

    // Quarantine the pre-fix verdict: it was graded per duplicate decision,
    // not per real position, so it must not count toward the record or the
    // go-live gate's trade threshold.
    db.prepare("UPDATE trader_verdicts SET excluded_at = 1 WHERE id = 'v-a'").run()
    const after = recomputeTrackRecord(db, 'momentum-stocks')!
    expect(after.trade_count).toBe(1)
    expect(after.net_pnl_usd).toBe(-10)
  })

  it('goes to zero when every verdict is quarantined', () => {
    insertSignal(db, 'sig-a')
    insertDecision(db, 'dec-a', 'sig-a', 100)
    insertVerdict(db, 'v-a', 'dec-a', 25, 1000)
    db.prepare('UPDATE trader_verdicts SET excluded_at = 1').run()
    const r = recomputeTrackRecord(db, 'momentum-stocks')!
    expect(r.trade_count).toBe(0)
    expect(r.net_pnl_usd).toBe(0)
  })

  it('keeps the quarantined rows for forensics', () => {
    insertSignal(db, 'sig-a')
    insertDecision(db, 'dec-a', 'sig-a', 100)
    insertVerdict(db, 'v-a', 'dec-a', 25, 1000)
    db.prepare('UPDATE trader_verdicts SET excluded_at = 1').run()
    const n = db.prepare('SELECT COUNT(*) AS n FROM trader_verdicts').get() as any
    expect(n.n).toBe(1)
  })
})

describe('isAssetHeld (re-entry guard)', () => {
  let db: Database.Database
  beforeEach(() => { db = makeDb() })

  function held(asset = 'TLT', side = 'buy', strategyId = 'momentum-stocks') {
    return isAssetHeld(db, { asset, side, strategyId })
  }

  function seedPosition(opts: {
    id: string
    status: string
    asset?: string
    side?: string
    strategy?: string
    verdict?: boolean
  }) {
    const asset = opts.asset ?? 'TLT'
    const side = opts.side ?? 'buy'
    db.prepare(`
      INSERT INTO trader_signals (id, strategy_id, asset, side, raw_score, horizon_days, generated_at, status)
      VALUES (?, ?, ?, ?, 0.7, 20, ?, 'decided')
    `).run(`sig-${opts.id}`, opts.strategy ?? 'momentum-stocks', asset, side, Date.now())
    db.prepare(`
      INSERT INTO trader_decisions
        (id, signal_id, action, asset, size_usd, entry_type, thesis, confidence,
         committee_transcript_id, decided_at, status)
      VALUES (?, ?, ?, ?, 1973.25, 'limit', 't', 0.7, NULL, 1000, ?)
    `).run(opts.id, `sig-${opts.id}`, side, asset, opts.status)
    if (opts.verdict) insertVerdict(db, `v-${opts.id}`, opts.id, 10, 2000)
  }

  it('is false with no decisions at all', () => {
    expect(held()).toBe(false)
  })

  // The bug: the trader tick runs every 5 minutes and the engine re-emits the
  // same candidate. Each of these statuses means we already have (or are about
  // to have) exposure, so a second lot must not open.
  for (const status of ['submitting', 'submitted', 'pending_fill', 'executed', 'exit_submitted']) {
    it(`is true while a decision sits at '${status}'`, () => {
      seedPosition({ id: `d-${status}`, status })
      expect(held()).toBe(true)
    })
  }

  it('is false once the position closed out and produced a verdict', () => {
    seedPosition({ id: 'd-closed', status: 'executed', verdict: true })
    expect(held()).toBe(false)
  })

  it('is false for a failed decision, which never reached the book', () => {
    seedPosition({ id: 'd-failed', status: 'failed' })
    expect(held()).toBe(false)
  })

  it('does not block a different asset, side, or strategy', () => {
    seedPosition({ id: 'd-tlt', status: 'executed' })
    expect(held('TLT', 'buy')).toBe(true)
    expect(held('QQQ', 'buy')).toBe(false)
    expect(held('TLT', 'sell')).toBe(false)
    expect(held('TLT', 'buy', 'mean-reversion-stocks')).toBe(false)
  })

  it('blocks the eight-identical-lots case from the 2026-08-02 report', () => {
    // One TLT signal became 8 lots of $1973.25 because nothing asked whether
    // the book already held TLT. The first lot must make the rest unreachable.
    seedPosition({ id: 'd-tlt-1', status: 'executed' })
    for (let i = 2; i <= 8; i++) {
      expect(held()).toBe(true)
    }
  })
})
