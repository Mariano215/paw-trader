import WebSocket, {type RawData} from 'ws'
import type Database from 'better-sqlite3'
import {logger} from '../logger.js'
import {recordTraderOperationalEvent} from './operational-events.js'
import {BitcoinOrderFlowBarBuilder} from './bitcoin-order-flow-bars.js'
import {getBitcoinOrderFlowResearchProgress} from './bitcoin-order-flow-progress.js'
import {maybeRunBitcoinOrderFlowEvaluation} from './bitcoin-order-flow-evaluation.js'
import {
  bitcoinOrderFlowRawPartitionDir,
  BitcoinOrderFlowPartitionedMarketDataStore,
  BitcoinOrderFlowSingleDatabaseMarketDataStore,
  type BitcoinMarketDataWriter,
} from './bitcoin-order-flow-partitions.js'
import {
  appendBitcoinOrderFlowBar,
  BITCOIN_ORDER_FLOW_DB_PATH,
  openBitcoinOrderFlowStore,
  type BitcoinL2UpdateRow,
  type BitcoinMarketTradeRow,
  type BitcoinOrderFlowBarRow,
} from './bitcoin-order-flow-store.js'

export const COINBASE_PUBLIC_MARKET_DATA_URL = 'wss://advanced-trade-ws.coinbase.com'
export const BITCOIN_ORDER_FLOW_STATUS_KEY = 'trader.bitcoin_order_flow.collection'
const PRODUCT_ID = 'BTC-USD'
const MAX_MESSAGE_BYTES = 5 * 1024 * 1024
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000
const BATCH_ROW_LIMIT = 2000
const BATCH_FLUSH_MS = 250
const WATCHDOG_INTERVAL_MS = 15_000
const WATCHDOG_EVENT_INTERVAL_MS = 5 * 60 * 1000
const STALE_MESSAGE_MS = 30_000
const MAX_RECONNECT_DELAY_MS = 60_000
const MAX_TRACKED_TRADE_IDS = 100_000

type DataChannel = 'heartbeats' | 'market_trades' | 'level2'
type CoinbaseChannel = DataChannel | 'subscriptions'

export interface ParsedCoinbaseMarketData {
  channel: CoinbaseChannel
  sequence: number
  sourceTs: number
  trades: BitcoinMarketTradeRow[]
  l2Updates: BitcoinL2UpdateRow[]
  heartbeatCounter: number | null
}

export interface BitcoinOrderFlowCollectionStatus {
  state: 'starting' | 'connected' | 'reconnecting' | 'stopped' | 'disabled' | 'error'
  product_id: 'BTC-USD'
  started_at: number
  connected_at: number | null
  last_message_at: number | null
  last_heartbeat_at: number | null
  last_trade_at: number | null
  last_l2_at: number | null
  last_bar_end_at: number | null
  last_bar_eligible: boolean | null
  last_bar_reason: string | null
  trades_stored: number
  l2_updates_stored: number
  bars_completed: number
  sequence_gap_count: number
  reconnect_count: number
  rejected_messages: number
  storage_error_count: number
  declaration_at: number | null
  collection_through_at: number | null
  eligible_bars_total: number
  ineligible_bars_total: number
  collection_days_completed: number
  minimum_forward_days: number
  earliest_evaluation_at: number | null
  collection_mature: boolean
  evaluation_status: 'awaiting_collection' | 'rejected_pre_holdout' | 'rejected' | 'passed' | 'error'
  evaluation_completed_at: number | null
  evaluation_holdout_uses: 0 | 1 | null
  evaluation_trade_count: number | null
  updated_at: number
}

interface CoinbaseEnvelope {
  channel?: unknown
  timestamp?: unknown
  sequence_num?: unknown
  events?: unknown
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return !!value && !Array.isArray(value) && typeof value === 'object'
}

function safeSequence(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error('invalid sequence')
  return parsed
}

function safeTimestamp(value: unknown, receivedAt: number, allowEpochFallback = false): number {
  if (typeof value !== 'string' || value.length > 64) throw new Error('invalid timestamp')
  const parsed = Date.parse(value)
  if (!Number.isSafeInteger(parsed)) throw new Error('invalid timestamp')
  if (allowEpochFallback && parsed < Date.UTC(2000, 0, 1)) return receivedAt
  if (parsed <= 0) throw new Error('invalid timestamp')
  if (Math.abs(parsed - receivedAt) > MAX_CLOCK_SKEW_MS) throw new Error('timestamp outside clock bound')
  return parsed
}

function safePositive(value: unknown, field: string, allowZero = false): number {
  if (typeof value !== 'string' && typeof value !== 'number') throw new Error(`invalid ${field}`)
  if (typeof value === 'string' && (value.length === 0 || value.length > 48)) throw new Error(`invalid ${field}`)
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || (allowZero ? parsed < 0 : parsed <= 0)) throw new Error(`invalid ${field}`)
  return parsed
}

function eventKind(value: unknown): 'snapshot' | 'update' {
  if (value !== 'snapshot' && value !== 'update') throw new Error('invalid event kind')
  return value
}

export function parseCoinbaseMarketDataMessage(
  raw: string,
  receivedAt: number,
): ParsedCoinbaseMarketData | null {
  if (Buffer.byteLength(raw, 'utf8') > MAX_MESSAGE_BYTES) throw new Error('message too large')
  const body = JSON.parse(raw) as CoinbaseEnvelope
  if (!plainObject(body)) throw new Error('invalid message')
  const channel: CoinbaseChannel | null = body.channel === 'subscriptions'
    ? 'subscriptions'
    : body.channel === 'l2_data' || body.channel === 'level2'
    ? 'level2'
    : body.channel === 'market_trades' || body.channel === 'heartbeats'
      ? body.channel
      : null
  // Coinbase can add message types. Unknown channels are ignored per protocol.
  if (!channel) return null
  const sequence = safeSequence(body.sequence_num)
  const sourceTs = safeTimestamp(body.timestamp, receivedAt)
  // Subscription acknowledgements share the connection sequence but contain
  // no market observations. Track their header; discard their body.
  if (channel === 'subscriptions') {
    return {channel, sequence, sourceTs, trades: [], l2Updates: [], heartbeatCounter: null}
  }
  if (!Array.isArray(body.events) || body.events.length > 10_000) throw new Error('invalid events')
  const trades: BitcoinMarketTradeRow[] = []
  const l2Updates: BitcoinL2UpdateRow[] = []
  let heartbeatCounter: number | null = null

  for (const rawEvent of body.events) {
    if (!plainObject(rawEvent)) throw new Error('invalid event')
    if (channel === 'heartbeats') {
      const counter = safeSequence(rawEvent.heartbeat_counter)
      heartbeatCounter = counter
      continue
    }
    const kind = eventKind(rawEvent.type)
    if (channel === 'market_trades') {
      if (!Array.isArray(rawEvent.trades) || rawEvent.trades.length > 50_000) throw new Error('invalid trades')
      for (const rawTrade of rawEvent.trades) {
        if (!plainObject(rawTrade) || rawTrade.product_id !== PRODUCT_ID) throw new Error('invalid trade product')
        if (typeof rawTrade.trade_id !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(rawTrade.trade_id)) {
          throw new Error('invalid trade id')
        }
        if (rawTrade.side !== 'BUY' && rawTrade.side !== 'SELL') throw new Error('invalid maker side')
        const makerSide = rawTrade.side
        trades.push({
          tradeId: rawTrade.trade_id,
          price: safePositive(rawTrade.price, 'trade price'),
          size: safePositive(rawTrade.size, 'trade size'),
          makerSide,
          aggressorSide: makerSide === 'BUY' ? 'SELL' : 'BUY',
          sourceTs: safeTimestamp(rawTrade.time, receivedAt),
          receivedAt,
          channelSequence: sequence,
          eventKind: kind,
        })
      }
    } else {
      if (rawEvent.product_id !== PRODUCT_ID || !Array.isArray(rawEvent.updates) || rawEvent.updates.length > 100_000) {
        throw new Error('invalid book event')
      }
      for (const rawUpdate of rawEvent.updates) {
        if (!plainObject(rawUpdate) || (rawUpdate.side !== 'bid' && rawUpdate.side !== 'offer')) {
          throw new Error('invalid book update')
        }
        l2Updates.push({
          side: rawUpdate.side,
          price: safePositive(rawUpdate.price_level, 'book price'),
          newQuantity: safePositive(rawUpdate.new_quantity, 'book quantity', true),
          sourceTs: safeTimestamp(rawUpdate.event_time, sourceTs, true),
          receivedAt,
          channelSequence: sequence,
          eventKind: kind,
        })
      }
    }
  }

  return {channel, sequence, sourceTs, trades, l2Updates, heartbeatCounter}
}

interface CollectorOptions {
  researchDb?: Database.Database
  now?: () => number
  createSocket?: () => WebSocket
  onStatusChange?: () => void | Promise<void>
  flushDelayMs?: number
  watchdogIntervalMs?: number
}

export class BitcoinOrderFlowCollector {
  private readonly researchDb: Database.Database
  private readonly marketDataWriter: BitcoinMarketDataWriter
  private readonly ownsResearchDb: boolean
  private readonly now: () => number
  private readonly createSocket: () => WebSocket
  private readonly onStatusChange?: () => void | Promise<void>
  private readonly flushDelayMs: number
  private readonly watchdogIntervalMs: number
  private readonly bars: BitcoinOrderFlowBarBuilder
  private lastSequence: number | null = null
  private readonly seenTradeIds = new Set<string>()
  private pendingTrades: BitcoinMarketTradeRow[] = []
  private pendingL2: BitcoinL2UpdateRow[] = []
  private pendingPartition: string | null = null
  private socket: WebSocket | null = null
  private flushTimer: NodeJS.Timeout | null = null
  private reconnectTimer: NodeJS.Timeout | null = null
  private watchdogTimer: NodeJS.Timeout | null = null
  private stopped = false
  private reconnectAttempt = 0
  private lastWatchdogEventAt = 0
  private evaluationErrorReported = false
  private status: BitcoinOrderFlowCollectionStatus

  constructor(private readonly mainDb: Database.Database, options: CollectorOptions = {}) {
    const catalogPath = process.env.TRADER_RESEARCH_DB_PATH || BITCOIN_ORDER_FLOW_DB_PATH
    this.researchDb = options.researchDb ?? openBitcoinOrderFlowStore(catalogPath)
    this.ownsResearchDb = !options.researchDb
    this.marketDataWriter = options.researchDb
      ? new BitcoinOrderFlowSingleDatabaseMarketDataStore(this.researchDb)
      : new BitcoinOrderFlowPartitionedMarketDataStore(bitcoinOrderFlowRawPartitionDir(catalogPath))
    this.warmTradeDedupe()
    this.now = options.now ?? Date.now
    this.createSocket = options.createSocket ?? (() => new WebSocket(COINBASE_PUBLIC_MARKET_DATA_URL, {
      maxPayload: MAX_MESSAGE_BYTES,
      handshakeTimeout: 10_000,
    }))
    this.onStatusChange = options.onStatusChange
    this.flushDelayMs = options.flushDelayMs ?? BATCH_FLUSH_MS
    this.watchdogIntervalMs = options.watchdogIntervalMs ?? WATCHDOG_INTERVAL_MS
    const now = this.now()
    this.bars = new BitcoinOrderFlowBarBuilder(this.now)
    this.status = {
      state: 'starting', product_id: PRODUCT_ID, started_at: now, connected_at: null,
      last_message_at: null, last_heartbeat_at: null, last_trade_at: null, last_l2_at: null,
      last_bar_end_at: null, last_bar_eligible: null, last_bar_reason: null,
      trades_stored: 0, l2_updates_stored: 0, bars_completed: 0,
      sequence_gap_count: 0, reconnect_count: 0, rejected_messages: 0, updated_at: now,
      storage_error_count: 0,
      declaration_at: null, collection_through_at: null,
      eligible_bars_total: 0, ineligible_bars_total: 0,
      collection_days_completed: 0, minimum_forward_days: 180,
      earliest_evaluation_at: null, collection_mature: false,
      evaluation_status: 'awaiting_collection', evaluation_completed_at: null,
      evaluation_holdout_uses: null, evaluation_trade_count: null,
    }
    this.refreshResearchProgress()
  }

  start(): void {
    if (this.stopped || this.socket) return
    this.persistStatus()
    this.connect()
    this.watchdogTimer = setInterval(() => this.runWatchdog(), this.watchdogIntervalMs)
    this.watchdogTimer.unref?.()
  }

  stop(): void {
    if (this.stopped) return
    this.stopped = true
    if (this.flushTimer) clearTimeout(this.flushTimer)
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    if (this.watchdogTimer) clearInterval(this.watchdogTimer)
    this.flushTimer = this.reconnectTimer = this.watchdogTimer = null
    this.flushBatch()
    if (this.socket) {
      this.socket.removeAllListeners()
      this.socket.close()
      this.socket = null
    }
    this.status.state = 'stopped'
    this.persistStatus()
    this.event('research.collector.stopped', 'completed')
    this.marketDataWriter.close()
    if (this.ownsResearchDb) this.researchDb.close()
  }

  ingestRawMessage(raw: string | Buffer, receivedAt = this.now()): void {
    try {
      const parsed = parseCoinbaseMarketDataMessage(raw.toString(), receivedAt)
      if (!parsed) return
      if (this.socket && this.status.state === 'error') this.status.state = 'connected'
      this.status.last_message_at = receivedAt
      const priorSequence = this.lastSequence
      // sequence_num is connection-wide for the interleaved subscriptions on
      // this socket. Per-channel cursors create false gaps whenever another
      // subscribed channel occupies the next sequence number.
      if (priorSequence !== null && parsed.sequence <= priorSequence) return
      const missing = priorSequence !== null && parsed.sequence > priorSequence + 1
        ? parsed.sequence - priorSequence - 1
        : 0
      if (missing > 0) {
        this.status.sequence_gap_count += missing
        this.event('research.collector.sequence-gap', 'warning', {
          channel: parsed.channel, gap_count: missing, sequence: parsed.sequence,
        })
      }
      this.lastSequence = parsed.sequence
      if (parsed.channel === 'subscriptions') {
        if (missing > 0) {
          this.persistBars(this.bars.ingestFrame(receivedAt, [], [], missing, false))
        }
        this.status.last_message_at = receivedAt
        this.persistStatus()
        return
      }
      const hasMarketData = parsed.trades.length > 0 || parsed.l2Updates.length > 0
      if (hasMarketData) {
        const incomingPartition = new Date(receivedAt).toISOString().slice(0, 10)
        if (this.pendingPartition !== null && incomingPartition !== this.pendingPartition && !this.flushBatch()) {
          return
        }
        this.pendingPartition = incomingPartition
      }
      const novelTrades = this.dedupeTrades(parsed.trades)
      // Local receive time drives the safe-progress watermark. Coinbase's
      // envelope clock is independent from event_time and can run ahead;
      // exchange event timestamps remain unchanged inside trades/L2 updates.
      this.persistBars(this.bars.ingestFrame(receivedAt, novelTrades, parsed.l2Updates, missing))
      if (parsed.channel === 'heartbeats') this.status.last_heartbeat_at = receivedAt
      if (parsed.trades.length > 0) {
        this.status.last_trade_at = receivedAt
        this.pendingTrades.push(...novelTrades)
      }
      if (parsed.l2Updates.length > 0) {
        this.status.last_l2_at = receivedAt
        this.pendingL2.push(...parsed.l2Updates)
      }
      if (this.pendingTrades.length + this.pendingL2.length >= BATCH_ROW_LIMIT) this.flushBatch()
      else this.scheduleFlush()
      this.persistStatus()
    } catch {
      this.status.rejected_messages += 1
      this.status.state = 'error'
      this.persistStatus()
      this.event('research.collector.message-rejected', 'warning', {
        reason: 'invalid_public_payload', error_count: this.status.rejected_messages,
      })
    }
  }

  runWatchdog(): void {
    const now = this.now()
    this.persistBars(this.bars.flushBuffered(now))
    const age = this.status.last_message_at === null ? Number.MAX_SAFE_INTEGER : now - this.status.last_message_at
    const healthy = this.status.state === 'connected' && age <= STALE_MESSAGE_MS
    if (!healthy && this.status.state === 'connected') this.status.state = 'error'
    this.persistStatus()
    if (now - this.lastWatchdogEventAt >= WATCHDOG_EVENT_INTERVAL_MS) {
      this.lastWatchdogEventAt = now
      this.event('research.collector.watchdog', healthy ? 'completed' : 'warning', {
        message_age_ms: age,
        trades_stored: this.status.trades_stored,
        l2_updates_stored: this.status.l2_updates_stored,
        bars_completed: this.status.bars_completed,
        gap_count: this.status.sequence_gap_count,
        reconnect_count: this.status.reconnect_count,
        error_count: this.status.rejected_messages + this.status.storage_error_count,
      })
      void this.onStatusChange?.()
    }
  }

  getStatus(): BitcoinOrderFlowCollectionStatus {
    return {...this.status}
  }

  private dedupeTrades(trades: BitcoinMarketTradeRow[]): BitcoinMarketTradeRow[] {
    const novel: BitcoinMarketTradeRow[] = []
    for (const trade of trades) {
      if (this.seenTradeIds.has(trade.tradeId)) continue
      this.seenTradeIds.add(trade.tradeId)
      novel.push(trade)
      if (this.seenTradeIds.size > MAX_TRACKED_TRADE_IDS) {
        const oldest = this.seenTradeIds.values().next().value as string | undefined
        if (oldest !== undefined) this.seenTradeIds.delete(oldest)
      }
    }
    return novel
  }

  private warmTradeDedupe(): void {
    try {
      const legacyRows = this.researchDb.prepare(
        'SELECT trade_id FROM bitcoin_order_flow_trades ORDER BY seq DESC LIMIT ?',
      ).all(MAX_TRACKED_TRADE_IDS) as Array<{trade_id: string}>
      const recentIds = [
        ...legacyRows.map(row => row.trade_id),
        ...this.marketDataWriter.recentTradeIds(MAX_TRACKED_TRADE_IDS),
      ]
      for (const tradeId of recentIds) {
        this.seenTradeIds.add(tradeId)
        if (this.seenTradeIds.size > MAX_TRACKED_TRADE_IDS) {
          const oldest = this.seenTradeIds.values().next().value as string | undefined
          if (oldest !== undefined) this.seenTradeIds.delete(oldest)
        }
      }
    } catch {
      // DB uniqueness remains the persistence boundary. The collector continues
      // fail-safe and rebuilds its in-memory set from newly observed trade IDs.
    }
  }

  flushBatch(): boolean {
    if (this.flushTimer) clearTimeout(this.flushTimer)
    this.flushTimer = null
    if (this.pendingTrades.length === 0 && this.pendingL2.length === 0) return true
    const trades = this.pendingTrades
    const l2 = this.pendingL2
    const partition = this.pendingPartition
    this.pendingTrades = []
    this.pendingL2 = []
    this.pendingPartition = null
    try {
      const result = this.marketDataWriter.appendBatch(trades, l2)
      this.status.trades_stored += result.tradesInserted
      this.status.l2_updates_stored += result.l2UpdatesInserted
      this.persistStatus()
      return true
    } catch {
      // Preserve the batch for retry. The source socket is closed so an
      // unhealthy disk cannot create an unbounded in-memory backlog.
      this.pendingTrades = [...trades, ...this.pendingTrades]
      this.pendingL2 = [...l2, ...this.pendingL2]
      this.pendingPartition = partition
      this.status.state = 'error'
      this.status.storage_error_count += 1
      this.persistStatus()
      this.event('research.collector.storage-failed', 'failed', {reason: 'research_db_write_failed'})
      this.socket?.terminate()
      this.scheduleFlush()
      return false
    }
  }

  private connect(): void {
    if (this.stopped) return
    this.status.state = this.reconnectAttempt > 0 ? 'reconnecting' : 'starting'
    this.persistStatus()
    const socket = this.createSocket()
    this.socket = socket
    socket.on('open', () => {
      if (this.stopped || socket !== this.socket) return
      const now = this.now()
      this.persistBars(this.bars.markConnected(now))
      if (this.reconnectAttempt > 0) this.status.reconnect_count += 1
      this.lastSequence = null
      this.reconnectAttempt = 0
      this.status.state = 'connected'
      this.status.connected_at = now
      this.persistStatus()
      for (const channel of ['heartbeats', 'market_trades', 'level2']) {
        socket.send(JSON.stringify({type: 'subscribe', product_ids: channel === 'heartbeats' ? undefined : [PRODUCT_ID], channel}))
      }
      this.event('research.collector.connected', 'succeeded', {channel: 'coinbase-public'})
      void this.onStatusChange?.()
    })
    socket.on('message', (data: RawData) => this.ingestRawMessage(Buffer.isBuffer(data) ? data : data.toString()))
    socket.on('error', () => {
      // The close event owns reconnect scheduling. Do not log remote payloads.
      logger.warn('Bitcoin order-flow public market-data WebSocket error')
    })
    socket.on('close', (code: number) => {
      if (socket !== this.socket) return
      this.socket = null
      this.flushBatch()
      this.persistBars(this.bars.markDisconnected(this.now()))
      if (this.stopped) return
      this.status.state = 'reconnecting'
      this.persistStatus()
      this.event('research.collector.disconnected', 'warning', {status: code})
      this.scheduleReconnect()
      void this.onStatusChange?.()
    })
  }

  private scheduleFlush(): void {
    if (this.flushTimer) return
    this.flushTimer = setTimeout(() => this.flushBatch(), this.flushDelayMs)
    this.flushTimer.unref?.()
  }

  private scheduleReconnect(): void {
    this.reconnectAttempt += 1
    const delay = Math.min(MAX_RECONNECT_DELAY_MS, 1000 * 2 ** Math.min(6, this.reconnectAttempt - 1))
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.connect()
    }, delay)
    this.reconnectTimer.unref?.()
  }

  private persistBars(bars: BitcoinOrderFlowBarRow[]): void {
    let inserted = false
    for (const bar of bars) {
      if (!appendBitcoinOrderFlowBar(this.researchDb, bar)) continue
      inserted = true
      this.status.bars_completed += 1
      this.status.last_bar_end_at = bar.bucketEndMs
      this.status.last_bar_eligible = bar.eligible
      this.status.last_bar_reason = bar.qualityReason
      this.event('research.bar.completed', bar.eligible ? 'completed' : 'warning', {
        eligible: bar.eligible,
        trade_count: bar.tradeCount,
        gap_count: bar.sequenceGapCount,
        reconnect_count: bar.reconnectCount,
        downtime_ms: bar.downtimeMs,
        reason: bar.eligible ? 'quality_passed' : 'quality_failed',
      })
    }
    if (inserted) this.refreshResearchProgress()
  }

  private refreshResearchProgress(): void {
    try {
      const row = this.mainDb.prepare(
        "SELECT created_at,params_json FROM trader_strategies WHERE id='order-flow-imbalance-crypto'",
      ).get() as {created_at: number; params_json: string} | undefined
      if (!row || !Number.isSafeInteger(row.created_at) || row.created_at <= 0) return
      const params = JSON.parse(row.params_json) as Record<string, unknown>
      const configuredDays = Number(params.minimum_forward_days)
      const minimumForwardDays = Number.isSafeInteger(configuredDays) && configuredDays > 0
        ? configuredDays : 180
      const progress = getBitcoinOrderFlowResearchProgress(this.researchDb, row.created_at, minimumForwardDays)
      this.status.declaration_at = progress.declarationAt
      this.status.collection_through_at = progress.collectionThroughAt
      this.status.eligible_bars_total = progress.eligibleBars
      this.status.ineligible_bars_total = progress.ineligibleBars
      this.status.collection_days_completed = progress.collectionDaysCompleted
      this.status.minimum_forward_days = progress.minimumForwardDays
      this.status.earliest_evaluation_at = progress.earliestEvaluationAt
      this.status.collection_mature = progress.collectionMature
      const evaluation = maybeRunBitcoinOrderFlowEvaluation(this.mainDb, this.researchDb, this.now())
      if (evaluation.run) {
        this.status.evaluation_status = evaluation.run.status
        this.status.evaluation_completed_at = evaluation.run.created_at
        this.status.evaluation_holdout_uses = evaluation.run.holdout_uses
        if (evaluation.run.holdout_json) {
          const holdout = JSON.parse(evaluation.run.holdout_json) as {tradeCount?: unknown}
          this.status.evaluation_trade_count = Number.isSafeInteger(holdout.tradeCount)
            ? Number(holdout.tradeCount) : null
        }
      } else {
        this.status.evaluation_status = 'awaiting_collection'
      }
    } catch {
      // Research evaluation must fail closed without interrupting collection.
      if (!this.evaluationErrorReported) {
        this.evaluationErrorReported = true
        this.event('research.evaluation.blocked', 'failed', {reason: 'integrity_check_failed'})
      }
      this.status.evaluation_status = 'error'
    }
  }

  private persistStatus(): void {
    this.status.updated_at = this.now()
    try {
      this.mainDb.prepare('CREATE TABLE IF NOT EXISTS kv_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)').run()
      this.mainDb.prepare(`INSERT INTO kv_settings (key,value) VALUES (?,?)
        ON CONFLICT(key) DO UPDATE SET value=excluded.value`)
        .run(BITCOIN_ORDER_FLOW_STATUS_KEY, JSON.stringify(this.status))
    } catch {
      logger.warn('Bitcoin order-flow collection status persistence failed')
    }
  }

  private event(
    eventType: string,
    state: 'succeeded' | 'completed' | 'warning' | 'failed',
    metadata: Record<string, string | number | boolean> = {},
  ): void {
    recordTraderOperationalEvent(this.mainDb, {
      source: 'coinbase.public-market-data',
      stage: 'research',
      eventType,
      state,
      asset: 'BTC-USD',
      strategyId: 'order-flow-imbalance-crypto',
      metadata,
    })
  }
}

let activeCollector: BitcoinOrderFlowCollector | null = null

export function startBitcoinOrderFlowCollector(
  mainDb: Database.Database,
  options: CollectorOptions = {},
): BitcoinOrderFlowCollector | null {
  if (activeCollector) return activeCollector
  if (process.env.TRADER_BTC_ORDER_FLOW_COLLECTION_ENABLED === 'false') {
    const now = Date.now()
    mainDb.prepare('CREATE TABLE IF NOT EXISTS kv_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)').run()
    mainDb.prepare(`INSERT INTO kv_settings (key,value) VALUES (?,?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(BITCOIN_ORDER_FLOW_STATUS_KEY, JSON.stringify({
        state: 'disabled', product_id: PRODUCT_ID, started_at: now, updated_at: now,
      }))
    logger.info('Bitcoin order-flow research collection disabled by environment')
    return null
  }
  activeCollector = new BitcoinOrderFlowCollector(mainDb, options)
  activeCollector.start()
  logger.info({product: PRODUCT_ID}, 'Bitcoin order-flow research collection started')
  return activeCollector
}

export function stopBitcoinOrderFlowCollector(): void {
  activeCollector?.stop()
  activeCollector = null
}

export function _resetBitcoinOrderFlowCollectorForTest(): void {
  activeCollector = null
}
