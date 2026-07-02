import { randomUUID } from 'crypto'
import type Database from 'better-sqlite3'
import { BIGGER_SIZE_USD } from './approval-manager.js'
import { recordSignalSuppressionBySignalId } from './suppression-state.js'
import { logger } from '../logger.js'

export type ApprovalAction = 'approve' | 'skip' | 'pause'

export interface ParsedReply {
  approvalId: string
  decisionId: string
  action: ApprovalAction
  override_size?: number
  fromUserId?: number
}

function mapTraderAction(
  rawAction: string,
): { action: ApprovalAction; override_size?: number } | null {
  const actionMap: Record<string, { action: ApprovalAction; override_size?: number }> = {
    approve: { action: 'approve' },
    skip:    { action: 'skip' },
    bigger:  { action: 'approve', override_size: BIGGER_SIZE_USD },
    pause:   { action: 'pause' },
  }
  return actionMap[rawAction] ?? null
}

/**
 * Claim the latest approval row for a signal, or create an already-responded
 * row when Telegram delivery never happened and the dashboard is acting as the
 * first response path. Returns null when the signal is missing or an approval
 * for the signal was already claimed earlier.
 */
export function handleTraderSignalAction(
  db: Database.Database,
  signalId: string,
  rawAction: string,
  fromUserId?: number,
): ParsedReply | null {
  const mapped = mapTraderAction(rawAction)
  if (!mapped) {
    logger.warn({ rawAction, signalId }, 'handleTraderSignalAction: unknown action')
    return null
  }

  const signal = db.prepare('SELECT id FROM trader_signals WHERE id = ?').get(signalId) as { id: string } | undefined
  if (!signal) return null

  const { action, override_size } = mapped
  const latest = db.prepare(`
    SELECT id, responded_at
    FROM trader_approvals
    WHERE decision_id = ?
    ORDER BY sent_at DESC
    LIMIT 1
  `).get(signalId) as { id: string; responded_at: number | null } | undefined

  if (latest?.responded_at != null) {
    return null
  }

  const now = Date.now()
  let approvalId: string
  if (latest) {
    const claimed = db.prepare(`
      UPDATE trader_approvals
      SET response = ?, responded_at = ?, override_size = ?
      WHERE id = ? AND responded_at IS NULL
    `).run(action, now, override_size ?? null, latest.id)
    if (claimed.changes === 0) return null
    approvalId = latest.id
  } else {
    approvalId = randomUUID()
    db.prepare(`
      INSERT INTO trader_approvals (id, decision_id, sent_at, responded_at, response, override_size)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(approvalId, signalId, now, now, action, override_size ?? null)
  }

  if (action === 'skip') {
    bulkSkipMatchingSignals(db, signalId, now)
  }

  if (action === 'pause') {
    // Mark only the actioned signal -- the strategy pause handles future signals
    db.prepare("UPDATE trader_signals SET status='paused' WHERE id=?").run(signalId)
  }

  return {
    approvalId,
    decisionId: signalId,
    action,
    override_size,
    fromUserId,
  }
}

/**
 * Mark the actioned signal as 'skipped' and bulk-skip ALL other pending
 * signals for the same strategy+asset+side. Records a suppression for each
 * so the 24-hour cooldown applies to the whole cohort, not just the one
 * signal the user clicked.
 *
 * This prevents the queue from staying full when the engine generates
 * multiple signals for the same asset in the same cycle.
 */
function bulkSkipMatchingSignals(
  db: Database.Database,
  signalId: string,
  now = Date.now(),
): void {
  // Get strategy+asset+side for this signal
  const anchor = db.prepare(`
    SELECT strategy_id, asset, side
    FROM trader_signals
    WHERE id = ?
  `).get(signalId) as { strategy_id: string; asset: string; side: string } | undefined

  if (!anchor) {
    // Fallback: at least suppress the one signal
    recordSignalSuppressionBySignalId(db, signalId, 'skip', now)
    db.prepare("UPDATE trader_signals SET status='skipped' WHERE id=?").run(signalId)
    return
  }

  // Find all pending signals for same strategy+asset+side
  const siblings = db.prepare(`
    SELECT id FROM trader_signals
    WHERE strategy_id = ? AND asset = ? AND side = ? AND status = 'pending'
  `).all(anchor.strategy_id, anchor.asset, anchor.side) as { id: string }[]

  // Bulk status update
  db.prepare(`
    UPDATE trader_signals
    SET status = 'skipped'
    WHERE strategy_id = ? AND asset = ? AND side = ? AND status = 'pending'
  `).run(anchor.strategy_id, anchor.asset, anchor.side)

  // Record suppression for each (including the actioned one)
  for (const s of siblings) {
    recordSignalSuppressionBySignalId(db, s.id, 'skip', now)
  }
  // Always ensure the actioned signal itself is suppressed even if not in siblings
  if (!siblings.find(s => s.id === signalId)) {
    recordSignalSuppressionBySignalId(db, signalId, 'skip', now)
  }
}
