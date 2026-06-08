import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { initTraderTables } from './db.js'
import { listOpenPositions, summarizeOpenPositions } from './track-record.js'
import type { EnginePosition } from './types.js'

function makeDb(): Database.Database {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = OFF')
  initTraderTables(db)
  return db
}

function seedExecuted(
  db: Database.Database,
  id: string,
  asset: string,
  sizeUsd: number,
  opts: { closed?: boolean } = {},
): void {
  db.prepare(`
    INSERT INTO trader_signals (id, strategy_id, asset, side, raw_score, horizon_days, generated_at, status)
    VALUES (?, 'momentum-stocks', ?, 'buy', 0.5, 20, ?, 'executed')
  `).run(`sig-${id}`, asset, Date.now())
  db.prepare(`
    INSERT INTO trader_decisions
      (id, signal_id, action, asset, size_usd, entry_type, thesis, confidence, decided_at, status)
    VALUES (?, ?, 'buy', ?, ?, 'limit', 't', 0.7, ?, 'executed')
  `).run(id, `sig-${id}`, asset, sizeUsd, Date.now())
  if (opts.closed) {
    db.prepare(`
      INSERT INTO trader_verdicts
        (id, decision_id, pnl_gross, pnl_net, bench_return, hold_drawdown, thesis_grade, agent_attribution_json, closed_at, returns_backfilled)
      VALUES (?, ?, 0, 0, 0, 0, 'C', '[]', ?, 1)
    `).run(`v-${id}`, id, Date.now())
  }
}

function pos(asset: string, qty: number, marketValue: number, unrealized: number): EnginePosition {
  return { asset, qty, avg_entry_price: 0, market_value: marketValue, unrealized_pnl: unrealized, source: 'broker', updated_at: Date.now() }
}

describe('listOpenPositions', () => {
  let db: Database.Database
  beforeEach(() => { db = makeDb() })

  it('returns executed decisions with no verdict, excludes closed ones', () => {
    seedExecuted(db, 'dec-open-1', 'AAPL', 100)
    seedExecuted(db, 'dec-open-2', 'TSLA', 200)
    seedExecuted(db, 'dec-closed-1', 'MSFT', 150, { closed: true })

    const open = listOpenPositions(db)
    expect(open.map(o => o.decision_id).sort()).toEqual(['dec-open-1', 'dec-open-2'])
    expect(open.find(o => o.decision_id === 'dec-open-1')!.cost_basis_usd).toBe(100)
  })

  it('ignores non-executed decisions', () => {
    seedExecuted(db, 'dec-open-1', 'AAPL', 100)
    db.prepare(`
      INSERT INTO trader_signals (id, strategy_id, asset, side, raw_score, horizon_days, generated_at, status)
      VALUES ('sig-fail', 'momentum-stocks', 'NVDA', 'buy', 0.5, 20, ?, 'failed')
    `).run(Date.now())
    db.prepare(`
      INSERT INTO trader_decisions (id, signal_id, action, asset, size_usd, entry_type, thesis, confidence, decided_at, status)
      VALUES ('dec-fail', 'sig-fail', 'buy', 'NVDA', 100, 'limit', 't', 0.7, ?, 'failed')
    `).run(Date.now())
    expect(listOpenPositions(db).map(o => o.decision_id)).toEqual(['dec-open-1'])
  })
})

describe('summarizeOpenPositions', () => {
  it('sums cost basis across all open decisions and MTM from matched live positions', () => {
    const open = [
      { decision_id: 'd1', signal_id: 's1', asset: 'AAPL', side: 'buy', strategy_id: 'momentum-stocks', cost_basis_usd: 100, decided_at: 1 },
      { decision_id: 'd2', signal_id: 's2', asset: 'TSLA', side: 'buy', strategy_id: 'momentum-stocks', cost_basis_usd: 200, decided_at: 2 },
    ]
    const positions = [pos('AAPL', 1, 110, 10), pos('TSLA', 2, 195, -5)]
    const s = summarizeOpenPositions(open, positions)
    expect(s.openCount).toBe(2)
    expect(s.totalCostBasisUsd).toBe(300)
    expect(s.totalUnrealizedPnlUsd).toBe(5)     // 10 + -5
    expect(s.totalMarketValueUsd).toBe(305)     // 110 + 195
    expect(s.unmatchedCount).toBe(0)
  })

  it('attributes a shared asset position once across multiple open decisions', () => {
    const open = [
      { decision_id: 'd1', signal_id: 's1', asset: 'AAPL', side: 'buy', strategy_id: 'm', cost_basis_usd: 100, decided_at: 1 },
      { decision_id: 'd2', signal_id: 's2', asset: 'AAPL', side: 'buy', strategy_id: 'm', cost_basis_usd: 100, decided_at: 2 },
    ]
    const positions = [pos('AAPL', 2, 220, 20)]
    const s = summarizeOpenPositions(open, positions)
    expect(s.openCount).toBe(2)
    expect(s.totalCostBasisUsd).toBe(200)
    expect(s.totalUnrealizedPnlUsd).toBe(20)    // counted ONCE, not 40
    expect(s.totalMarketValueUsd).toBe(220)
    expect(s.unmatchedCount).toBe(0)
  })

  it('counts open decisions with no live position as unmatched and contributes 0 MTM', () => {
    const open = [
      { decision_id: 'd1', signal_id: 's1', asset: 'AAPL', side: 'buy', strategy_id: 'm', cost_basis_usd: 100, decided_at: 1 },
    ]
    const s = summarizeOpenPositions(open, [])
    expect(s.openCount).toBe(1)
    expect(s.totalCostBasisUsd).toBe(100)
    expect(s.totalUnrealizedPnlUsd).toBe(0)
    expect(s.totalMarketValueUsd).toBe(0)
    expect(s.unmatchedCount).toBe(1)
  })

  it('two decisions on the same asset with no live position report unmatchedCount of 1, not 2', () => {
    const open = [
      { decision_id: 'd1', signal_id: 's1', asset: 'AAPL', side: 'buy', strategy_id: 'm', cost_basis_usd: 100, decided_at: 1 },
      { decision_id: 'd2', signal_id: 's2', asset: 'AAPL', side: 'buy', strategy_id: 'm', cost_basis_usd: 100, decided_at: 2 },
    ]
    const s = summarizeOpenPositions(open, [])
    expect(s.openCount).toBe(2)
    expect(s.totalCostBasisUsd).toBe(200)
    expect(s.unmatchedCount).toBe(1)  // one ASSET missing, not two decisions
  })
})
