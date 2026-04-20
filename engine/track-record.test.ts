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

  it('max_dd_pct is the worst peak-to-trough decline of cumulative net pnl', () => {
    const r = computeTrackRecord('s', [
      { pnl_gross:  20, pnl_net:  20, closed_at: 1, cost_basis_usd: 100 },  // cum=20, peak=20
      { pnl_gross:  30, pnl_net:  30, closed_at: 2, cost_basis_usd: 100 },  // cum=50, peak=50
      { pnl_gross: -40, pnl_net: -40, closed_at: 3, cost_basis_usd: 100 },  // cum=10, dd=40/50=0.8
      { pnl_gross:  10, pnl_net:  10, closed_at: 4, cost_basis_usd: 100 },  // cum=20
    ])
    expect(r.max_dd_pct).toBeCloseTo(-0.8, 6)
  })

  it('max_dd_pct is 0 when curve never declines', () => {
    const r = computeTrackRecord('s', [
      { pnl_gross: 10, pnl_net: 10, closed_at: 1, cost_basis_usd: 100 },
      { pnl_gross: 20, pnl_net: 20, closed_at: 2, cost_basis_usd: 100 },
    ])
    expect(r.max_dd_pct).toBe(0)
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
