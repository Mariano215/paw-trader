import type {BitcoinL2UpdateRow, BitcoinMarketTradeRow, BitcoinOrderFlowBarRow} from './bitcoin-order-flow-store.js'

export const BITCOIN_ORDER_FLOW_BAR_MS = 15 * 60 * 1000
export const BITCOIN_ORDER_FLOW_REORDER_WINDOW_MS = 60_000
const REALIZED_VOLATILITY_WINDOW_MS = 60 * 60 * 1000
const MINUTE_MS = 60 * 1000

interface BarAccumulator {
  bucketStartMs: number
  buyVolume: number
  sellVolume: number
  tradeCount: number
  messageCount: number
  sequenceGapCount: number
  reconnectCount: number
  downtimeMs: number
  depthWeighted: number
  bookObservedMs: number
  bidDepletion: number
  askDepletion: number
  bidReplenishment: number
  askReplenishment: number
  spreads: number[]
  priceOpen: number | null
  priceHigh: number | null
  priceLow: number | null
  priceClose: number | null
  quality: Set<string>
}

type BufferedObservation =
  | {kind: 'trade'; sourceTs: number; order: number; trade: BitcoinMarketTradeRow}
  | {kind: 'book'; sourceTs: number; order: number; updates: BitcoinL2UpdateRow[]}
  | {kind: 'message'; sourceTs: number; order: number}
  | {kind: 'gap'; sourceTs: number; order: number; missingCount: number}

function bucketStart(ts: number): number {
  return Math.floor(ts / BITCOIN_ORDER_FLOW_BAR_MS) * BITCOIN_ORDER_FLOW_BAR_MS
}

function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))
  return sorted[index]
}

function imbalance(buy: number, sell: number): number | null {
  const total = buy + sell
  return total > 0 ? (buy - sell) / total : null
}

function accumulator(start: number, partial: boolean): BarAccumulator {
  return {
    bucketStartMs: start,
    buyVolume: 0,
    sellVolume: 0,
    tradeCount: 0,
    messageCount: 0,
    sequenceGapCount: 0,
    reconnectCount: 0,
    downtimeMs: 0,
    depthWeighted: 0,
    bookObservedMs: 0,
    bidDepletion: 0,
    askDepletion: 0,
    bidReplenishment: 0,
    askReplenishment: 0,
    spreads: [],
    priceOpen: null,
    priceHigh: null,
    priceLow: null,
    priceClose: null,
    quality: new Set(partial ? ['partial_start'] : []),
  }
}

export class BitcoinOrderFlowBarBuilder {
  private readonly bids = new Map<number, number>()
  private readonly asks = new Map<number, number>()
  private readonly minuteCloses = new Map<number, number>()
  private readonly recentVolumes: Array<{buy: number; sell: number}> = []
  private current: BarAccumulator | null = null
  private lastClockMs: number | null = null
  private currentDepthImbalance: number | null = null
  private connected = false
  private hasConnected = false
  private buffered: BufferedObservation[] = []
  private bufferedOrder = 0
  private maxBufferedSourceTs = 0

  constructor(private readonly now: () => number = Date.now) {}

  markConnected(atMs: number): BitcoinOrderFlowBarRow[] {
    if (!this.hasConnected && !this.current) {
      this.connected = true
      this.hasConnected = true
      this.ensureCurrent(atMs, atMs % BITCOIN_ORDER_FLOW_BAR_MS !== 0)
      // The first public snapshot can carry a source timestamp slightly before
      // socket-open time. Begin the already-ineligible partial interval at its
      // bucket boundary so transport latency is not mislabeled as reversal.
      this.lastClockMs = bucketStart(atMs)
      return []
    }
    const completed = this.drainBuffered(atMs)
    if (this.hasConnected && this.current) {
      this.current.reconnectCount += 1
      this.current.quality.add('reconnect')
    }
    this.connected = true
    this.hasConnected = true
    this.ensureCurrent(atMs, atMs % BITCOIN_ORDER_FLOW_BAR_MS !== 0)
    return completed
  }

  markDisconnected(atMs: number): BitcoinOrderFlowBarRow[] {
    // Everything already received belongs before the disconnect boundary.
    const completed = this.drainBuffered(atMs)
    this.connected = false
    if (this.current) this.current.quality.add('disconnect')
    return completed
  }

  noteMessage(atMs: number): BitcoinOrderFlowBarRow[] {
    const completed = this.advanceTo(atMs)
    if (this.current) this.current.messageCount += 1
    return completed
  }

  noteSequenceGap(atMs: number, missingCount: number): BitcoinOrderFlowBarRow[] {
    const completed = this.advanceTo(atMs)
    if (this.current) {
      this.current.sequenceGapCount += Math.max(1, Math.floor(missingCount))
      this.current.quality.add('sequence_gap')
    }
    return completed
  }

  ingestTrade(trade: BitcoinMarketTradeRow): BitcoinOrderFlowBarRow[] {
    const completed = this.advanceTo(trade.sourceTs)
    if (!this.current) return completed
    this.current.tradeCount += 1
    this.current.priceOpen ??= trade.price
    this.current.priceHigh = this.current.priceHigh === null
      ? trade.price : Math.max(this.current.priceHigh, trade.price)
    this.current.priceLow = this.current.priceLow === null
      ? trade.price : Math.min(this.current.priceLow, trade.price)
    this.current.priceClose = trade.price
    if (trade.aggressorSide === 'BUY') this.current.buyVolume += trade.size
    else this.current.sellVolume += trade.size
    this.minuteCloses.set(bucketStartForMinute(trade.sourceTs), trade.price)
    return completed
  }

  ingestBookUpdates(
    updates: BitcoinL2UpdateRow[],
    observedAtMs = updates.length > 0 ? Math.max(...updates.map(update => update.sourceTs)) : 0,
  ): BitcoinOrderFlowBarRow[] {
    if (updates.length === 0) return []
    const completed = this.advanceTo(observedAtMs)
    if (!this.current) return completed
    if (updates.some(update => update.eventKind === 'snapshot')) {
      this.bids.clear()
      this.asks.clear()
    }
    for (const update of updates) {
      const side = update.side === 'bid' ? this.bids : this.asks
      const prior = side.get(update.price) ?? 0
      if (update.newQuantity === 0) side.delete(update.price)
      else side.set(update.price, update.newQuantity)
      if (update.eventKind !== 'snapshot') {
        const delta = update.newQuantity - prior
        if (delta < 0) {
          if (update.side === 'bid') this.current.bidDepletion += -delta
          else this.current.askDepletion += -delta
        } else if (delta > 0) {
          if (update.side === 'bid') this.current.bidReplenishment += delta
          else this.current.askReplenishment += delta
        }
      }
    }
    this.updateBookMetric()
    return completed
  }

  /**
   * Queues one connection frame for safe ordering. Trades retain exchange
   * event time. L2 state transitions retain socket receive/sequence order:
   * Coinbase L2 event_time can lag or reverse while delivery order remains the
   * authoritative order-book contract.
   */
  ingestFrame(
    receivedAt: number,
    trades: BitcoinMarketTradeRow[],
    l2Updates: BitcoinL2UpdateRow[],
    missingCount = 0,
    countMessage = true,
  ): BitcoinOrderFlowBarRow[] {
    for (const trade of trades) {
      this.enqueue({kind: 'trade', sourceTs: trade.sourceTs, order: this.bufferedOrder++, trade})
    }
    const bookGroups = new Map<string, BitcoinL2UpdateRow[]>()
    for (const update of l2Updates) {
      const key = `${update.sourceTs}:${update.eventKind}`
      const group = bookGroups.get(key)
      if (group) group.push(update)
      else bookGroups.set(key, [update])
    }
    for (const updates of bookGroups.values()) {
      this.enqueue({kind: 'book', sourceTs: receivedAt, order: this.bufferedOrder++, updates})
    }
    if (missingCount > 0) {
      this.enqueue({kind: 'gap', sourceTs: receivedAt, order: this.bufferedOrder++, missingCount})
    }
    if (countMessage) {
      this.enqueue({kind: 'message', sourceTs: receivedAt, order: this.bufferedOrder++})
    }
    return this.drainBuffered(this.maxBufferedSourceTs - BITCOIN_ORDER_FLOW_REORDER_WINDOW_MS)
  }

  /** Advances only through the safe source-time watermark. */
  flushBuffered(atMs: number): BitcoinOrderFlowBarRow[] {
    this.maxBufferedSourceTs = Math.max(this.maxBufferedSourceTs, atMs)
    return this.drainBuffered(atMs - BITCOIN_ORDER_FLOW_REORDER_WINDOW_MS)
  }

  flush(atMs: number): BitcoinOrderFlowBarRow[] {
    return this.advanceTo(atMs)
  }

  private enqueue(observation: BufferedObservation): void {
    this.buffered.push(observation)
    this.maxBufferedSourceTs = Math.max(this.maxBufferedSourceTs, observation.sourceTs)
  }

  private drainBuffered(watermarkMs: number): BitcoinOrderFlowBarRow[] {
    if (!Number.isSafeInteger(watermarkMs) || watermarkMs <= 0) return []
    this.buffered.sort((a, b) => a.sourceTs - b.sourceTs || a.order - b.order)
    const completed: BitcoinOrderFlowBarRow[] = []
    let consumed = 0
    while (consumed < this.buffered.length && this.buffered[consumed].sourceTs <= watermarkMs) {
      const observation = this.buffered[consumed]
      if (observation.kind === 'trade') completed.push(...this.ingestTrade(observation.trade))
      else if (observation.kind === 'book') {
        completed.push(...this.ingestBookUpdates(observation.updates, observation.sourceTs))
      }
      else if (observation.kind === 'gap') completed.push(...this.noteSequenceGap(observation.sourceTs, observation.missingCount))
      else completed.push(...this.noteMessage(observation.sourceTs))
      consumed += 1
    }
    if (consumed > 0) this.buffered.splice(0, consumed)
    if (this.lastClockMs === null || watermarkMs >= this.lastClockMs) {
      completed.push(...this.advanceTo(watermarkMs))
    }
    return completed
  }

  private ensureCurrent(atMs: number, partial = true): void {
    if (this.current) return
    const start = bucketStart(atMs)
    this.current = accumulator(start, partial || atMs !== start)
    this.lastClockMs = atMs
  }

  private advanceTo(rawTs: number): BitcoinOrderFlowBarRow[] {
    if (!Number.isSafeInteger(rawTs) || rawTs <= 0) return []
    this.ensureCurrent(rawTs)
    if (!this.current || this.lastClockMs === null) return []
    let ts = rawTs
    if (ts < this.lastClockMs) {
      this.current.quality.add('timestamp_reversal')
      ts = this.lastClockMs
    }
    const completed: BitcoinOrderFlowBarRow[] = []
    while (this.current && ts >= this.current.bucketStartMs + BITCOIN_ORDER_FLOW_BAR_MS) {
      const end = this.current.bucketStartMs + BITCOIN_ORDER_FLOW_BAR_MS
      this.accrueUntil(end)
      completed.push(this.finalizeCurrent(end))
      this.current = accumulator(end, false)
      if (!this.connected) this.current.quality.add('disconnect')
      this.lastClockMs = end
    }
    this.accrueUntil(ts)
    return completed
  }

  private accrueUntil(ts: number): void {
    if (!this.current || this.lastClockMs === null || ts <= this.lastClockMs) return
    const delta = ts - this.lastClockMs
    if (!this.connected) {
      this.current.downtimeMs += delta
      this.current.quality.add('disconnect')
    } else if (this.currentDepthImbalance !== null) {
      this.current.depthWeighted += this.currentDepthImbalance * delta
      this.current.bookObservedMs += delta
    }
    this.lastClockMs = ts
  }

  private updateBookMetric(): void {
    if (!this.current) return
    const bids = [...this.bids.entries()].sort((a, b) => b[0] - a[0]).slice(0, 5)
    const asks = [...this.asks.entries()].sort((a, b) => a[0] - b[0]).slice(0, 5)
    if (bids.length < 5 || asks.length < 5) {
      this.current.quality.add('missing_book_levels')
      this.currentDepthImbalance = null
      return
    }
    const bestBid = bids[0][0]
    const bestAsk = asks[0][0]
    if (bestBid >= bestAsk) {
      this.current.quality.add('crossed_book')
      this.currentDepthImbalance = null
      return
    }
    const bidDepth = bids.reduce((sum, entry) => sum + entry[1], 0)
    const askDepth = asks.reduce((sum, entry) => sum + entry[1], 0)
    const totalDepth = bidDepth + askDepth
    this.currentDepthImbalance = totalDepth > 0 ? (bidDepth - askDepth) / totalDepth : null
    this.current.spreads.push(bestAsk - bestBid)
  }

  private finalizeCurrent(end: number): BitcoinOrderFlowBarRow {
    const value = this.current!
    const recent = [...this.recentVolumes.slice(-3), {buy: value.buyVolume, sell: value.sellVolume}]
    const buy60 = recent.reduce((sum, row) => sum + row.buy, 0)
    const sell60 = recent.reduce((sum, row) => sum + row.sell, 0)
    const quality = new Set(value.quality)
    if (value.messageCount === 0) quality.add('no_messages')
    if (value.tradeCount === 0) quality.add('no_trades')
    if (value.bookObservedMs === 0) quality.add('no_valid_book')
    if (value.downtimeMs > BITCOIN_ORDER_FLOW_BAR_MS * 0.05) quality.add('downtime_over_5pct')
    const observedSeconds = Math.max(1, (BITCOIN_ORDER_FLOW_BAR_MS - value.downtimeMs) / 1000)
    const bar: BitcoinOrderFlowBarRow = {
      bucketStartMs: value.bucketStartMs,
      bucketEndMs: end,
      tradeCount: value.tradeCount,
      buyVolume: value.buyVolume,
      sellVolume: value.sellVolume,
      tradeImbalance15m: imbalance(value.buyVolume, value.sellVolume),
      tradeImbalance60m: imbalance(buy60, sell60),
      depthImbalance15m: value.bookObservedMs > 0 ? value.depthWeighted / value.bookObservedMs : null,
      bidDepletionPerSecond: value.bidDepletion / observedSeconds,
      askDepletionPerSecond: value.askDepletion / observedSeconds,
      bidReplenishmentPerSecond: value.bidReplenishment / observedSeconds,
      askReplenishmentPerSecond: value.askReplenishment / observedSeconds,
      spreadMedian: percentile(value.spreads, 0.5),
      spreadP95: percentile(value.spreads, 0.95),
      realizedVolatility60m: this.realizedVolatility(end),
      priceOpen: value.priceOpen,
      priceHigh: value.priceHigh,
      priceLow: value.priceLow,
      priceClose: value.priceClose,
      messageCount: value.messageCount,
      sequenceGapCount: value.sequenceGapCount,
      reconnectCount: value.reconnectCount,
      downtimeMs: value.downtimeMs,
      eligible: quality.size === 0,
      qualityReason: quality.size > 0 ? [...quality].sort().join(',') : null,
      createdAt: this.now(),
    }
    this.recentVolumes.push({buy: value.buyVolume, sell: value.sellVolume})
    if (this.recentVolumes.length > 3) this.recentVolumes.shift()
    for (const minute of this.minuteCloses.keys()) {
      if (minute < end - 2 * REALIZED_VOLATILITY_WINDOW_MS) this.minuteCloses.delete(minute)
    }
    return bar
  }

  private realizedVolatility(end: number): number | null {
    const prices = [...this.minuteCloses.entries()]
      .filter(([minute]) => minute >= end - REALIZED_VOLATILITY_WINDOW_MS && minute < end)
      .sort((a, b) => a[0] - b[0])
      .map(([, price]) => price)
    if (prices.length < 2) return null
    let squaredReturns = 0
    for (let i = 1; i < prices.length; i += 1) {
      const value = Math.log(prices[i] / prices[i - 1])
      squaredReturns += value * value
    }
    return Math.sqrt(squaredReturns)
  }
}

function bucketStartForMinute(ts: number): number {
  return Math.floor(ts / MINUTE_MS) * MINUTE_MS
}
