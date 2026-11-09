/**
 * Per-tick signal<->decision state reconciliation.
 *
 * WHY THIS EXISTS (Jun 9 2026 pipeline freeze): when an engine submit fails
 * transiently, the dispatcher parks the DECISION at retry_pending and leaves
 * the SIGNAL at 'dispatching' on purpose (the partial unique index on
 * (asset, side) WHERE status IN ('pending','dispatching') then blocks
 * duplicate in-flight signals for that asset). The retry sweep and the order
 * reconciler later advance the decision (submitted -> executed/failed), but
 * neither touches trader_signals -- so the signal stayed 'dispatching'
 * forever and the unique index froze that asset+side until the next bot
 * reboot. VTI/SPY/QQQ/IWM were frozen for two days.
 *
 * This module runs every tick (pure SQL, no engine round-trip) and converges
 * signal status onto decision status:
 *
 *   decision executed                  -> signal executed
 *   decision submitted / pending_fill  -> signal submitted
 *   all decisions failed               -> signal failed
 *   decision retry_pending/engine_down -> leave dispatching (correct block)
 *   no decision row + grace elapsed    -> back to pending (crashed mid-claim)
 *
 * Exit rows (parent_decision_id IS NOT NULL) share the entry's signal_id and
 * are excluded from every match.
 */
import type Database from 'better-sqlite3'
import { logger } from '../logger.js'

export interface SignalSyncSummary {
  toExecuted: number
  toSubmitted: number
  toFailed: number
  reclaimedPending: number
}

/** Grace before a decision-less 'dispatching' signal is reclaimed to pending.
 *  Must comfortably exceed one dispatch loop's runtime so we never reclaim a
 *  signal the dispatcher is actively working on. */
export const RECLAIM_GRACE_MS = 10 * 60 * 1000

export function syncSignalStatuses(
  db: Database.Database,
  nowMs: number,
  graceMs: number = RECLAIM_GRACE_MS,
): SignalSyncSummary {
  // Entry decisions only: exit rows carry parent_decision_id.
  const ENTRY = `d.signal_id = s.id AND d.parent_decision_id IS NULL`

  // 1. Any live signal whose entry decision confirmed-filled -> executed.
  const toExecuted = db.prepare(`
    UPDATE trader_signals AS s SET status = 'executed'
    WHERE s.status IN ('dispatching', 'submitted')
      AND EXISTS (SELECT 1 FROM trader_decisions d WHERE ${ENTRY} AND d.status = 'executed')
  `).run().changes

  // 2. Dispatching signals whose decision is live at the broker -> submitted.
  const toSubmitted = db.prepare(`
    UPDATE trader_signals AS s SET status = 'submitted'
    WHERE s.status = 'dispatching'
      AND EXISTS (SELECT 1 FROM trader_decisions d WHERE ${ENTRY} AND d.status IN ('submitted', 'pending_fill'))
  `).run().changes

  // 3. Signals whose decisions ALL terminally failed -> failed. The NOT
  //    EXISTS guard keeps retry_pending / engine_down / live decisions in
  //    charge: while any non-failed entry decision exists, hold the line.
  const toFailed = db.prepare(`
    UPDATE trader_signals AS s SET status = 'failed'
    WHERE s.status IN ('dispatching', 'submitted')
      AND EXISTS (SELECT 1 FROM trader_decisions d WHERE ${ENTRY} AND d.status = 'failed')
      AND NOT EXISTS (SELECT 1 FROM trader_decisions d WHERE ${ENTRY} AND d.status != 'failed')
  `).run().changes

  // 4. Dispatching signals with NO decision row at all, older than the grace
  //    window: the dispatcher crashed between claim and INSERT. Reclaim so
  //    the next tick re-dispatches (same recovery the boot path does, but
  //    without waiting for a reboot).
  const reclaimedPending = db.prepare(`
    UPDATE trader_signals AS s SET status = 'pending'
    WHERE s.status = 'dispatching'
      AND s.generated_at < ?
      AND NOT EXISTS (SELECT 1 FROM trader_decisions d WHERE ${ENTRY})
  `).run(nowMs - graceMs).changes

  const summary: SignalSyncSummary = { toExecuted, toSubmitted, toFailed, reclaimedPending }
  if (toExecuted || toSubmitted || toFailed || reclaimedPending) {
    logger.info(summary, 'Signal state sync: applied transitions')
  }
  return summary
}
