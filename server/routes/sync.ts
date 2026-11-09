/**
 * trader-routes/sync.ts
 *
 * POST /api/v1/internal/trader-sync
 *
 * Bot-internal endpoint. After each trader tick the bot POSTs a compact
 * snapshot of every trader table so the dashboard server always has
 * current data -- without a full DB push or a separate cron job.
 *
 * Auth: requireBotOrAdmin (same gate as other /internal/* routes).
 * Body: TraderSyncPayload (see interface below).
 *
 * Snapshot tables use INSERT OR REPLACE so rows are idempotent. Operational
 * events use INSERT OR IGNORE so their stable IDs remain append-only. The
 * server never deletes rows -- omitting a row from the payload leaves it intact.
 * This means the server gradually accumulates a full history as each
 * sync window slides forward; the first sync seeds all recent rows and
 * subsequent syncs keep them up to date.
 *
 * Row counts are capped server-side at MAX_ROWS_PER_TABLE to protect
 * against accidental oversized payloads. The bot naturally sends at most
 * 30-day windows so this cap is a safety net, not a normal limit.
 */

import { Router, type Request, type Response } from 'express'
import { getBotDbWrite } from '../db.js'
import { logger } from '../logger.js'
import { requireBotOrAdmin } from '../auth.js'
import { broadcastTraderUpdate } from '../ws.js'

const router = Router()

const MAX_ROWS_PER_TABLE = 5000
const EVENT_TOKEN = /^[A-Za-z0-9._:/-]{1,160}$/
const EVENT_TYPE = /^[a-z][a-z0-9_.-]{1,95}$/
const EVENT_STAGES = new Set(['scheduler', 'strategy', 'committee', 'risk', 'broker', 'reconcile', 'exit', 'verdict', 'cohort', 'research', 'watchdog'])
const EVENT_STATES = new Set(['started', 'succeeded', 'blocked', 'suppressed', 'submitted', 'pending', 'filled', 'failed', 'skipped', 'completed', 'warning', 'info'])
const EVENT_METADATA_KEYS = new Set([
  'reason', 'side', 'score', 'threshold', 'horizon_days', 'fetched', 'stored',
  'filtered', 'deduped', 'decision', 'confidence', 'size_usd', 'status',
  'filled_qty', 'fill_price', 'fee_usd', 'slippage_usd', 'exit_reason',
  'checked', 'promoted_to_filled', 'promoted_to_pending',
  'canceled_or_rejected', 'expired_orphans', 'processed', 'still_open',
  'errors', 'drift_closed', 'ungraded', 'exited', 'drifted',
  'skipped_closed', 'unsafe_shorts', 'polled', 'sent', 'reconciler_halted',
  'closed_out', 'weekly_report_fired', 'collector', 'error_count',
  'duration_ms', 'trade_count', 'passed', 'pnl_net', 'thesis_grade',
  'returns_backfilled', 'channel', 'sequence', 'gap_count', 'reconnect_count',
  'message_age_ms', 'trades_stored', 'l2_updates_stored', 'bars_completed',
  'eligible', 'downtime_ms', 'rejected_messages',
])

function validOperationalEvent(row: unknown): row is Record<string, unknown> {
  if (!row || Array.isArray(row) || typeof row !== 'object') return false
  const candidate = row as Record<string, unknown>
  if (candidate.project_id !== 'trader') return false
  for (const key of ['event_id', 'source']) {
    const value = candidate[key]
    if (typeof value !== 'string' || !EVENT_TOKEN.test(value)) return false
  }
  for (const key of ['asset', 'strategy_id', 'signal_id', 'decision_id', 'cohort_id', 'order_id']) {
    const value = candidate[key]
    if (value != null && (typeof value !== 'string' || !EVENT_TOKEN.test(value))) return false
  }
  if (typeof candidate.event_type !== 'string' || !EVENT_TYPE.test(candidate.event_type)) return false
  if (typeof candidate.stage !== 'string' || !EVENT_STAGES.has(candidate.stage)) return false
  if (typeof candidate.state !== 'string' || !EVENT_STATES.has(candidate.state)) return false
  if (!Number.isSafeInteger(candidate.source_ts) || Number(candidate.source_ts) <= 0 ||
      !Number.isSafeInteger(candidate.recorded_at) || Number(candidate.recorded_at) <= 0) return false
  if (typeof candidate.metadata_json !== 'string' || candidate.metadata_json.length > 4096) return false
  try {
    const metadata = JSON.parse(candidate.metadata_json) as unknown
    if (!metadata || Array.isArray(metadata) || typeof metadata !== 'object') return false
    return Object.entries(metadata as Record<string, unknown>).every(([key, value]) =>
      EVENT_METADATA_KEYS.has(key) &&
      (value === null || ['string', 'number', 'boolean'].includes(typeof value)) &&
      !(typeof value === 'number' && !Number.isFinite(value)) &&
      !(typeof value === 'string' && (value.length > 160 || !EVENT_TOKEN.test(value))),
    )
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// Payload shape -- mirrors the bot's trader DB tables exactly.
// All fields are optional so the bot can send partial payloads when only
// some tables changed; missing keys are silently skipped.
// ---------------------------------------------------------------------------

export interface TraderSyncPayload {
  strategies?:    Record<string, unknown>[]
  signals?:       Record<string, unknown>[]
  approvals?:     Record<string, unknown>[]
  decisions?:     Record<string, unknown>[]
  transcripts?:   Record<string, unknown>[]
  verdicts?:      Record<string, unknown>[]
  track_records?: Record<string, unknown>[]
  circuit_breakers?: Record<string, unknown>[]
  pnl_snapshots?: Record<string, unknown>[]
  alert_state?:   Record<string, unknown>[]
  cohorts?:       Record<string, unknown>[]
  cohort_events?: Record<string, unknown>[]
  cohort_scorecards?: Record<string, unknown>[]
  operational_events?: Record<string, unknown>[]
  kv?:            Record<string, unknown>[]
}

// Maps payload key → { table name, columns in insert order }
const TABLE_MAP: Record<keyof TraderSyncPayload, { table: string; cols: string[]; insertOnly?: boolean }> = {
  strategies: {
    table: 'trader_strategies',
    cols: ['id', 'name', 'asset_class', 'tier', 'status', 'params_json', 'created_at', 'updated_at', 'max_size_usd'],
  },
  signals: {
    table: 'trader_signals',
    cols: ['id', 'strategy_id', 'asset', 'side', 'raw_score', 'horizon_days', 'enrichment_json', 'generated_at', 'status'],
  },
  approvals: {
    table: 'trader_approvals',
    cols: ['id', 'decision_id', 'sent_at', 'responded_at', 'response', 'override_size'],
  },
  decisions: {
    table: 'trader_decisions',
    cols: ['id', 'signal_id', 'parent_decision_id', 'action', 'asset', 'size_usd', 'entry_type', 'entry_price', 'stop_loss', 'take_profit', 'thesis', 'confidence', 'committee_transcript_id', 'decided_at', 'status', 'cohort_id'],
  },
  transcripts: {
    table: 'trader_committee_transcripts',
    cols: ['id', 'signal_id', 'transcript_json', 'rounds', 'total_tokens', 'total_cost_usd', 'created_at'],
  },
  verdicts: {
    table: 'trader_verdicts',
    cols: ['id', 'decision_id', 'pnl_gross', 'pnl_net', 'bench_return', 'hold_drawdown', 'thesis_grade', 'agent_attribution_json', 'embedding_id', 'closed_at', 'returns_backfilled', 'excluded_at'],
  },
  track_records: {
    table: 'trader_strategy_track_record',
    cols: ['strategy_id', 'trade_count', 'win_count', 'rolling_sharpe', 'avg_winner_pct', 'avg_loser_pct', 'max_dd_pct', 'net_pnl_usd', 'computed_at'],
  },
  circuit_breakers: {
    table: 'trader_circuit_breakers',
    cols: ['id', 'rule', 'tripped_at', 'reason', 'cleared_at', 'cleared_by'],
  },
  pnl_snapshots: {
    table: 'trader_pnl_snapshots',
    cols: ['date', 'nav_open', 'nav_close', 'pnl_day', 'trades_count', 'bench_return', 'cumulative_pnl', 'open_unrealized_pnl', 'account_nav'],
  },
  alert_state: {
    table: 'trader_alert_state',
    cols: ['alert_id', 'last_alerted_at'],
  },
  cohorts: {
    table: 'trader_evaluation_cohorts',
    cols: ['id', 'strategy_id', 'asset_class', 'status', 'config_json', 'config_fingerprint', 'universe_json', 'data_venue', 'execution_venue', 'mode', 'fee_bps_per_side', 'slippage_bps_per_side', 'benchmark_asset', 'max_position_usd', 'daily_trade_cap', 'min_closed_trades', 'min_regimes', 'max_drawdown_pct', 'min_deflated_sharpe', 'min_backtest_ratio', 'claudepaw_revision', 'engine_revision', 'backtest_sharpe', 'backtest_trade_count', 'backtest_max_drawdown_pct', 'backtest_fingerprint', 'backtest_evaluated_at', 'backtest_report_json', 'no_retune', 'legacy_quarantined_at', 'created_at', 'started_at', 'ended_at', 'invalidated_at', 'invalidation_reason'],
  },
  cohort_events: {
    table: 'trader_cohort_events',
    cols: ['id', 'cohort_id', 'event_type', 'detail_json', 'actor', 'created_at'],
  },
  cohort_scorecards: {
    table: 'trader_cohort_scorecards',
    cols: ['cohort_id', 'trade_count', 'win_count', 'net_pnl_usd', 'expectancy', 'sharpe', 'deflated_sharpe', 'max_drawdown_pct', 'benchmark_return', 'excess_return', 'failure_rate', 'regimes_json', 'evidence_complete', 'passed', 'criteria_json', 'computed_at'],
  },
  operational_events: {
    table: 'trader_operational_events',
    cols: ['event_id', 'project_id', 'source_ts', 'recorded_at', 'source', 'stage', 'event_type', 'state', 'asset', 'strategy_id', 'signal_id', 'decision_id', 'cohort_id', 'order_id', 'metadata_json'],
    insertOnly: true,
  },
  kv: {
    table: 'kv_settings',
    cols: ['key', 'value'],
  },
}

export function commitTraderSync(
  bdb: NonNullable<ReturnType<typeof getBotDbWrite>>,
  payload: TraderSyncPayload,
): Record<string, number> {
  const results: Record<string, number> = {}
  // kv_settings is created lazily bot-side; mirror that here so the kv
  // slice of the payload never 500s on a fresh server DB.
  bdb.prepare('CREATE TABLE IF NOT EXISTS kv_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)').run()

  const syncAll = bdb.transaction(() => {
    for (const [key, spec] of Object.entries(TABLE_MAP) as [keyof TraderSyncPayload, { table: string; cols: string[]; insertOnly?: boolean }][]) {
      const rows = payload[key]
      if (!rows || !Array.isArray(rows) || rows.length === 0) continue

      const capped = rows.slice(0, MAX_ROWS_PER_TABLE)
      const placeholders = spec.cols.map(() => '?').join(', ')
      const stmt = bdb.prepare(
        `INSERT OR ${spec.insertOnly ? 'IGNORE' : 'REPLACE'} INTO ${spec.table} (${spec.cols.join(', ')}) VALUES (${placeholders})`
      )

      let count = 0
      for (const row of capped) {
        if (key === 'operational_events' && !validOperationalEvent(row)) continue
        const values = spec.cols.map(c => {
          const v = (row as Record<string, unknown>)[c]
          return v === undefined ? null : v
        })
        const inserted = stmt.run(...values)
        count += spec.insertOnly ? inserted.changes : 1
      }
      results[key] = count
    }
  })

  syncAll()
  logger.info({ results }, 'trader-sync: upserted rows')
  if ((results.operational_events ?? 0) > 0) {
    broadcastTraderUpdate('trader', results.operational_events)
  }
  return results
}

router.post('/api/v1/internal/trader-sync', requireBotOrAdmin, (req: Request, res: Response) => {
  const bdb = getBotDbWrite()
  if (!bdb) {
    res.status(503).json({ error: 'bot database unavailable' })
    return
  }

  const payload = req.body as TraderSyncPayload
  if (!payload || typeof payload !== 'object') {
    res.status(400).json({ error: 'invalid payload' })
    return
  }

  try {
    res.json({ ok: true, results: commitTraderSync(bdb, payload) })
  } catch (err) {
    logger.warn({ err }, 'trader-sync: failed')
    res.status(500).json({ error: 'sync failed' })
  }
})

export default router
