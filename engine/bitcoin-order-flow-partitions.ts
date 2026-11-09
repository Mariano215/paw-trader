import Database from 'better-sqlite3'
import {mkdirSync, readdirSync} from 'node:fs'
import {basename, dirname, extname, join} from 'node:path'
import {
  appendBitcoinMarketDataBatch,
  initBitcoinOrderFlowRawStore,
  validateBitcoinMarketDataBatch,
  type AppendBitcoinMarketDataResult,
  type BitcoinL2UpdateRow,
  type BitcoinMarketTradeRow,
} from './bitcoin-order-flow-store.js'

export interface BitcoinMarketDataWriter {
  appendBatch(
    trades: BitcoinMarketTradeRow[],
    l2Updates: BitcoinL2UpdateRow[],
  ): AppendBitcoinMarketDataResult
  recentTradeIds(limit: number): string[]
  close(): void
}

export function bitcoinOrderFlowRawPartitionDir(catalogPath: string): string {
  const extension = extname(catalogPath)
  const stem = basename(catalogPath, extension)
  return join(dirname(catalogPath), `${stem}-raw`)
}

export function bitcoinOrderFlowUtcPartition(receivedAt: number): string {
  if (!Number.isSafeInteger(receivedAt) || receivedAt <= 0) {
    throw new Error('invalid partition receive timestamp')
  }
  const date = new Date(receivedAt)
  if (!Number.isFinite(date.getTime())) throw new Error('invalid partition receive timestamp')
  return date.toISOString().slice(0, 10)
}

interface PartitionBatch {
  trades: BitcoinMarketTradeRow[]
  l2Updates: BitcoinL2UpdateRow[]
}

/** Append-only UTC-day sharding for high-volume raw market observations. */
export class BitcoinOrderFlowPartitionedMarketDataStore implements BitcoinMarketDataWriter {
  private readonly databases = new Map<string, Database.Database>()

  constructor(private readonly partitionDir: string) {
    mkdirSync(partitionDir, {recursive: true})
  }

  recentTradeIds(limit: number): string[] {
    if (!Number.isSafeInteger(limit) || limit <= 0) return []
    const ids: string[] = []
    const files = readdirSync(this.partitionDir)
      .filter(name => /^\d{4}-\d{2}-\d{2}\.db$/.test(name))
      .sort()
      .reverse()
    for (const file of files) {
      const key = file.slice(0, -3)
      const remaining = limit - ids.length
      const rows = this.database(key).prepare(
        'SELECT trade_id FROM bitcoin_order_flow_trades ORDER BY seq DESC LIMIT ?',
      ).all(remaining) as Array<{trade_id: string}>
      ids.push(...rows.map(row => row.trade_id))
      if (ids.length >= limit) break
    }
    return ids
  }

  appendBatch(
    trades: BitcoinMarketTradeRow[],
    l2Updates: BitcoinL2UpdateRow[],
  ): AppendBitcoinMarketDataResult {
    validateBitcoinMarketDataBatch(trades, l2Updates)
    const partitions = new Map<string, PartitionBatch>()
    const batchFor = (receivedAt: number): PartitionBatch => {
      const key = bitcoinOrderFlowUtcPartition(receivedAt)
      let batch = partitions.get(key)
      if (!batch) {
        batch = {trades: [], l2Updates: []}
        partitions.set(key, batch)
      }
      return batch
    }
    for (const trade of trades) batchFor(trade.receivedAt).trades.push(trade)
    for (const update of l2Updates) batchFor(update.receivedAt).l2Updates.push(update)
    if (partitions.size > 1) throw new Error('market-data batch crosses UTC partition boundary')

    const result: AppendBitcoinMarketDataResult = {
      tradesInserted: 0,
      tradesDeduped: 0,
      l2UpdatesInserted: 0,
    }
    for (const [key, batch] of partitions) {
      const appended = appendBitcoinMarketDataBatch(this.database(key), batch.trades, batch.l2Updates)
      result.tradesInserted += appended.tradesInserted
      result.tradesDeduped += appended.tradesDeduped
      result.l2UpdatesInserted += appended.l2UpdatesInserted
    }
    return result
  }

  close(): void {
    for (const db of this.databases.values()) db.close()
    this.databases.clear()
  }

  private database(key: string): Database.Database {
    const existing = this.databases.get(key)
    if (existing) {
      this.databases.delete(key)
      this.databases.set(key, existing)
      return existing
    }
    if (this.databases.size >= 2) {
      const oldestKey = this.databases.keys().next().value as string | undefined
      if (oldestKey) {
        this.databases.get(oldestKey)?.close()
        this.databases.delete(oldestKey)
      }
    }
    const db = new Database(join(this.partitionDir, `${key}.db`))
    db.pragma('journal_mode = WAL')
    db.pragma('synchronous = NORMAL')
    db.pragma('busy_timeout = 5000')
    initBitcoinOrderFlowRawStore(db)
    this.databases.set(key, db)
    return db
  }
}

export class BitcoinOrderFlowSingleDatabaseMarketDataStore implements BitcoinMarketDataWriter {
  constructor(private readonly db: Database.Database) {}

  appendBatch(
    trades: BitcoinMarketTradeRow[],
    l2Updates: BitcoinL2UpdateRow[],
  ): AppendBitcoinMarketDataResult {
    return appendBitcoinMarketDataBatch(this.db, trades, l2Updates)
  }

  recentTradeIds(limit: number): string[] {
    if (!Number.isSafeInteger(limit) || limit <= 0) return []
    const rows = this.db.prepare(
      'SELECT trade_id FROM bitcoin_order_flow_trades ORDER BY seq DESC LIMIT ?',
    ).all(limit) as Array<{trade_id: string}>
    return rows.map(row => row.trade_id)
  }

  close(): void {}
}
