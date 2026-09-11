import {describe, expect, it} from 'vitest'
import Database from 'better-sqlite3'
import {
  appendBitcoinMarketDataBatch,
  appendBitcoinOrderFlowBar,
  initBitcoinOrderFlowStore,
  type BitcoinOrderFlowBarRow,
} from './bitcoin-order-flow-store.js'

function database(): Database.Database {
  const db = new Database(':memory:')
  initBitcoinOrderFlowStore(db)
  return db
}

function bar(): BitcoinOrderFlowBarRow {
  return {
    bucketStartMs: 1_800_000_000_000,
    bucketEndMs: 1_800_000_900_000,
    tradeCount: 1,
    buyVolume: 2,
    sellVolume: 0,
    tradeImbalance15m: 1,
    tradeImbalance60m: 1,
    depthImbalance15m: 0.2,
    bidDepletionPerSecond: 0,
    askDepletionPerSecond: 0,
    bidReplenishmentPerSecond: 0.1,
    askReplenishmentPerSecond: 0.1,
    spreadMedian: 1,
    spreadP95: 1,
    realizedVolatility60m: 0,
    priceOpen: 100_000,
    priceHigh: 100_100,
    priceLow: 99_900,
    priceClose: 100_050,
    messageCount: 2,
    sequenceGapCount: 0,
    reconnectCount: 0,
    downtimeMs: 0,
    eligible: true,
    qualityReason: null,
    createdAt: 1_800_000_900_001,
  }
}

describe('Bitcoin order-flow research store', () => {
  it('stores normalized trades and L2 updates atomically and deduplicates trade IDs', () => {
    const db = database()
    const trade = {
      tradeId: 'trade-1', price: 100_000, size: 0.01,
      makerSide: 'SELL' as const, aggressorSide: 'BUY' as const,
      sourceTs: 1_800_000_000_001, receivedAt: 1_800_000_000_010,
      channelSequence: 7, eventKind: 'update' as const,
    }
    const update = {
      side: 'bid' as const, price: 99_999, newQuantity: 1,
      sourceTs: 1_800_000_000_002, receivedAt: 1_800_000_000_010,
      channelSequence: 8, eventKind: 'update' as const,
    }
    expect(appendBitcoinMarketDataBatch(db, [trade], [update])).toEqual({
      tradesInserted: 1, tradesDeduped: 0, l2UpdatesInserted: 1,
    })
    expect(appendBitcoinMarketDataBatch(db, [trade], [])).toEqual({
      tradesInserted: 0, tradesDeduped: 1, l2UpdatesInserted: 0,
    })
    expect(db.prepare('SELECT aggressor_side FROM bitcoin_order_flow_trades').get())
      .toEqual({aggressor_side: 'BUY'})
  })

  it.each([
    'bitcoin_order_flow_trades',
    'bitcoin_order_flow_l2_updates',
    'bitcoin_order_flow_15m_bars',
    'bitcoin_order_flow_evaluation_runs',
  ])('rejects updates and deletes on %s', table => {
    const db = database()
    appendBitcoinMarketDataBatch(db, [{
      tradeId: 'trade-1', price: 100_000, size: 0.01,
      makerSide: 'SELL', aggressorSide: 'BUY', sourceTs: 1_800_000_000_001,
      receivedAt: 1_800_000_000_010, channelSequence: 7, eventKind: 'update',
    }], [{
      side: 'bid', price: 99_999, newQuantity: 1, sourceTs: 1_800_000_000_002,
      receivedAt: 1_800_000_000_010, channelSequence: 8, eventKind: 'update',
    }])
    appendBitcoinOrderFlowBar(db, bar())
    if (table === 'bitcoin_order_flow_evaluation_runs') {
      db.prepare(`INSERT INTO bitcoin_order_flow_evaluation_runs
        (id,declaration_version,declaration_at,data_cutoff_at,contract_hash,input_hash,status,
         holdout_uses,development_json,validation_json,criteria_json,passed,created_at)
        VALUES ('run-1',1,1,2,?,?,'rejected_pre_holdout',0,'{}','{}','[]',0,3)`)
        .run('a'.repeat(64), 'b'.repeat(64))
    }
    expect(() => db.prepare(`UPDATE ${table} SET rowid=rowid`).run()).toThrow(/append-only/)
    expect(() => db.prepare(`DELETE FROM ${table}`).run()).toThrow(/append-only/)
  })

  it('stores each completed bar once', () => {
    const db = database()
    expect(appendBitcoinOrderFlowBar(db, bar())).toBe(true)
    expect(appendBitcoinOrderFlowBar(db, bar())).toBe(false)
    expect(db.prepare('SELECT eligible,quality_reason,price_open,price_high,price_low,price_close FROM bitcoin_order_flow_15m_bars').get())
      .toEqual({eligible: 1, quality_reason: null, price_open: 100_000,
        price_high: 100_100, price_low: 99_900, price_close: 100_050})
  })

  it('rejects partial or inconsistent bar price evidence', () => {
    const db = database()
    expect(() => appendBitcoinOrderFlowBar(db, {...bar(), priceClose: null}))
      .toThrow(/complete or absent/)
    expect(() => appendBitcoinOrderFlowBar(db, {...bar(), priceHigh: 99_000}))
      .toThrow(/OHLC/)
    expect(db.prepare('SELECT COUNT(*) AS n FROM bitcoin_order_flow_15m_bars').get())
      .toEqual({n: 0})
    db.close()
  })

  it('adds nullable price evidence columns to a legacy immutable bar table', () => {
    const db = new Database(':memory:')
    db.exec(`CREATE TABLE bitcoin_order_flow_15m_bars (
      bucket_start_ms INTEGER PRIMARY KEY,bucket_end_ms INTEGER NOT NULL UNIQUE,
      trade_count INTEGER NOT NULL,buy_volume REAL NOT NULL,sell_volume REAL NOT NULL,
      trade_imbalance_15m REAL,trade_imbalance_60m REAL,depth_imbalance_15m REAL,
      bid_depletion_per_second REAL NOT NULL,ask_depletion_per_second REAL NOT NULL,
      bid_replenishment_per_second REAL NOT NULL,ask_replenishment_per_second REAL NOT NULL,
      spread_median REAL,spread_p95 REAL,realized_volatility_60m REAL,message_count INTEGER NOT NULL,
      sequence_gap_count INTEGER NOT NULL,reconnect_count INTEGER NOT NULL,downtime_ms INTEGER NOT NULL,
      eligible INTEGER NOT NULL,quality_reason TEXT,created_at INTEGER NOT NULL)`)
    db.prepare(`INSERT INTO bitcoin_order_flow_15m_bars VALUES
      (1,900001,1,1,0,1,1,1,0,0,0,0,1,1,0,1,0,0,0,1,NULL,2)`).run()
    initBitcoinOrderFlowStore(db)
    expect(db.prepare('SELECT price_open,price_high,price_low,price_close FROM bitcoin_order_flow_15m_bars').get())
      .toEqual({price_open: null, price_high: null, price_low: null, price_close: null})
    db.close()
  })

  it('rolls back a malformed batch', () => {
    const db = database()
    expect(() => appendBitcoinMarketDataBatch(db, [{
      tradeId: 'valid', price: 100_000, size: 1, makerSide: 'BUY', aggressorSide: 'SELL',
      sourceTs: 1_800_000_000_001, receivedAt: 1_800_000_000_002,
      channelSequence: 1, eventKind: 'update',
    }, {
      tradeId: '../unsafe', price: 100_001, size: 1, makerSide: 'BUY', aggressorSide: 'SELL',
      sourceTs: 1_800_000_000_003, receivedAt: 1_800_000_000_004,
      channelSequence: 2, eventKind: 'update',
    }], [])).toThrow(/trade id/)
    expect(db.prepare('SELECT COUNT(*) AS count FROM bitcoin_order_flow_trades').get())
      .toEqual({count: 0})
  })
})
