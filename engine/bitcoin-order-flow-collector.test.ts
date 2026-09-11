import {EventEmitter} from 'node:events'
import {afterEach, describe, expect, it, vi} from 'vitest'
import Database from 'better-sqlite3'
import {
  BitcoinOrderFlowCollector,
  parseCoinbaseMarketDataMessage,
} from './bitcoin-order-flow-collector.js'
import {BitcoinOrderFlowBarBuilder} from './bitcoin-order-flow-bars.js'
import {initTraderTables} from './db.js'
import {appendBitcoinOrderFlowBar, initBitcoinOrderFlowStore} from './bitcoin-order-flow-store.js'

const NOW = 1_800_000_000_000

function message(channel: string, sequence: number, events: unknown[]): string {
  return JSON.stringify({channel, sequence_num: sequence, timestamp: new Date(NOW).toISOString(), events})
}

class FakeSocket extends EventEmitter {
  sent: string[] = []
  send(value: string): void { this.sent.push(value) }
  close(): void { this.emit('close', 1000) }
}

function databases(): {main: Database.Database; research: Database.Database} {
  const main = new Database(':memory:')
  initTraderTables(main)
  const research = new Database(':memory:')
  initBitcoinOrderFlowStore(research)
  return {main, research}
}

afterEach(() => vi.useRealTimers())

describe('Coinbase public market-data parser', () => {
  it('normalizes BTC trades and inverts maker side to aggressor side', () => {
    const parsed = parseCoinbaseMarketDataMessage(message('market_trades', 9, [{
      type: 'update', trades: [{trade_id: 't-1', product_id: 'BTC-USD', price: '100000',
        size: '0.25', side: 'SELL', time: new Date(NOW - 10).toISOString()}],
    }]), NOW)
    expect(parsed?.trades[0]).toMatchObject({
      tradeId: 't-1', price: 100_000, size: 0.25, makerSide: 'SELL', aggressorSide: 'BUY',
    })
  })

  it('normalizes Coinbase l2_data snapshots and replaces epoch event time', () => {
    const parsed = parseCoinbaseMarketDataMessage(message('l2_data', 10, [{
      type: 'snapshot', product_id: 'BTC-USD', updates: [{side: 'bid', price_level: '99999',
        new_quantity: '1.2', event_time: '1970-01-01T00:00:00Z'}],
    }]), NOW)
    expect(parsed?.channel).toBe('level2')
    expect(parsed?.l2Updates[0]).toMatchObject({price: 99_999, newQuantity: 1.2, sourceTs: NOW})
  })

  it.each([
    message('market_trades', 1, [{type: 'update', trades: [{trade_id: 't', product_id: 'ETH-USD', price: '1', size: '1', side: 'BUY', time: new Date(NOW).toISOString()}]}]),
    message('market_trades', 1, [{type: 'update', trades: [{trade_id: '../bad', product_id: 'BTC-USD', price: '1', size: '1', side: 'BUY', time: new Date(NOW).toISOString()}]}]),
    message('level2', 1, [{type: 'update', product_id: 'BTC-USD', updates: [{side: 'ask', price_level: '1', new_quantity: '1', event_time: new Date(NOW).toISOString()}]}]),
  ])('rejects out-of-scope or malformed known-channel payloads', raw => {
    expect(() => parseCoinbaseMarketDataMessage(raw, NOW)).toThrow()
  })

  it('ignores future Coinbase channel types without persisting them', () => {
    expect(parseCoinbaseMarketDataMessage(message('future_channel', 1, []), NOW)).toBeNull()
  })

  it('retains only the header of subscription acknowledgements for sequencing', () => {
    expect(parseCoinbaseMarketDataMessage(message('subscriptions', 3, [{subscriptions: {
      heartbeats: ['heartbeats'], market_trades: ['BTC-USD'],
    }}]), NOW)).toEqual({
      channel: 'subscriptions', sequence: 3, sourceTs: NOW,
      trades: [], l2Updates: [], heartbeatCounter: null,
    })
  })
})

describe('Bitcoin order-flow collector', () => {
  it('recomputes durable research progress from completed bars on construction', () => {
    vi.useFakeTimers()
    const {main, research} = databases()
    const declarationAt = NOW - 2 * 24 * 60 * 60 * 1000
    main.prepare(`INSERT INTO trader_strategies
      (id,name,asset_class,tier,status,params_json,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?)`).run(
        'order-flow-imbalance-crypto', 'Bitcoin Order-Flow Imbalance Research',
        'crypto', 0, 'paused', JSON.stringify({minimum_forward_days: 180}),
        declarationAt, declarationAt,
      )
    appendBitcoinOrderFlowBar(research, {
      bucketStartMs: NOW - 15 * 60 * 1000, bucketEndMs: NOW,
      tradeCount: 1, buyVolume: 1, sellVolume: 0,
      tradeImbalance15m: 1, tradeImbalance60m: 1, depthImbalance15m: 0,
      bidDepletionPerSecond: 0, askDepletionPerSecond: 0,
      bidReplenishmentPerSecond: 0, askReplenishmentPerSecond: 0,
      spreadMedian: 1, spreadP95: 1, realizedVolatility60m: 0,
      priceOpen: 100_000, priceHigh: 100_100, priceLow: 99_900, priceClose: 100_050,
      messageCount: 1, sequenceGapCount: 0, reconnectCount: 0,
      downtimeMs: 0, eligible: true, qualityReason: null, createdAt: NOW,
    })
    const collector = new BitcoinOrderFlowCollector(main, {researchDb: research, now: () => NOW})
    expect(collector.getStatus()).toMatchObject({
      declaration_at: declarationAt,
      collection_through_at: NOW,
      eligible_bars_total: 1,
      ineligible_bars_total: 0,
      collection_days_completed: 2,
      minimum_forward_days: 180,
      earliest_evaluation_at: declarationAt + 180 * 24 * 60 * 60 * 1000,
      collection_mature: false,
    })
    collector.stop()
  })

  it('uses local receive time rather than the independent envelope clock for bar progress', () => {
    vi.useFakeTimers()
    const {main, research} = databases()
    const ingestFrame = vi.spyOn(BitcoinOrderFlowBarBuilder.prototype, 'ingestFrame')
    const collector = new BitcoinOrderFlowCollector(main, {researchDb: research, now: () => NOW})
    const raw = JSON.stringify({
      channel: 'heartbeats', sequence_num: 1,
      timestamp: new Date(NOW + 30_000).toISOString(),
      events: [{heartbeat_counter: '1'}],
    })
    collector.ingestRawMessage(raw, NOW)
    expect(ingestFrame).toHaveBeenCalledWith(NOW, [], [], 0)
    collector.stop()
    ingestFrame.mockRestore()
  })

  it('subscribes only to public BTC-USD channels and persists status', () => {
    vi.useFakeTimers()
    const {main, research} = databases()
    const socket = new FakeSocket()
    const collector = new BitcoinOrderFlowCollector(main, {
      researchDb: research,
      now: () => NOW,
      createSocket: () => socket as never,
    })
    collector.start()
    socket.emit('open')
    expect(socket.sent.map(raw => JSON.parse(raw))).toEqual([
      {type: 'subscribe', channel: 'heartbeats'},
      {type: 'subscribe', product_ids: ['BTC-USD'], channel: 'market_trades'},
      {type: 'subscribe', product_ids: ['BTC-USD'], channel: 'level2'},
    ])
    expect(collector.getStatus()).toMatchObject({state: 'connected', product_id: 'BTC-USD'})
    const stored = JSON.parse((main.prepare("SELECT value FROM kv_settings WHERE key='trader.bitcoin_order_flow.collection'").get() as {value:string}).value)
    expect(stored.state).toBe('connected')
    collector.stop()
  })

  it('stores data, detects sequence gaps, and emits bounded operational facts', () => {
    vi.useFakeTimers()
    const {main, research} = databases()
    const collector = new BitcoinOrderFlowCollector(main, {researchDb: research, now: () => NOW})
    collector.ingestRawMessage(message('market_trades', 1, [{type: 'update', trades: [{
      trade_id: 't-1', product_id: 'BTC-USD', price: '100000', size: '1', side: 'SELL',
      time: new Date(NOW).toISOString(),
    }]}]))
    collector.ingestRawMessage(message('market_trades', 4, [{type: 'update', trades: [{
      trade_id: 't-2', product_id: 'BTC-USD', price: '100001', size: '1', side: 'BUY',
      time: new Date(NOW).toISOString(),
    }]}]))
    collector.flushBatch()
    expect(research.prepare('SELECT COUNT(*) AS count FROM bitcoin_order_flow_trades').get()).toEqual({count: 2})
    expect(collector.getStatus()).toMatchObject({trades_stored: 2, sequence_gap_count: 2})
    const event = main.prepare("SELECT metadata_json FROM trader_operational_events WHERE event_type='research.collector.sequence-gap'").get() as {metadata_json:string}
    expect(JSON.parse(event.metadata_json)).toEqual({channel: 'market_trades', gap_count: 2, sequence: 4})
    collector.stop()
  })

  it('tracks the interleaved connection sequence without false per-channel gaps', () => {
    vi.useFakeTimers()
    const {main, research} = databases()
    const collector = new BitcoinOrderFlowCollector(main, {researchDb: research, now: () => NOW})
    collector.ingestRawMessage(message('heartbeats', 1, [{heartbeat_counter: '1'}]))
    collector.ingestRawMessage(message('market_trades', 2, [{type: 'update', trades: [{
      trade_id: 'interleaved-1', product_id: 'BTC-USD', price: '100000', size: '1', side: 'SELL',
      time: new Date(NOW).toISOString(),
    }]}]))
    collector.ingestRawMessage(message('subscriptions', 3, [{subscriptions: {market_trades: ['BTC-USD']}}]))
    collector.ingestRawMessage(message('level2', 4, [{type: 'snapshot', product_id: 'BTC-USD', updates: [{
      side: 'bid', price_level: '99999', new_quantity: '1', event_time: new Date(NOW).toISOString(),
    }]}]))
    collector.ingestRawMessage(message('level2', 5, [{type: 'update', product_id: 'BTC-USD', updates: [{
      side: 'bid', price_level: '99999', new_quantity: '2', event_time: new Date(NOW).toISOString(),
    }]}]))
    collector.ingestRawMessage(message('subscriptions', 6, [{subscriptions: {level2: ['BTC-USD']}}]))
    collector.ingestRawMessage(message('level2', 7, [{type: 'update', product_id: 'BTC-USD', updates: [{
      side: 'bid', price_level: '99999', new_quantity: '3', event_time: new Date(NOW).toISOString(),
    }]}]))
    collector.flushBatch()
    expect(collector.getStatus().sequence_gap_count).toBe(0)
    expect(main.prepare("SELECT COUNT(*) AS count FROM trader_operational_events WHERE event_type='research.collector.sequence-gap'").get()).toEqual({count: 0})
    expect(research.prepare('SELECT COUNT(*) AS count FROM bitcoin_order_flow_trades').get()).toEqual({count: 1})
    collector.stop()
  })

  it('ignores duplicate or out-of-order connection frames', () => {
    vi.useFakeTimers()
    const {main, research} = databases()
    const collector = new BitcoinOrderFlowCollector(main, {researchDb: research, now: () => NOW})
    collector.ingestRawMessage(message('market_trades', 2, [{type: 'update', trades: [{
      trade_id: 'newer', product_id: 'BTC-USD', price: '100000', size: '1', side: 'SELL',
      time: new Date(NOW).toISOString(),
    }]}]))
    collector.ingestRawMessage(message('market_trades', 1, [{type: 'update', trades: [{
      trade_id: 'stale', product_id: 'BTC-USD', price: '99999', size: '1', side: 'BUY',
      time: new Date(NOW).toISOString(),
    }]}]))
    collector.flushBatch()
    expect(research.prepare('SELECT trade_id FROM bitcoin_order_flow_trades').all()).toEqual([{trade_id: 'newer'}])
    expect(collector.getStatus().sequence_gap_count).toBe(0)
    collector.stop()
  })

  it('deduplicates repeated trade IDs before feature derivation', () => {
    vi.useFakeTimers()
    const {main, research} = databases()
    const ingestFrame = vi.spyOn(BitcoinOrderFlowBarBuilder.prototype, 'ingestFrame')
    const collector = new BitcoinOrderFlowCollector(main, {researchDb: research, now: () => NOW})
    const repeatedTrade = {
      trade_id: 'repeated-1', product_id: 'BTC-USD', price: '100000', size: '1', side: 'SELL',
      time: new Date(NOW - 10_000).toISOString(),
    }
    collector.ingestRawMessage(message('market_trades', 1, [{type: 'snapshot', trades: [repeatedTrade]}]))
    collector.ingestRawMessage(message('market_trades', 2, [{type: 'update', trades: [repeatedTrade]}]))
    collector.flushBatch()
    expect(ingestFrame.mock.calls[0][1]).toHaveLength(1)
    expect(ingestFrame.mock.calls[1][1]).toHaveLength(0)
    expect(research.prepare('SELECT COUNT(*) AS count FROM bitcoin_order_flow_trades').get()).toEqual({count: 1})
    collector.stop()
    ingestFrame.mockRestore()
  })

  it('warms trade dedupe from immutable storage after a collector restart', () => {
    vi.useFakeTimers()
    const {main, research} = databases()
    const repeatedTrade = {
      trade_id: 'restart-replay-1', product_id: 'BTC-USD', price: '100000', size: '1', side: 'SELL',
      time: new Date(NOW - 10_000).toISOString(),
    }
    const first = new BitcoinOrderFlowCollector(main, {researchDb: research, now: () => NOW})
    first.ingestRawMessage(message('market_trades', 1, [{type: 'update', trades: [repeatedTrade]}]))
    first.flushBatch()
    first.stop()

    const ingestFrame = vi.spyOn(BitcoinOrderFlowBarBuilder.prototype, 'ingestFrame')
    const restarted = new BitcoinOrderFlowCollector(main, {researchDb: research, now: () => NOW})
    restarted.ingestRawMessage(message('market_trades', 1, [{type: 'snapshot', trades: [repeatedTrade]}]))
    restarted.flushBatch()
    expect(ingestFrame.mock.calls[0][1]).toHaveLength(0)
    expect(restarted.getStatus().trades_stored).toBe(0)
    expect(research.prepare('SELECT COUNT(*) AS count FROM bitcoin_order_flow_trades').get())
      .toEqual({count: 1})
    restarted.stop()
    ingestFrame.mockRestore()
  })

  it('flushes the prior UTC day before buffering the first new-day observation', () => {
    vi.useFakeTimers()
    const {main, research} = databases()
    const collector = new BitcoinOrderFlowCollector(main, {researchDb: research, now: () => NOW})
    const nowDate = new Date(NOW)
    const boundary = Date.UTC(
      nowDate.getUTCFullYear(), nowDate.getUTCMonth(), nowDate.getUTCDate() + 1,
    )
    const tradeMessage = (sequence: number, tradeId: string, timestamp: number) => JSON.stringify({
      channel: 'market_trades', sequence_num: sequence, timestamp: new Date(timestamp).toISOString(),
      events: [{type: 'update', trades: [{
        trade_id: tradeId, product_id: 'BTC-USD', price: '100000', size: '1', side: 'SELL',
        time: new Date(timestamp).toISOString(),
      }]}],
    })
    collector.ingestRawMessage(tradeMessage(1, 'before-midnight', boundary - 1), boundary - 1)
    expect(research.prepare('SELECT COUNT(*) AS count FROM bitcoin_order_flow_trades').get())
      .toEqual({count: 0})
    collector.ingestRawMessage(tradeMessage(2, 'after-midnight', boundary + 1), boundary + 1)
    expect(research.prepare('SELECT trade_id FROM bitcoin_order_flow_trades').all())
      .toEqual([{trade_id: 'before-midnight'}])
    collector.flushBatch()
    expect(research.prepare('SELECT trade_id FROM bitcoin_order_flow_trades ORDER BY seq').all())
      .toEqual([{trade_id: 'before-midnight'}, {trade_id: 'after-midnight'}])
    collector.stop()
  })

  it('rejects invalid input without logging or storing third-party text', () => {
    vi.useFakeTimers()
    const {main, research} = databases()
    const collector = new BitcoinOrderFlowCollector(main, {researchDb: research, now: () => NOW})
    collector.ingestRawMessage('{"channel":"market_trades","secret":"do-not-store"}')
    expect(collector.getStatus().rejected_messages).toBe(1)
    const event = main.prepare("SELECT metadata_json FROM trader_operational_events WHERE event_type='research.collector.message-rejected'").get() as {metadata_json:string}
    expect(event.metadata_json).not.toContain('do-not-store')
    expect(research.prepare('SELECT COUNT(*) AS count FROM bitcoin_order_flow_trades').get()).toEqual({count: 0})
    collector.stop()
  })

  it('retains a failed DB batch and persists it after storage recovers', () => {
    vi.useFakeTimers()
    const main = new Database(':memory:')
    initTraderTables(main)
    const research = new Database(':memory:')
    const collector = new BitcoinOrderFlowCollector(main, {researchDb: research, now: () => NOW})
    collector.ingestRawMessage(message('market_trades', 1, [{type: 'update', trades: [{
      trade_id: 'retry-1', product_id: 'BTC-USD', price: '100000', size: '1', side: 'SELL',
      time: new Date(NOW).toISOString(),
    }]}]))
    collector.flushBatch()
    expect(collector.getStatus()).toMatchObject({storage_error_count: 1, trades_stored: 0})
    initBitcoinOrderFlowStore(research)
    collector.flushBatch()
    expect(collector.getStatus().trades_stored).toBe(1)
    expect(research.prepare('SELECT trade_id FROM bitcoin_order_flow_trades').get()).toEqual({trade_id: 'retry-1'})
    collector.stop()
    main.close()
    research.close()
  })
})
