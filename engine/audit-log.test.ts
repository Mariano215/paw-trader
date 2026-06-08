/**
 * audit-log.test.ts -- Phase E Task 2.
 * Immutability, slippage, FIFO matching, derived-P&L idempotency.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { initTraderTables } from './db.js'
import {
  recordFill, listFillsForDecision, computeSlippageUsd,
  matchLotsFifo, recomputeRealizedPnl, LOT_MATCH_RULE,
  type FillRow,
} from './audit-log.js'

function makeDb(): Database.Database {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = OFF')
  initTraderTables(db)
  return db
}

function fill(over: Partial<FillRow> = {}): FillRow {
  return {
    id: 'f-' + Math.random().toString(36).slice(2, 8),
    decision_id: 'd1',
    client_order_id: 'co1',
    broker_order_id: null,
    asset: 'AAPL',
    side: 'buy',
    fill_qty: 10,
    fill_price: 100,
    intended_price: 100,
    intended_ts_ms: 1000,
    fill_ts_ms: 2000,
    fee_usd: 0,
    slippage_usd: 0,
    entry_thesis: null,
    exit_reason: null,
    recorded_at: 3000,
    ...over,
  }
}

describe('computeSlippageUsd', () => {
  it('positive when a buy fills above intended', () => {
    expect(computeSlippageUsd('buy', 101, 10, 100)).toBeCloseTo(10, 10)
  })
  it('positive when a sell fills below intended', () => {
    expect(computeSlippageUsd('sell', 99, 10, 100)).toBeCloseTo(10, 10)
  })
  it('zero when no intended price recorded', () => {
    expect(computeSlippageUsd('buy', 101, 10, null)).toBe(0)
  })
})

describe('recordFill immutability', () => {
  let db: Database.Database
  beforeEach(() => { db = makeDb() })

  it('appends rows and computes slippage at write time', () => {
    recordFill(db, {
      decisionId: 'd1', clientOrderId: 'co1', asset: 'AAPL', side: 'buy',
      fillQty: 10, fillPrice: 101, intendedPrice: 100, fillTsMs: 2000,
    })
    const rows = listFillsForDecision(db, 'd1')
    expect(rows).toHaveLength(1)
    expect(rows[0].slippage_usd).toBeCloseTo(10, 10)
  })

  it('re-recording the same pinned id is a no-op (INSERT OR IGNORE)', () => {
    const base = {
      decisionId: 'd1', clientOrderId: 'co1', asset: 'AAPL', side: 'buy' as const,
      fillQty: 10, fillPrice: 100, fillTsMs: 2000,
    }
    recordFill(db, base, 3000, 'pinned-1')
    recordFill(db, base, 3000, 'pinned-1')
    expect(listFillsForDecision(db, 'd1')).toHaveLength(1)
  })
})

describe('matchLotsFifo', () => {
  it('closes a full round trip and nets fees off both legs', () => {
    const fills: FillRow[] = [
      fill({ side: 'buy', fill_qty: 10, fill_price: 100, fee_usd: 1, fill_ts_ms: 1000 }),
      fill({ side: 'sell', fill_qty: 10, fill_price: 110, fee_usd: 1, fill_ts_ms: 2000 }),
    ]
    const lots = matchLotsFifo(fills)
    expect(lots).toHaveLength(1)
    expect(lots[0].pnlGross).toBeCloseTo(100, 10) // (110-100)*10
    expect(lots[0].feesUsd).toBeCloseTo(2, 10)
    expect(lots[0].pnlNet).toBeCloseTo(98, 10)
  })

  it('partial sell leaves the remaining open lot intact', () => {
    // buy 10 @100, sell 5 @110 -> one realized lot (qty=5, pnlGross=50),
    // and 5 shares remain open (not yet realized).
    const fills: FillRow[] = [
      fill({ side: 'buy', fill_qty: 10, fill_price: 100, fill_ts_ms: 1000 }),
      fill({ side: 'sell', fill_qty: 5,  fill_price: 110, fill_ts_ms: 2000 }),
    ]
    const lots = matchLotsFifo(fills)
    expect(lots).toHaveLength(1)
    expect(lots[0].qty).toBeCloseTo(5, 10)
    expect(lots[0].pnlGross).toBeCloseTo(50, 10) // (110-100)*5
  })

  it('matches oldest buy first across two lots', () => {
    const fills: FillRow[] = [
      fill({ side: 'buy', fill_qty: 5, fill_price: 100, fill_ts_ms: 1000 }),
      fill({ side: 'buy', fill_qty: 5, fill_price: 120, fill_ts_ms: 1500 }),
      fill({ side: 'sell', fill_qty: 5, fill_price: 130, fill_ts_ms: 2000 }),
    ]
    const lots = matchLotsFifo(fills)
    expect(lots).toHaveLength(1)
    expect(lots[0].entryPrice).toBe(100) // FIFO took the 100 lot, not the 120
    expect(lots[0].pnlGross).toBeCloseTo(150, 10) // (130-100)*5
  })
})

describe('recomputeRealizedPnl', () => {
  let db: Database.Database
  beforeEach(() => { db = makeDb() })

  it('writes derived rows from fills and is idempotent on re-run', () => {
    recordFill(db, { decisionId: 'd1', clientOrderId: 'co1', asset: 'AAPL', side: 'buy', fillQty: 10, fillPrice: 100, fillTsMs: 1000 })
    recordFill(db, { decisionId: 'd1', clientOrderId: 'co1', asset: 'AAPL', side: 'sell', fillQty: 10, fillPrice: 110, fillTsMs: 2000 })
    recomputeRealizedPnl(db, 'd1', 9999)
    recomputeRealizedPnl(db, 'd1', 9999) // re-run must not duplicate
    const rows = db.prepare('SELECT * FROM trader_realized_pnl WHERE decision_id = ?').all('d1') as Array<{ pnl_gross: number; lot_match_rule: string }>
    expect(rows).toHaveLength(1)
    expect(rows[0].pnl_gross).toBeCloseTo(100, 10)
    expect(rows[0].lot_match_rule).toBe(LOT_MATCH_RULE)
  })
})
