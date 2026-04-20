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
