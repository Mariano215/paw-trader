/**
 * reasoning-bank.test.ts -- Phase 2 Task 5
 *
 * Covers retrieval + formatting of closed-trade summaries. The table
 * ships empty in Phase 2 so the retrieval path is a no-op in
 * production today; these tests verify both the empty-table branch
 * and the populated branch so Phase 3 can start writing rows without
 * any further plumbing.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'

import { initTraderTables } from './db.js'
import {
  getPastCases,
  formatPastCases,
  retrievePastCases,
  insertCase,
  rollupRecentOutcomes,
  type ReasoningBankCase,
} from './reasoning-bank.js'

function makeDb() {
  const db = new Database(':memory:')
  initTraderTables(db)
  return db
}

function sampleCase(
  overrides: Partial<ReasoningBankCase> = {},
): ReasoningBankCase {
  return {
    id: 'case-' + Math.random().toString(36).slice(2, 8),
    decision_id: null,
    signal_id: null,
    asset: 'AAPL',
    side: 'buy',
    strategy: 'momentum-stocks',
    summary: 'Held 20d, exited at take-profit after earnings beat.',
    thesis_grade: 'A',
    outcome: 'win',
    pnl_net: 12.5,
    embedding_id: null,
    created_at: Date.now(),
    ...overrides,
  }
}

describe('ReasoningBank retrieval', () => {
  let db: ReturnType<typeof makeDb>
  beforeEach(() => { db = makeDb() })

  it('returns empty array when bank is empty', () => {
    const cases = getPastCases(db, { asset: 'AAPL', strategy: 'momentum-stocks' })
    expect(cases).toEqual([])
  })

  it('returns null from retrievePastCases when bank is empty', () => {
    const rendered = retrievePastCases(db, { asset: 'AAPL', strategy: 'momentum-stocks' })
    expect(rendered).toBeNull()
  })

  it('prefers exact asset+strategy matches, newest first', () => {
    insertCase(db, sampleCase({ id: 'c1', asset: 'AAPL', strategy: 'momentum-stocks', created_at: 1000 }))
    insertCase(db, sampleCase({ id: 'c2', asset: 'AAPL', strategy: 'momentum-stocks', created_at: 2000 }))
    insertCase(db, sampleCase({ id: 'c3', asset: 'MSFT', strategy: 'momentum-stocks', created_at: 3000 }))
    const cases = getPastCases(db, { asset: 'AAPL', strategy: 'momentum-stocks', k: 2 })
    expect(cases.map(c => c.id)).toEqual(['c2', 'c1'])
  })

  it('falls back to strategy-only when fewer asset matches than k', () => {
    insertCase(db, sampleCase({ id: 'aapl-1', asset: 'AAPL', strategy: 'momentum-stocks', created_at: 1000 }))
    insertCase(db, sampleCase({ id: 'msft-1', asset: 'MSFT', strategy: 'momentum-stocks', created_at: 500 }))
    insertCase(db, sampleCase({ id: 'spy-1', asset: 'SPY', strategy: 'momentum-stocks', created_at: 400 }))
    const cases = getPastCases(db, { asset: 'AAPL', strategy: 'momentum-stocks', k: 3 })
    expect(cases[0].id).toBe('aapl-1')
    expect(cases.length).toBe(3)
    // The fallback pulls in MSFT and SPY as most-recent strategy-wide.
    const remaining = cases.slice(1).map(c => c.id).sort()
    expect(remaining).toEqual(['msft-1', 'spy-1'])
  })

  it('clamps k to [1, 10]', () => {
    for (let i = 0; i < 15; i++) {
      insertCase(db, sampleCase({ id: 'c' + i, strategy: 'momentum-stocks', created_at: i }))
    }
    const tooMany = getPastCases(db, { asset: 'AAPL', strategy: 'momentum-stocks', k: 99 })
    expect(tooMany.length).toBe(10)
    const tooFew = getPastCases(db, { asset: 'AAPL', strategy: 'momentum-stocks', k: 0 })
    expect(tooFew.length).toBe(1)
  })

  it('formats cases into a coordinator-ready prose block', () => {
    const rendered = formatPastCases([
      sampleCase({ id: 'x1', asset: 'AAPL', side: 'buy', strategy: 'momentum-stocks',
        summary: 'Held 18d.', thesis_grade: 'A', outcome: 'win', pnl_net: 22.11 }),
    ])
    expect(rendered).not.toBeNull()
    expect(rendered!).toContain('PAST SIMILAR CASES')
    expect(rendered!).toContain('AAPL buy via momentum-stocks')
    expect(rendered!).toContain('grade=A')
    expect(rendered!).toContain('pnl=22.11')
  })

  it('formatPastCases returns null on empty input', () => {
    expect(formatPastCases([])).toBeNull()
    expect(formatPastCases([] as ReasoningBankCase[])).toBeNull()
  })

  it('retrievePastCases end-to-end returns rendered string when populated', () => {
    insertCase(db, sampleCase({ id: 'e2e-1', asset: 'AAPL', strategy: 'momentum-stocks' }))
    const rendered = retrievePastCases(db, { asset: 'AAPL', strategy: 'momentum-stocks' })
    expect(rendered).not.toBeNull()
    expect(rendered!).toContain('AAPL buy via momentum-stocks')
  })
})

function freshDb(): Database.Database {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE trader_strategies (
      id TEXT PRIMARY KEY, name TEXT, asset_class TEXT NOT NULL,
      tier TEXT, status TEXT, params_json TEXT, created_at INTEGER, updated_at INTEGER
    );
    CREATE TABLE trader_reasoning_bank (
      id TEXT PRIMARY KEY, decision_id TEXT, signal_id TEXT,
      asset TEXT NOT NULL, side TEXT NOT NULL, strategy TEXT NOT NULL,
      summary TEXT NOT NULL, thesis_grade TEXT, outcome TEXT,
      pnl_net REAL, embedding_id TEXT, created_at INTEGER NOT NULL
    );
  `)
  db.prepare("INSERT INTO trader_strategies (id, asset_class) VALUES ('eq-mom', 'equity')").run()
  db.prepare("INSERT INTO trader_strategies (id, asset_class) VALUES ('cr-mom', 'crypto')").run()
  return db
}

function insertRollupCase(db: Database.Database, p: {
  id: string, asset: string, side: string, strategy: string,
  pnl_net: number | null, outcome: string | null, created_at: number
}): void {
  db.prepare(`
    INSERT INTO trader_reasoning_bank
      (id, asset, side, strategy, summary, pnl_net, outcome, created_at)
    VALUES (?, ?, ?, ?, 'summary', ?, ?, ?)
  `).run(p.id, p.asset, p.side, p.strategy, p.pnl_net, p.outcome, p.created_at)
}

describe('rollupRecentOutcomes', () => {
  it('returns calibration message on empty DB', () => {
    const db = freshDb()
    const result = rollupRecentOutcomes(db, 'equity', 20)
    expect(result.total).toBe(0)
    expect(result.formatted).toContain('No prior paper trades')
  })

  it('excludes unresolved (null outcome) trades from totals', () => {
    const db = freshDb()
    const t = Date.now()
    // Insert 3 resolved + 2 unresolved (outcome=null, simulating open positions)
    insertRollupCase(db, { id: 'r1', asset: 'AAPL', side: 'buy', strategy: 'eq-mom', pnl_net: 50, outcome: 'win', created_at: t - 3000 })
    insertRollupCase(db, { id: 'r2', asset: 'AAPL', side: 'buy', strategy: 'eq-mom', pnl_net: -20, outcome: 'loss', created_at: t - 2000 })
    insertRollupCase(db, { id: 'u1', asset: 'AAPL', side: 'buy', strategy: 'eq-mom', pnl_net: null, outcome: null, created_at: t - 1000 })
    insertRollupCase(db, { id: 'u2', asset: 'TSLA', side: 'sell', strategy: 'eq-mom', pnl_net: null, outcome: null, created_at: t })
    const result = rollupRecentOutcomes(db, 'equity', 20)
    // Only resolved trades count
    expect(result.total).toBe(2)
    expect(result.wins).toBe(1)
    expect(result.losses).toBe(1)
    expect(result.winRate).toBeCloseTo(0.5, 2)
    // Avg = (50 + -20) / 2 = 15
    expect(result.avgPnLUsd).toBeCloseTo(15, 1)
  })

  it('returns calibration message when all trades are unresolved', () => {
    const db = freshDb()
    const t = Date.now()
    insertRollupCase(db, { id: 'u1', asset: 'AAPL', side: 'buy', strategy: 'eq-mom', pnl_net: null, outcome: null, created_at: t })
    const result = rollupRecentOutcomes(db, 'equity', 20)
    expect(result.total).toBe(0)
    expect(result.formatted).toContain('calibration phase')
  })

  it('aggregates win/loss/avg for equity', () => {
    const db = freshDb()
    const t = Date.now()
    // pnl_net is stored as USD dollar values
    insertRollupCase(db, { id: 'c1', asset: 'AAPL', side: 'buy', strategy: 'eq-mom', pnl_net: 20, outcome: 'win', created_at: t - 5000 })
    insertRollupCase(db, { id: 'c2', asset: 'AAPL', side: 'buy', strategy: 'eq-mom', pnl_net: -10, outcome: 'loss', created_at: t - 4000 })
    insertRollupCase(db, { id: 'c3', asset: 'TSLA', side: 'sell', strategy: 'eq-mom', pnl_net: 5, outcome: 'win', created_at: t - 3000 })
    const result = rollupRecentOutcomes(db, 'equity', 20)
    expect(result.total).toBe(3)
    expect(result.wins).toBe(2)
    expect(result.losses).toBe(1)
    expect(result.winRate).toBeCloseTo(0.667, 2)
    expect(result.avgPnLUsd).toBeCloseTo(5, 1)
    expect(result.formatted).toMatch(/2W\/1L/)
  })

  it('separates equity from crypto', () => {
    const db = freshDb()
    const t = Date.now()
    insertRollupCase(db, { id: 'e1', asset: 'AAPL', side: 'buy', strategy: 'eq-mom', pnl_net: 20, outcome: 'win', created_at: t })
    insertRollupCase(db, { id: 'c1', asset: 'BTC', side: 'buy', strategy: 'cr-mom', pnl_net: -30, outcome: 'loss', created_at: t })
    const eq = rollupRecentOutcomes(db, 'equity', 20)
    const cr = rollupRecentOutcomes(db, 'crypto', 20)
    expect(eq.total).toBe(1)
    expect(cr.total).toBe(1)
    expect(eq.wins).toBe(1)
    expect(cr.losses).toBe(1)
  })

  it('limits to most recent N', () => {
    const db = freshDb()
    for (let i = 0; i < 30; i++) {
      insertRollupCase(db, { id: `c${i}`, asset: 'AAPL', side: 'buy', strategy: 'eq-mom', pnl_net: 10, outcome: 'win', created_at: 1000 + i })
    }
    const result = rollupRecentOutcomes(db, 'equity', 20)
    expect(result.total).toBe(20)
  })

  it('groups by symbol with trade count', () => {
    const db = freshDb()
    insertRollupCase(db, { id: 'a1', asset: 'AAPL', side: 'buy', strategy: 'eq-mom', pnl_net: 10, outcome: 'win', created_at: 1000 })
    insertRollupCase(db, { id: 'a2', asset: 'AAPL', side: 'buy', strategy: 'eq-mom', pnl_net: 20, outcome: 'win', created_at: 2000 })
    insertRollupCase(db, { id: 't1', asset: 'TSLA', side: 'sell', strategy: 'eq-mom', pnl_net: -10, outcome: 'loss', created_at: 3000 })
    const result = rollupRecentOutcomes(db, 'equity', 20)
    expect(result.bySymbol.AAPL).toMatch(/2 trades/)
    expect(result.bySymbol.TSLA).toMatch(/1 trade/)
  })

  it('handles all-loss scenario with warning text', () => {
    const db = freshDb()
    for (let i = 0; i < 5; i++) {
      insertRollupCase(db, { id: `l${i}`, asset: 'AAPL', side: 'buy', strategy: 'eq-mom', pnl_net: -20, outcome: 'loss', created_at: 1000 + i })
    }
    const result = rollupRecentOutcomes(db, 'equity', 20)
    expect(result.winRate).toBe(0)
    expect(result.formatted.toLowerCase()).toContain('warning')
  })
})
