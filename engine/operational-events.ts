import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import { logger } from '../logger.js'
import { registerCollectorObserver } from '../paws/collectors/index.js'

export const TRADER_PROJECT_ID = 'trader'

export type TraderOperationalStage =
  | 'scheduler'
  | 'strategy'
  | 'committee'
  | 'risk'
  | 'broker'
  | 'reconcile'
  | 'exit'
  | 'verdict'
  | 'cohort'
  | 'research'
  | 'watchdog'

export type TraderOperationalState =
  | 'started'
  | 'succeeded'
  | 'blocked'
  | 'suppressed'
  | 'submitted'
  | 'pending'
  | 'filled'
  | 'failed'
  | 'skipped'
  | 'completed'
  | 'warning'
  | 'info'

const METADATA_KEYS = [
  'reason', 'side', 'score', 'threshold', 'horizon_days',
  'fetched', 'stored', 'filtered', 'deduped', 'decision', 'confidence',
  'size_usd', 'status', 'filled_qty', 'fill_price', 'fee_usd',
  'slippage_usd', 'exit_reason', 'checked', 'promoted_to_filled',
  'promoted_to_pending', 'canceled_or_rejected', 'expired_orphans',
  'processed', 'still_open', 'errors', 'drift_closed', 'ungraded',
  'exited', 'drifted', 'skipped_closed', 'unsafe_shorts', 'polled',
  'sent', 'reconciler_halted', 'closed_out', 'weekly_report_fired',
  'collector', 'error_count', 'duration_ms', 'trade_count', 'passed',
  'pnl_net', 'thesis_grade', 'returns_backfilled',
  'channel', 'sequence', 'gap_count', 'reconnect_count', 'message_age_ms',
  'trades_stored', 'l2_updates_stored', 'bars_completed', 'eligible',
  'downtime_ms', 'rejected_messages',
] as const

export type TraderOperationalMetadataKey = typeof METADATA_KEYS[number]
export type TraderOperationalMetadataValue = string | number | boolean | null
export type TraderOperationalMetadata = Partial<Record<TraderOperationalMetadataKey, TraderOperationalMetadataValue>>

const METADATA_KEY_SET = new Set<string>(METADATA_KEYS)
const SAFE_TOKEN = /^[A-Za-z0-9._:/-]{1,160}$/
const EVENT_TYPE = /^[a-z][a-z0-9_.-]{1,95}$/

export interface RecordTraderOperationalEventInput {
  eventId?: string
  sourceTs?: number
  recordedAt?: number
  source: string
  stage: TraderOperationalStage
  eventType: string
  state: TraderOperationalState
  asset?: string | null
  strategyId?: string | null
  signalId?: string | null
  decisionId?: string | null
  cohortId?: string | null
  orderId?: string | null
  metadata?: TraderOperationalMetadata | Record<string, unknown>
}

export interface TraderOperationalEventRow {
  seq: number
  event_id: string
  project_id: string
  source_ts: number
  recorded_at: number
  source: string
  stage: TraderOperationalStage
  event_type: string
  state: TraderOperationalState
  asset: string | null
  strategy_id: string | null
  signal_id: string | null
  decision_id: string | null
  cohort_id: string | null
  order_id: string | null
  metadata_json: string
}

function safeToken(value: string | null | undefined, field: string): string | null {
  if (value == null) return null
  if (!SAFE_TOKEN.test(value)) throw new Error(`invalid operational event ${field}`)
  return value
}

export function sanitizeTraderOperationalMetadata(
  metadata: Record<string, unknown> | undefined,
): TraderOperationalMetadata {
  if (!metadata) return {}
  const sanitized: TraderOperationalMetadata = {}
  for (const [key, value] of Object.entries(metadata)) {
    if (!METADATA_KEY_SET.has(key)) continue
    if (value !== null && !['string', 'number', 'boolean'].includes(typeof value)) continue
    if (typeof value === 'number' && !Number.isFinite(value)) continue
    if (typeof value === 'string' && (value.length > 160 || !SAFE_TOKEN.test(value))) continue
    sanitized[key as TraderOperationalMetadataKey] = value as TraderOperationalMetadataValue
  }
  return sanitized
}

/**
 * Best-effort operational telemetry. Domain state remains authoritative if the
 * ledger is unavailable, so observability must never block an order or exit.
 */
export function recordTraderOperationalEvent(
  db: Database.Database,
  input: RecordTraderOperationalEventInput,
): string | null {
  try {
    if (!EVENT_TYPE.test(input.eventType)) throw new Error('invalid operational event type')
    const eventId = safeToken(input.eventId ?? randomUUID(), 'eventId')!
    const source = safeToken(input.source, 'source')!
    const sourceTs = input.sourceTs ?? Date.now()
    const recordedAt = input.recordedAt ?? Date.now()
    if (!Number.isSafeInteger(sourceTs) || sourceTs <= 0 || !Number.isSafeInteger(recordedAt) || recordedAt <= 0) {
      throw new Error('invalid operational event timestamp')
    }
    db.prepare(`
      INSERT OR IGNORE INTO trader_operational_events
        (event_id, project_id, source_ts, recorded_at, source, stage,
         event_type, state, asset, strategy_id, signal_id, decision_id,
         cohort_id, order_id, metadata_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      eventId,
      TRADER_PROJECT_ID,
      sourceTs,
      recordedAt,
      source,
      input.stage,
      input.eventType,
      input.state,
      safeToken(input.asset, 'asset'),
      safeToken(input.strategyId, 'strategyId'),
      safeToken(input.signalId, 'signalId'),
      safeToken(input.decisionId, 'decisionId'),
      safeToken(input.cohortId, 'cohortId'),
      safeToken(input.orderId, 'orderId'),
      JSON.stringify(sanitizeTraderOperationalMetadata(input.metadata)),
    )
    return eventId
  } catch (err) {
    logger.warn({ err, eventType: input.eventType, stage: input.stage }, 'Trader operational event append failed')
    return null
  }
}

/**
 * Record trader watchdog collector runs into the ledger.
 *
 * Registered at boot rather than called from src/paws/engine.ts. The generic
 * paws engine used to import this module and branch on TRADER_PROJECT_ID, which
 * made shared infrastructure depend on one project. The collector registry now
 * publishes an observation and each subsystem decides what to record.
 */
export function registerTraderCollectorTelemetry(db: Database.Database): void {
  registerCollectorObserver((obs) => {
    if (obs.projectId !== TRADER_PROJECT_ID) return
    if (!obs.collector.startsWith('trader-')) return
    recordTraderOperationalEvent(db, {
      sourceTs: obs.startedAt,
      source: 'paws.trader-watchdog',
      stage: 'watchdog',
      eventType: 'watchdog.collector.completed',
      state: obs.errorCount > 0 ? 'warning' : 'completed',
      metadata: {
        collector: obs.collector,
        error_count: obs.errorCount,
        duration_ms: obs.durationMs,
      },
    })
  })
}
