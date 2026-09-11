import Database from 'better-sqlite3'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { STORE_DIR } from '../config.js'

export const BITCOIN_ORDER_FLOW_DB_PATH = join(STORE_DIR, 'trader-research.db')

export interface BitcoinMarketTradeRow {
  tradeId: string
  price: number
  size: number
  makerSide: 'BUY' | 'SELL'
  aggressorSide: 'BUY' | 'SELL'
  sourceTs: number
  receivedAt: number
  channelSequence: number
  eventKind: 'snapshot' | 'update'
}

export interface BitcoinL2UpdateRow {
  side: 'bid' | 'offer'
  price: number
  newQuantity: number
  sourceTs: number
  receivedAt: number
  channelSequence: number
  eventKind: 'snapshot' | 'update'
}

export interface BitcoinOrderFlowBarRow {
  bucketStartMs: number
  bucketEndMs: number
  tradeCount: number
  buyVolume: number
  sellVolume: number
  tradeImbalance15m: number | null
  tradeImbalance60m: number | null
  depthImbalance15m: number | null
  bidDepletionPerSecond: number
  askDepletionPerSecond: number
  bidReplenishmentPerSecond: number
  askReplenishmentPerSecond: number
  spreadMedian: number | null
  spreadP95: number | null
  realizedVolatility60m: number | null
  /** Outcome/execution evidence only. These values are never strategy predictors. */
  priceOpen: number | null
  priceHigh: number | null
  priceLow: number | null
  priceClose: number | null
  messageCount: number
  sequenceGapCount: number
  reconnectCount: number
  downtimeMs: number
  eligible: boolean
  qualityReason: string | null
  createdAt: number
}

export interface AppendBitcoinMarketDataResult {
  tradesInserted: number
  tradesDeduped: number
  l2UpdatesInserted: number
}

export function initBitcoinOrderFlowRawStore(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS bitcoin_order_flow_trades (
      seq              INTEGER PRIMARY KEY AUTOINCREMENT,
      trade_id         TEXT NOT NULL UNIQUE CHECK(length(trade_id) BETWEEN 1 AND 128),
      product_id       TEXT NOT NULL CHECK(product_id = 'BTC-USD'),
      price            REAL NOT NULL CHECK(price > 0),
      size             REAL NOT NULL CHECK(size > 0),
      maker_side       TEXT NOT NULL CHECK(maker_side IN ('BUY', 'SELL')),
      aggressor_side   TEXT NOT NULL CHECK(aggressor_side IN ('BUY', 'SELL')),
      source_ts        INTEGER NOT NULL CHECK(source_ts > 0),
      received_at      INTEGER NOT NULL CHECK(received_at > 0),
      channel_sequence INTEGER NOT NULL CHECK(channel_sequence >= 0),
      event_kind       TEXT NOT NULL CHECK(event_kind IN ('snapshot', 'update'))
    );

    CREATE INDEX IF NOT EXISTS idx_bitcoin_order_flow_trades_time
      ON bitcoin_order_flow_trades(source_ts, seq);

    CREATE TABLE IF NOT EXISTS bitcoin_order_flow_l2_updates (
      seq              INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id       TEXT NOT NULL CHECK(product_id = 'BTC-USD'),
      side             TEXT NOT NULL CHECK(side IN ('bid', 'offer')),
      price            REAL NOT NULL CHECK(price > 0),
      new_quantity     REAL NOT NULL CHECK(new_quantity >= 0),
      source_ts        INTEGER NOT NULL CHECK(source_ts > 0),
      received_at      INTEGER NOT NULL CHECK(received_at > 0),
      channel_sequence INTEGER NOT NULL CHECK(channel_sequence >= 0),
      event_kind       TEXT NOT NULL CHECK(event_kind IN ('snapshot', 'update'))
    );

    CREATE INDEX IF NOT EXISTS idx_bitcoin_order_flow_l2_time
      ON bitcoin_order_flow_l2_updates(source_ts, seq);

    CREATE TRIGGER IF NOT EXISTS bitcoin_order_flow_trades_no_update
    BEFORE UPDATE ON bitcoin_order_flow_trades BEGIN
      SELECT RAISE(ABORT, 'bitcoin_order_flow_trades is append-only');
    END;
    CREATE TRIGGER IF NOT EXISTS bitcoin_order_flow_trades_no_delete
    BEFORE DELETE ON bitcoin_order_flow_trades BEGIN
      SELECT RAISE(ABORT, 'bitcoin_order_flow_trades is append-only');
    END;
    CREATE TRIGGER IF NOT EXISTS bitcoin_order_flow_l2_no_update
    BEFORE UPDATE ON bitcoin_order_flow_l2_updates BEGIN
      SELECT RAISE(ABORT, 'bitcoin_order_flow_l2_updates is append-only');
    END;
    CREATE TRIGGER IF NOT EXISTS bitcoin_order_flow_l2_no_delete
    BEFORE DELETE ON bitcoin_order_flow_l2_updates BEGIN
      SELECT RAISE(ABORT, 'bitcoin_order_flow_l2_updates is append-only');
    END;
  `)
}

export function initBitcoinOrderFlowBarStore(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS bitcoin_order_flow_15m_bars (
      bucket_start_ms             INTEGER PRIMARY KEY,
      bucket_end_ms               INTEGER NOT NULL UNIQUE,
      trade_count                 INTEGER NOT NULL CHECK(trade_count >= 0),
      buy_volume                  REAL NOT NULL CHECK(buy_volume >= 0),
      sell_volume                 REAL NOT NULL CHECK(sell_volume >= 0),
      trade_imbalance_15m         REAL,
      trade_imbalance_60m         REAL,
      depth_imbalance_15m         REAL,
      bid_depletion_per_second    REAL NOT NULL CHECK(bid_depletion_per_second >= 0),
      ask_depletion_per_second    REAL NOT NULL CHECK(ask_depletion_per_second >= 0),
      bid_replenishment_per_second REAL NOT NULL CHECK(bid_replenishment_per_second >= 0),
      ask_replenishment_per_second REAL NOT NULL CHECK(ask_replenishment_per_second >= 0),
      spread_median               REAL,
      spread_p95                  REAL,
      realized_volatility_60m     REAL,
      price_open                  REAL CHECK(price_open IS NULL OR price_open > 0),
      price_high                  REAL CHECK(price_high IS NULL OR price_high > 0),
      price_low                   REAL CHECK(price_low IS NULL OR price_low > 0),
      price_close                 REAL CHECK(price_close IS NULL OR price_close > 0),
      message_count               INTEGER NOT NULL CHECK(message_count >= 0),
      sequence_gap_count          INTEGER NOT NULL CHECK(sequence_gap_count >= 0),
      reconnect_count             INTEGER NOT NULL CHECK(reconnect_count >= 0),
      downtime_ms                 INTEGER NOT NULL CHECK(downtime_ms >= 0),
      eligible                    INTEGER NOT NULL CHECK(eligible IN (0, 1)),
      quality_reason              TEXT,
      created_at                  INTEGER NOT NULL CHECK(created_at > 0),
      CHECK(bucket_end_ms - bucket_start_ms = 900000)
    );

    CREATE INDEX IF NOT EXISTS idx_bitcoin_order_flow_bars_eligibility
      ON bitcoin_order_flow_15m_bars(eligible, bucket_start_ms);

    CREATE TABLE IF NOT EXISTS bitcoin_order_flow_evaluation_runs (
      id                    TEXT PRIMARY KEY CHECK(length(id) BETWEEN 1 AND 128),
      declaration_version   INTEGER NOT NULL UNIQUE CHECK(declaration_version > 0),
      declaration_at        INTEGER NOT NULL CHECK(declaration_at > 0),
      data_cutoff_at        INTEGER NOT NULL CHECK(data_cutoff_at >= declaration_at),
      contract_hash         TEXT NOT NULL CHECK(length(contract_hash) = 64),
      input_hash            TEXT NOT NULL CHECK(length(input_hash) = 64),
      status                TEXT NOT NULL CHECK(status IN ('rejected_pre_holdout','rejected','passed')),
      holdout_uses          INTEGER NOT NULL CHECK(holdout_uses IN (0, 1)),
      selected_variant_id   TEXT,
      selected_variant_json TEXT,
      development_json      TEXT NOT NULL,
      validation_json       TEXT NOT NULL,
      holdout_json          TEXT,
      sensitivity_json      TEXT,
      bootstrap_json        TEXT,
      criteria_json         TEXT NOT NULL,
      passed                INTEGER NOT NULL CHECK(passed IN (0, 1)),
      created_at            INTEGER NOT NULL CHECK(created_at > 0),
      CHECK((holdout_uses = 0 AND holdout_json IS NULL) OR
            (holdout_uses = 1 AND holdout_json IS NOT NULL)),
      CHECK((status = 'passed' AND passed = 1) OR
            (status != 'passed' AND passed = 0))
    );

    CREATE TRIGGER IF NOT EXISTS bitcoin_order_flow_bars_no_update
    BEFORE UPDATE ON bitcoin_order_flow_15m_bars BEGIN
      SELECT RAISE(ABORT, 'bitcoin_order_flow_15m_bars is append-only');
    END;
    CREATE TRIGGER IF NOT EXISTS bitcoin_order_flow_bars_no_delete
    BEFORE DELETE ON bitcoin_order_flow_15m_bars BEGIN
      SELECT RAISE(ABORT, 'bitcoin_order_flow_15m_bars is append-only');
    END;
    CREATE TRIGGER IF NOT EXISTS bitcoin_order_flow_evaluation_runs_no_update
    BEFORE UPDATE ON bitcoin_order_flow_evaluation_runs BEGIN
      SELECT RAISE(ABORT, 'bitcoin_order_flow_evaluation_runs is append-only');
    END;
    CREATE TRIGGER IF NOT EXISTS bitcoin_order_flow_evaluation_runs_no_delete
    BEFORE DELETE ON bitcoin_order_flow_evaluation_runs BEGIN
      SELECT RAISE(ABORT, 'bitcoin_order_flow_evaluation_runs is append-only');
    END;
  `)

  // Existing forward-collection catalogs predate outcome-price persistence.
  // Add nullable evidence columns without mutating any immutable bar row.
  const columns = new Set((db.prepare('PRAGMA table_info(bitcoin_order_flow_15m_bars)').all() as Array<{name: string}>)
    .map(column => column.name))
  for (const [name, definition] of [
    ['price_open', 'REAL CHECK(price_open IS NULL OR price_open > 0)'],
    ['price_high', 'REAL CHECK(price_high IS NULL OR price_high > 0)'],
    ['price_low', 'REAL CHECK(price_low IS NULL OR price_low > 0)'],
    ['price_close', 'REAL CHECK(price_close IS NULL OR price_close > 0)'],
  ] as const) {
    if (!columns.has(name)) db.exec(`ALTER TABLE bitcoin_order_flow_15m_bars ADD COLUMN ${name} ${definition}`)
  }
}

export function initBitcoinOrderFlowStore(db: Database.Database): void {
  initBitcoinOrderFlowRawStore(db)
  initBitcoinOrderFlowBarStore(db)
}

export function openBitcoinOrderFlowStore(
  dbPath: string = process.env.TRADER_RESEARCH_DB_PATH || BITCOIN_ORDER_FLOW_DB_PATH,
): Database.Database {
  mkdirSync(dirname(dbPath), {recursive: true})
  const db = new Database(dbPath)
  db.pragma('journal_mode = WAL')
  db.pragma('synchronous = NORMAL')
  db.pragma('busy_timeout = 5000')
  initBitcoinOrderFlowStore(db)
  return db
}

function validFinite(value: number, minimum: number, field: string): void {
  if (!Number.isFinite(value) || value < minimum) throw new Error(`invalid ${field}`)
}

export function validateBitcoinMarketDataBatch(
  trades: BitcoinMarketTradeRow[],
  l2Updates: BitcoinL2UpdateRow[],
): void {
  for (const trade of trades) {
    if (!/^[A-Za-z0-9._:-]{1,128}$/.test(trade.tradeId)) throw new Error('invalid trade id')
    validFinite(trade.price, Number.MIN_VALUE, 'trade price')
    validFinite(trade.size, Number.MIN_VALUE, 'trade size')
    if (!Number.isSafeInteger(trade.sourceTs) || trade.sourceTs <= 0 ||
        !Number.isSafeInteger(trade.receivedAt) || trade.receivedAt <= 0 ||
        !Number.isSafeInteger(trade.channelSequence) || trade.channelSequence < 0) {
      throw new Error('invalid trade timestamp or sequence')
    }
  }
  for (const update of l2Updates) {
    validFinite(update.price, Number.MIN_VALUE, 'book price')
    validFinite(update.newQuantity, 0, 'book quantity')
    if (!Number.isSafeInteger(update.sourceTs) || update.sourceTs <= 0 ||
        !Number.isSafeInteger(update.receivedAt) || update.receivedAt <= 0 ||
        !Number.isSafeInteger(update.channelSequence) || update.channelSequence < 0) {
      throw new Error('invalid book timestamp or sequence')
    }
  }
}

export function appendBitcoinMarketDataBatch(
  db: Database.Database,
  trades: BitcoinMarketTradeRow[],
  l2Updates: BitcoinL2UpdateRow[],
): AppendBitcoinMarketDataResult {
  validateBitcoinMarketDataBatch(trades, l2Updates)
  const insertTrade = db.prepare(`INSERT OR IGNORE INTO bitcoin_order_flow_trades
    (trade_id,product_id,price,size,maker_side,aggressor_side,source_ts,received_at,channel_sequence,event_kind)
    VALUES (?,'BTC-USD',?,?,?,?,?,?,?,?)`)
  const insertL2 = db.prepare(`INSERT INTO bitcoin_order_flow_l2_updates
    (product_id,side,price,new_quantity,source_ts,received_at,channel_sequence,event_kind)
    VALUES ('BTC-USD',?,?,?,?,?,?,?)`)

  return db.transaction(() => {
    let tradesInserted = 0
    let l2UpdatesInserted = 0
    for (const trade of trades) {
      tradesInserted += insertTrade.run(
        trade.tradeId, trade.price, trade.size, trade.makerSide, trade.aggressorSide,
        trade.sourceTs, trade.receivedAt, trade.channelSequence, trade.eventKind,
      ).changes
    }
    for (const update of l2Updates) {
      l2UpdatesInserted += insertL2.run(
        update.side, update.price, update.newQuantity, update.sourceTs,
        update.receivedAt, update.channelSequence, update.eventKind,
      ).changes
    }
    return {
      tradesInserted,
      tradesDeduped: trades.length - tradesInserted,
      l2UpdatesInserted,
    }
  })()
}

export function appendBitcoinOrderFlowBar(db: Database.Database, bar: BitcoinOrderFlowBarRow): boolean {
  const prices = [bar.priceOpen, bar.priceHigh, bar.priceLow, bar.priceClose]
  const allNull = prices.every(value => value === null)
  const allFinite = prices.every(value => value !== null && Number.isFinite(value) && value > 0)
  if (!allNull && !allFinite) throw new Error('Bitcoin order-flow bar price evidence must be complete or absent')
  if (allFinite && (bar.priceHigh! < Math.max(bar.priceOpen!, bar.priceClose!) ||
      bar.priceLow! > Math.min(bar.priceOpen!, bar.priceClose!) || bar.priceHigh! < bar.priceLow!)) {
    throw new Error('invalid Bitcoin order-flow bar OHLC')
  }
  const result = db.prepare(`INSERT OR IGNORE INTO bitcoin_order_flow_15m_bars
    (bucket_start_ms,bucket_end_ms,trade_count,buy_volume,sell_volume,
     trade_imbalance_15m,trade_imbalance_60m,depth_imbalance_15m,
     bid_depletion_per_second,ask_depletion_per_second,
     bid_replenishment_per_second,ask_replenishment_per_second,
     spread_median,spread_p95,realized_volatility_60m,
     price_open,price_high,price_low,price_close,message_count,
     sequence_gap_count,reconnect_count,downtime_ms,eligible,quality_reason,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      bar.bucketStartMs, bar.bucketEndMs, bar.tradeCount, bar.buyVolume, bar.sellVolume,
      bar.tradeImbalance15m, bar.tradeImbalance60m, bar.depthImbalance15m,
      bar.bidDepletionPerSecond, bar.askDepletionPerSecond,
      bar.bidReplenishmentPerSecond, bar.askReplenishmentPerSecond,
      bar.spreadMedian, bar.spreadP95, bar.realizedVolatility60m,
      bar.priceOpen, bar.priceHigh, bar.priceLow, bar.priceClose, bar.messageCount,
      bar.sequenceGapCount, bar.reconnectCount, bar.downtimeMs, bar.eligible ? 1 : 0,
      bar.qualityReason, bar.createdAt,
    )
  return result.changes === 1
}
