import {mkdtempSync, readdirSync, rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import Database from 'better-sqlite3'
import {afterEach, describe, expect, it} from 'vitest'
import {
  bitcoinOrderFlowRawPartitionDir,
  bitcoinOrderFlowUtcPartition,
  BitcoinOrderFlowPartitionedMarketDataStore,
} from './bitcoin-order-flow-partitions.js'

const directories: string[] = []

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, {recursive: true, force: true})
})

describe('Bitcoin order-flow raw partitions', () => {
  it('derives a sibling raw directory and UTC partition key', () => {
    expect(bitcoinOrderFlowRawPartitionDir('/store/trader-research.db'))
      .toBe('/store/trader-research-raw')
    expect(bitcoinOrderFlowUtcPartition(Date.UTC(2026, 8, 10, 23, 59, 59)))
      .toBe('2026-09-10')
  })

  it('writes validated observations to append-only UTC-day shards', () => {
    const directory = mkdtempSync(join(tmpdir(), 'btc-partitions-'))
    directories.push(directory)
    const writer = new BitcoinOrderFlowPartitionedMarketDataStore(directory)
    const dayOne = Date.UTC(2026, 8, 10, 23, 59, 59)
    const dayTwo = Date.UTC(2026, 8, 11, 0, 0, 1)
    expect(writer.appendBatch([{
      tradeId: 'trade-1', price: 100_000, size: 0.01,
      makerSide: 'SELL', aggressorSide: 'BUY', sourceTs: dayOne, receivedAt: dayOne,
      channelSequence: 1, eventKind: 'update',
    }], [])).toEqual({tradesInserted: 1, tradesDeduped: 0, l2UpdatesInserted: 0})
    expect(writer.appendBatch([], [{
      side: 'bid', price: 99_999, newQuantity: 1, sourceTs: dayTwo, receivedAt: dayTwo,
      channelSequence: 2, eventKind: 'update',
    }])).toEqual({tradesInserted: 0, tradesDeduped: 0, l2UpdatesInserted: 1})
    writer.close()

    expect(readdirSync(directory).filter(name => name.endsWith('.db')).sort())
      .toEqual(['2026-09-10.db', '2026-09-11.db'])
    const first = new Database(join(directory, '2026-09-10.db'))
    const second = new Database(join(directory, '2026-09-11.db'))
    expect(first.prepare('SELECT trade_id FROM bitcoin_order_flow_trades').get())
      .toEqual({trade_id: 'trade-1'})
    expect(second.prepare('SELECT COUNT(*) AS count FROM bitcoin_order_flow_l2_updates').get())
      .toEqual({count: 1})
    expect(() => second.prepare('DELETE FROM bitcoin_order_flow_l2_updates').run()).toThrow(/append-only/)
    first.close()
    second.close()

    const reopened = new BitcoinOrderFlowPartitionedMarketDataStore(directory)
    expect(reopened.recentTradeIds(10)).toEqual(['trade-1'])
    reopened.close()
  })

  it('validates the whole batch before creating or writing a shard', () => {
    const directory = mkdtempSync(join(tmpdir(), 'btc-partitions-'))
    directories.push(directory)
    const writer = new BitcoinOrderFlowPartitionedMarketDataStore(directory)
    expect(() => writer.appendBatch([{
      tradeId: '../unsafe', price: 100_000, size: 0.01,
      makerSide: 'SELL', aggressorSide: 'BUY', sourceTs: 1, receivedAt: 1,
      channelSequence: 1, eventKind: 'update',
    }], [])).toThrow(/trade id/)
    expect(readdirSync(directory)).toEqual([])
    writer.close()
  })

  it('rejects a cross-day batch so retry cannot duplicate a committed L2 partition', () => {
    const directory = mkdtempSync(join(tmpdir(), 'btc-partitions-'))
    directories.push(directory)
    const writer = new BitcoinOrderFlowPartitionedMarketDataStore(directory)
    const first = Date.UTC(2026, 8, 10, 23, 59, 59)
    const second = Date.UTC(2026, 8, 11, 0, 0, 1)
    expect(() => writer.appendBatch([], [first, second].map((receivedAt, index) => ({
      side: 'bid' as const, price: 99_999 + index, newQuantity: 1,
      sourceTs: receivedAt, receivedAt, channelSequence: index + 1,
      eventKind: 'update' as const,
    })))).toThrow(/crosses UTC partition/)
    expect(readdirSync(directory)).toEqual([])
    writer.close()
  })
})
