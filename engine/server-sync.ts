/**
 * src/trader/server-sync.ts
 *
 * After each trader tick, push a snapshot of all trader tables to the
 * dashboard server so the Signal Queue and other trader cards always show
 * current data -- without a full DB push or a separate cron job.
 *
 * Only rows from the last SYNC_WINDOW_DAYS are sent for time-based tables
 * (signals, approvals, decisions, transcripts, verdicts, pnl_snapshots,
 * reasoning_bank). Small / fully-upserted tables (strategies, track_records,
 * circuit_breakers, alert_state) are always sent in full.
 *
 * Fire-and-forget: failures are logged at debug level and never throw.
 * The trader tick must not stall or error because the sync failed.
 */

import type Database from 'better-sqlite3'
import { DASHBOARD_URL, BOT_API_TOKEN, DASHBOARD_API_TOKEN } from '../config.js'
import { logger } from '../logger.js'

const SYNC_WINDOW_DAYS = 30
const SYNC_TIMEOUT_MS = 10_000
const OPERATIONAL_EVENT_BATCH_SIZE = 5000
const OPERATIONAL_EVENT_CURSOR_KEY = 'trader.operational_events.server_sync_seq'

function readOperationalEventSyncCursor(db: Database.Database): number {
  try {
    const row = db.prepare('SELECT value FROM kv_settings WHERE key = ?')
      .get(OPERATIONAL_EVENT_CURSOR_KEY) as { value?: string } | undefined
    const cursor = Number(row?.value ?? 0)
    return Number.isSafeInteger(cursor) && cursor >= 0 ? cursor : 0
  } catch {
    return 0
  }
}

function commitOperationalEventSyncCursor(db: Database.Database, cursor: number): void {
  if (!Number.isSafeInteger(cursor) || cursor < 0) return
  try {
    db.prepare('CREATE TABLE IF NOT EXISTS kv_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)').run()
    db.prepare(`INSERT INTO kv_settings (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value`)
      .run(OPERATIONAL_EVENT_CURSOR_KEY, String(cursor))
  } catch (err) {
    // Remote inserts are idempotent. A local cursor failure only causes a resend.
    logger.debug({ err }, 'trader-sync: operational event cursor update failed')
  }
}

// ---------------------------------------------------------------------------
// Per-table queries
// ---------------------------------------------------------------------------

function buildPayload(db: Database.Database) {
  const windowMs = Date.now() - SYNC_WINDOW_DAYS * 24 * 60 * 60 * 1000
  const operationalEventCursor = readOperationalEventSyncCursor(db)

  return {
    // Small / always-current tables -- send all rows.
    strategies: db.prepare(
      'SELECT * FROM trader_strategies',
    ).all(),

    track_records: db.prepare(
      'SELECT * FROM trader_strategy_track_record',
    ).all(),

    circuit_breakers: db.prepare(
      'SELECT * FROM trader_circuit_breakers',
    ).all(),

    alert_state: db.prepare(
      'SELECT * FROM trader_alert_state',
    ).all(),

    cohorts: db.prepare(
      'SELECT * FROM trader_evaluation_cohorts',
    ).all(),

    cohort_events: db.prepare(
      'SELECT * FROM trader_cohort_events ORDER BY created_at DESC LIMIT 500',
    ).all(),

    cohort_scorecards: db.prepare(
      'SELECT * FROM trader_cohort_scorecards',
    ).all(),

    operational_events: db.prepare(
      `SELECT seq,event_id,project_id,source_ts,recorded_at,source,stage,event_type,state,asset,strategy_id,signal_id,decision_id,cohort_id,order_id,metadata_json
       FROM trader_operational_events WHERE seq > ? ORDER BY seq ASC LIMIT ?`,
    ).all(operationalEventCursor, OPERATIONAL_EVENT_BATCH_SIZE),

    // Time-windowed tables -- last SYNC_WINDOW_DAYS of data.
    signals: db.prepare(
      'SELECT * FROM trader_signals WHERE generated_at >= ? ORDER BY generated_at DESC LIMIT 500',
    ).all(windowMs),

    approvals: db.prepare(`
      SELECT a.* FROM trader_approvals a
      JOIN trader_signals s ON s.id = a.decision_id
      WHERE s.generated_at >= ?
      ORDER BY a.sent_at DESC LIMIT 500
    `).all(windowMs),

    decisions: db.prepare(
      'SELECT * FROM trader_decisions WHERE decided_at >= ? ORDER BY decided_at DESC LIMIT 500',
    ).all(windowMs),

    transcripts: db.prepare(
      'SELECT * FROM trader_committee_transcripts WHERE created_at >= ? ORDER BY created_at DESC LIMIT 200',
    ).all(windowMs),

    verdicts: db.prepare(
      'SELECT * FROM trader_verdicts WHERE closed_at >= ? ORDER BY closed_at DESC LIMIT 200',
    ).all(windowMs),

    pnl_snapshots: db.prepare(
      "SELECT * FROM trader_pnl_snapshots ORDER BY date DESC LIMIT 90",
    ).all(),

    // Go-live gate state (kv rows). Guarded: kv_settings is created lazily
    // by the gate module, so it may not exist on a fresh DB yet.
    kv: (() => {
      try {
        return db.prepare(
          "SELECT key, value FROM kv_settings WHERE key IN ('trader.gate.last', 'trader.gate.regimes_seen', 'trader.accounting.last', 'trader.progress.last', 'trader.bitcoin_order_flow.collection')",
        ).all()
      } catch {
        return []
      }
    })(),
  }
}

export async function syncTraderTablesToServer(db: Database.Database): Promise<void> {
  // Tests may inherit a developer's real dashboard URL/token from .env.
  // Never publish fixture rows or readiness snapshots to that deployment.
  if (process.env.NODE_ENV === 'test') return
  if (!DASHBOARD_URL) return
  const token = BOT_API_TOKEN || DASHBOARD_API_TOKEN
  if (!token) return

  let payload: ReturnType<typeof buildPayload>
  try {
    payload = buildPayload(db)
  } catch (err) {
    logger.debug({ err }, 'trader-sync: payload build failed')
    return
  }

  // Log row counts at debug level so it's visible when needed but not noisy.
  const counts = Object.fromEntries(
    Object.entries(payload).map(([k, v]) => [k, Array.isArray(v) ? v.length : 0])
  )
  logger.debug({ counts }, 'trader-sync: posting to server')

  try {
    const res = await fetch(`${DASHBOARD_URL}/api/v1/internal/trader-sync`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-dashboard-token': token,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(SYNC_TIMEOUT_MS),
    })
    if (!res.ok) {
      logger.debug({ status: res.status }, 'trader-sync: server returned non-200')
    } else {
      const lastOperationalEvent = payload.operational_events.at(-1) as { seq?: unknown } | undefined
      if (typeof lastOperationalEvent?.seq === 'number') {
        commitOperationalEventSyncCursor(db, lastOperationalEvent.seq)
      }
      logger.debug({ counts }, 'trader-sync: ok')
    }
  } catch (err) {
    logger.debug({ err }, 'trader-sync: fetch failed')
  }
}
