import {describe, expect, it} from 'vitest'
import {
  BitcoinOrderFlowBarBuilder,
  BITCOIN_ORDER_FLOW_BAR_MS,
  BITCOIN_ORDER_FLOW_REORDER_WINDOW_MS,
} from './bitcoin-order-flow-bars.js'
import type {BitcoinL2UpdateRow, BitcoinMarketTradeRow} from './bitcoin-order-flow-store.js'

const START = 1_800_000_000_000 - (1_800_000_000_000 % BITCOIN_ORDER_FLOW_BAR_MS)

function snapshot(ts: number): BitcoinL2UpdateRow[] {
  const updates: BitcoinL2UpdateRow[] = []
  for (let level = 0; level < 5; level += 1) {
    updates.push({side: 'bid', price: 99_999 - level, newQuantity: 2, sourceTs: ts,
      receivedAt: ts + 1, channelSequence: 1, eventKind: 'snapshot'})
    updates.push({side: 'offer', price: 100_001 + level, newQuantity: 2, sourceTs: ts,
      receivedAt: ts + 1, channelSequence: 1, eventKind: 'snapshot'})
  }
  return updates
}

function trade(ts: number, aggressorSide: 'BUY' | 'SELL', price = 100_000): BitcoinMarketTradeRow {
  return {tradeId: String(ts), price, size: 1, makerSide: aggressorSide === 'BUY' ? 'SELL' : 'BUY',
    aggressorSide, sourceTs: ts, receivedAt: ts + 1, channelSequence: 2, eventKind: 'update'}
}

describe('Bitcoin order-flow 15-minute bar builder', () => {
  it('computes frozen trade, depth, liquidity, spread, and volatility features', () => {
    const builder = new BitcoinOrderFlowBarBuilder(() => START + BITCOIN_ORDER_FLOW_BAR_MS + 1)
    builder.markConnected(START)
    builder.noteMessage(START)
    builder.ingestBookUpdates(snapshot(START))
    builder.ingestTrade(trade(START + 60_000, 'BUY', 100_000))
    builder.ingestTrade(trade(START + 120_000, 'BUY', 101_000))
    builder.ingestTrade(trade(START + 180_000, 'SELL', 100_500))
    builder.noteMessage(START + 450_000)
    builder.ingestBookUpdates([{
      side: 'bid', price: 99_999, newQuantity: 1, sourceTs: START + 450_000,
      receivedAt: START + 450_001, channelSequence: 3, eventKind: 'update',
    }, {
      side: 'offer', price: 100_001, newQuantity: 3, sourceTs: START + 450_000,
      receivedAt: START + 450_001, channelSequence: 3, eventKind: 'update',
    }])
    const bars = builder.flush(START + BITCOIN_ORDER_FLOW_BAR_MS)
    expect(bars).toHaveLength(1)
    expect(bars[0]).toMatchObject({
      tradeCount: 3,
      buyVolume: 2,
      sellVolume: 1,
      tradeImbalance15m: 1 / 3,
      tradeImbalance60m: 1 / 3,
      spreadMedian: 2,
      spreadP95: 2,
      priceOpen: 100_000,
      priceHigh: 101_000,
      priceLow: 100_000,
      priceClose: 100_500,
      eligible: true,
      qualityReason: null,
    })
    expect(bars[0].depthImbalance15m).not.toBeNull()
    expect(bars[0].bidDepletionPerSecond).toBeGreaterThan(0)
    expect(bars[0].askReplenishmentPerSecond).toBeGreaterThan(0)
    expect(bars[0].realizedVolatility60m).toBeGreaterThan(0)
  })

  it('invalidates partial, gapped, reconnected, and stale intervals explicitly', () => {
    const builder = new BitcoinOrderFlowBarBuilder(() => START + 2 * BITCOIN_ORDER_FLOW_BAR_MS)
    builder.markConnected(START + 10_000)
    builder.noteMessage(START + 10_000)
    builder.ingestBookUpdates(snapshot(START + 10_000))
    builder.ingestTrade(trade(START + 20_000, 'BUY'))
    builder.noteSequenceGap(START + 30_000, 2)
    builder.markDisconnected(START + 40_000)
    builder.markConnected(START + 100_000)
    const [bar] = builder.flush(START + BITCOIN_ORDER_FLOW_BAR_MS)
    expect(bar.eligible).toBe(false)
    expect(bar.sequenceGapCount).toBe(2)
    expect(bar.reconnectCount).toBe(1)
    expect(bar.downtimeMs).toBe(60_000)
    expect(bar.qualityReason).toContain('partial_start')
    expect(bar.qualityReason).toContain('sequence_gap')
    expect(bar.qualityReason).toContain('reconnect')
    expect(bar.qualityReason).toContain('downtime_over_5pct')
  })

  it('carries signed volume into the rolling 60-minute imbalance', () => {
    const builder = new BitcoinOrderFlowBarBuilder(() => START + 2 * BITCOIN_ORDER_FLOW_BAR_MS)
    builder.markConnected(START)
    builder.noteMessage(START)
    builder.ingestBookUpdates(snapshot(START))
    builder.ingestTrade(trade(START + 1, 'BUY'))
    builder.flush(START + BITCOIN_ORDER_FLOW_BAR_MS)
    builder.noteMessage(START + BITCOIN_ORDER_FLOW_BAR_MS + 1)
    builder.ingestTrade(trade(START + BITCOIN_ORDER_FLOW_BAR_MS + 1, 'SELL'))
    const [second] = builder.flush(START + 2 * BITCOIN_ORDER_FLOW_BAR_MS)
    expect(second.tradeImbalance15m).toBe(-1)
    expect(second.tradeImbalance60m).toBe(0)
  })

  it('reorders normal cross-channel batching jitter before deriving a bar', () => {
    const builder = new BitcoinOrderFlowBarBuilder(() => START + BITCOIN_ORDER_FLOW_BAR_MS + 1)
    builder.markConnected(START)
    builder.ingestFrame(START + 20_000, [], snapshot(START + 19_900))
    builder.ingestFrame(START + 21_000, [trade(START + 5_500, 'BUY')], [])
    const bars = builder.flushBuffered(
      START + BITCOIN_ORDER_FLOW_BAR_MS + BITCOIN_ORDER_FLOW_REORDER_WINDOW_MS,
    )
    expect(bars).toHaveLength(1)
    expect(bars[0]).toMatchObject({tradeCount: 1, eligible: true, qualityReason: null})
  })

  it('still rejects observations arriving beyond the reorder watermark', () => {
    const builder = new BitcoinOrderFlowBarBuilder(() => START + BITCOIN_ORDER_FLOW_BAR_MS + 1)
    builder.markConnected(START)
    builder.ingestFrame(START + 70_000, [], snapshot(START + 69_900))
    builder.flushBuffered(START + 130_000)
    builder.ingestFrame(START + 140_000, [trade(START + 1_000, 'BUY')], [])
    const [bar] = builder.flushBuffered(
      START + BITCOIN_ORDER_FLOW_BAR_MS + BITCOIN_ORDER_FLOW_REORDER_WINDOW_MS,
    )
    expect(bar.eligible).toBe(false)
    expect(bar.qualityReason).toContain('timestamp_reversal')
  })

  it('assigns a delayed pre-boundary trade to the bar it occurred in', () => {
    const builder = new BitcoinOrderFlowBarBuilder(() => START + BITCOIN_ORDER_FLOW_BAR_MS + 2_000)
    const end = START + BITCOIN_ORDER_FLOW_BAR_MS
    builder.markConnected(START)
    builder.ingestFrame(START + 1_000, [], snapshot(START + 900))
    builder.ingestFrame(end + 200, [], [])
    builder.ingestFrame(end + 300, [trade(end - 100, 'BUY')], [])
    const [completed] = builder.flushBuffered(end + BITCOIN_ORDER_FLOW_REORDER_WINDOW_MS + 300)
    expect(completed).toMatchObject({bucketEndMs: end, tradeCount: 1, eligible: true})
  })

  it('does not call first-snapshot transport latency a clock reversal', () => {
    const builder = new BitcoinOrderFlowBarBuilder(() => START + BITCOIN_ORDER_FLOW_BAR_MS + 1)
    builder.markConnected(START + 60_000)
    builder.ingestFrame(START + 60_100, [], snapshot(START + 59_000))
    builder.ingestFrame(START + 61_000, [trade(START + 58_500, 'BUY')], [])
    const [bar] = builder.flushBuffered(
      START + BITCOIN_ORDER_FLOW_BAR_MS + BITCOIN_ORDER_FLOW_REORDER_WINDOW_MS,
    )
    expect(bar.eligible).toBe(false)
    expect(bar.qualityReason).toBe('partial_start')
  })

  it('applies delayed L2 updates in receive order without treating event-time lag as reversal', () => {
    const builder = new BitcoinOrderFlowBarBuilder(() => START + BITCOIN_ORDER_FLOW_BAR_MS + 1)
    builder.markConnected(START)
    builder.ingestFrame(START + 200_000, [], snapshot(START + 5_000))
    builder.ingestFrame(START + 201_000, [], [{
      side: 'bid', price: 99_999, newQuantity: 1, sourceTs: START + 4_000,
      receivedAt: START + 201_000, channelSequence: 2, eventKind: 'update',
    }])
    builder.ingestFrame(START + 202_000, [trade(START + 201_500, 'BUY')], [])
    const [bar] = builder.flushBuffered(
      START + BITCOIN_ORDER_FLOW_BAR_MS + BITCOIN_ORDER_FLOW_REORDER_WINDOW_MS,
    )
    expect(bar).toMatchObject({tradeCount: 1, eligible: true, qualityReason: null})
  })
})
