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

// ---------------------------------------------------------------------------
// Per-table queries
// ---------------------------------------------------------------------------

function buildPayload(db: Database.Database) {
  const windowMs = Date.now() - SYNC_WINDOW_DAYS * 24 * 60 * 60 * 1000

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
  }
}

export async function syncTraderTablesToServer(db: Database.Database): Promise<void> {
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
      logger.debug({ counts }, 'trader-sync: ok')
    }
  } catch (err) {
    logger.debug({ err }, 'trader-sync: fetch failed')
  }
}
