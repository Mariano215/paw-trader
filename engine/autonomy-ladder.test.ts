/**
 * autonomy-ladder.test.ts -- Phase 3 Task 5
 *
 * Verifies tier classification + the DB-backed wrapper that the
 * dispatcher uses on every approved committee result.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'

import { initTraderTables } from './db.js'
import { seedAllStrategies } from './strategy-manager.js'
import {
  classifyTier,
  classifyStrategyTier,
  COLD_START_TRADES,
  COLD_START_SCALE,
  TIER_0_SCALE,
  TIER_1_SCALE,
} from './autonomy-ladder.js'
import type { StrategyTrackRecord } from './track-record.js'
import type { ThesisGrade } from './verdict-engine.js'

function makeDb() {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = OFF')
  initTraderTables(db)
  seedAllStrategies(db)
  return db
}

function tr(overrides: Partial<StrategyTrackRecord> = {}): StrategyTrackRecord {
  return {
    strategy_id: 'momentum-stocks',
    trade_count: 50,
    win_count: 30,
    rolling_sharpe: 0.5,
    avg_winner_pct: 0.03,
    avg_loser_pct: -0.02,
    max_dd_pct: -0.05,
    net_pnl_usd: 1000,
    computed_at: 0,
    ...overrides,
  }
}

describe('classifyTier (pure)', () => {
  it('cold-start when track record is null', () => {
    const r = classifyTier({ trackRecord: null, recentGrades: [] })
    expect(r.tier).toBe('cold-start')
    expect(r.scale).toBe(COLD_START_SCALE)
    expect(r.reason).toContain('cold start')
  })

  it('cold-start when trade_count below threshold', () => {
    const r = classifyTier({
      trackRecord: tr({ trade_count: COLD_START_TRADES - 1 }),
      recentGrades: [],
    })
    expect(r.tier).toBe('cold-start')
    expect(r.scale).toBe(COLD_START_SCALE)
  })

  it('exits cold-start at exactly the threshold', () => {
    const r = classifyTier({
      trackRecord: tr({ trade_count: COLD_START_TRADES, rolling_sharpe: 1, max_dd_pct: -0.05 }),
      recentGrades: ['A', 'B', 'A'],
    })
    expect(r.tier).toBe('tier-1')
  })

  it('tier-0 when sharpe is non-positive past cold start', () => {
    const r = classifyTier({
      trackRecord: tr({ trade_count: 50, rolling_sharpe: 0 }),
      recentGrades: ['A', 'A', 'A'],
    })
    expect(r.tier).toBe('tier-0')
    expect(r.scale).toBe(TIER_0_SCALE)
    expect(r.reason).toContain('sharpe')
  })

  it('tier-0 when max_dd_pct breaches the -10% gate', () => {
    const r = classifyTier({
      trackRecord: tr({ trade_count: 50, rolling_sharpe: 0.5, max_dd_pct: -0.15 }),
      recentGrades: ['A', 'A', 'A'],
    })
    expect(r.tier).toBe('tier-0')
    expect(r.reason).toContain('drawdown')
  })

  it('tier-0 when 3 of last 5 grades are C or D', () => {
    const r = classifyTier({
      trackRecord: tr({ trade_count: 50, rolling_sharpe: 0.5, max_dd_pct: -0.05 }),
      recentGrades: ['C', 'D', 'C', 'A', 'B'],
    })
    expect(r.tier).toBe('tier-0')
    expect(r.reason).toContain('grades')
  })

  it('tier-1 when all guardrails clear', () => {
    const r = classifyTier({
      trackRecord: tr({ trade_count: 50, rolling_sharpe: 0.8, max_dd_pct: -0.04 }),
      recentGrades: ['A', 'A', 'B', 'A', 'B'],
    })
    expect(r.tier).toBe('tier-1')
    expect(r.scale).toBe(TIER_1_SCALE)
  })

  it('grade trend gate ignores when fewer than threshold grades available', () => {
    // Two C grades but only two grades available -- should not trip
    const r = classifyTier({
      trackRecord: tr({ trade_count: 50, rolling_sharpe: 0.5, max_dd_pct: -0.05 }),
      recentGrades: ['C', 'C'],
    })
    expect(r.tier).toBe('tier-1')
  })

  it('grade trend gate uses lookback = 5 even if more grades supplied', () => {
    // Grades 1-5 are all A, grades 6-10 are all D. Only the first 5 count.
    const grades: ThesisGrade[] = ['A', 'A', 'A', 'A', 'A', 'D', 'D', 'D', 'D', 'D']
    const r = classifyTier({
      trackRecord: tr({ trade_count: 50, rolling_sharpe: 0.5, max_dd_pct: -0.05 }),
      recentGrades: grades,
    })
    expect(r.tier).toBe('tier-1')
  })
})

describe('classifyStrategyTier (db-backed)', () => {
  let db: ReturnType<typeof makeDb>
  beforeEach(() => { db = makeDb() })

  function seedTrackRecord(overrides: Partial<StrategyTrackRecord>) {
    const r = tr(overrides)
    db.prepare(`
      INSERT OR REPLACE INTO trader_strategy_track_record
        (strategy_id, trade_count, win_count, rolling_sharpe,
         avg_winner_pct, avg_loser_pct, max_dd_pct, net_pnl_usd, computed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      r.strategy_id, r.trade_count, r.win_count, r.rolling_sharpe,
      r.avg_winner_pct, r.avg_loser_pct, r.max_dd_pct, r.net_pnl_usd, r.computed_at,
    )
  }

  function seedGrades(strategy: string, grades: ThesisGrade[]) {
    grades.forEach((g, idx) => {
      const sigId = `sig-${strategy}-${idx}`
      const decId = `dec-${strategy}-${idx}`
      const verdictId = `v-${strategy}-${idx}`
      db.prepare(`
        INSERT INTO trader_signals (id, strategy_id, asset, side, raw_score, horizon_days, generated_at, status)
        VALUES (?, ?, 'AAPL', 'buy', 0.7, 20, ?, 'closed')
      `).run(sigId, strategy, idx)
      db.prepare(`
        INSERT INTO trader_decisions
          (id, signal_id, action, asset, size_usd, entry_type, thesis, confidence,
           committee_transcript_id, decided_at, status)
        VALUES (?, ?, 'buy', 'AAPL', 100, 'limit', 't', 0.7, NULL, ?, 'closed')
      `).run(decId, sigId, idx)
      db.prepare(`
        INSERT INTO trader_verdicts
          (id, decision_id, pnl_gross, pnl_net, bench_return, hold_drawdown,
           thesis_grade, agent_attribution_json, closed_at)
        VALUES (?, ?, 0, 0, 0, 0, ?, '[]', ?)
      `).run(verdictId, decId, g, idx)
    })
  }

  it('returns cold-start when no track record exists', () => {
    const r = classifyStrategyTier(db, 'momentum-stocks')
    expect(r.tier).toBe('cold-start')
  })

  it('returns tier-1 with seeded clean record + good grades', () => {
    seedTrackRecord({ trade_count: 50, rolling_sharpe: 0.8, max_dd_pct: -0.05 })
    seedGrades('momentum-stocks', ['A', 'A', 'B', 'A'])
    const r = classifyStrategyTier(db, 'momentum-stocks')
    expect(r.tier).toBe('tier-1')
  })

  it('returns tier-0 when seeded drawdown breaches gate', () => {
    seedTrackRecord({ trade_count: 50, rolling_sharpe: 0.5, max_dd_pct: -0.20 })
    const r = classifyStrategyTier(db, 'momentum-stocks')
    expect(r.tier).toBe('tier-0')
  })

  it('reads recent grades newest-first via closed_at DESC', () => {
    seedTrackRecord({ trade_count: 50, rolling_sharpe: 0.5, max_dd_pct: -0.05 })
    // Insert 5 grades. Newest 3 are bad (C, D, C). Older 2 are A.
    seedGrades('momentum-stocks', ['A', 'A', 'C', 'D', 'C'])
    const r = classifyStrategyTier(db, 'momentum-stocks')
    expect(r.tier).toBe('tier-0')
    expect(r.reason).toContain('grades')
  })
})
