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
 * Claim a specific approval row by ID and record the button action.
 * Used by the Telegram inline keyboard callback handler where the approvalId
 * is encoded in the callback_data, so we don't need to look up "most recent pending".
 *
 * Returns null if the row was already claimed (duplicate tap / concurrent request).
 */
export function handleTraderButtonCallback(
  db: Database.Database,
  approvalId: string,
  rawAction: string,
  fromUserId?: number,
): ParsedReply | null {
  const mapped = mapTraderAction(rawAction)
  if (!mapped) {
    logger.warn({ rawAction, approvalId }, 'handleTraderButtonCallback: unknown action')
    return null
  }

  const { action, override_size } = mapped

  const claimed = db.prepare(`
    UPDATE trader_approvals
    SET response = ?, responded_at = ?, override_size = ?
    WHERE id = ? AND responded_at IS NULL
  `).run(action, Date.now(), override_size ?? null, approvalId)

  if (claimed.changes === 0) return null  // already claimed or row not found

  const row = db.prepare('SELECT decision_id FROM trader_approvals WHERE id = ?')
    .get(approvalId) as { decision_id: string } | undefined
  if (!row) return null

  if (action === 'skip') {
    bulkSkipMatchingSignals(db, row.decision_id)
  }

  if (action === 'pause') {
    db.prepare("UPDATE trader_signals SET status='paused' WHERE id=?").run(row.decision_id)
  }

  return {
    approvalId,
    decisionId: row.decision_id,
    action,
    override_size,
    fromUserId,
  }
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

export function tryHandleApprovalReply(
  db: Database.Database,
  text: string,
  fromUserId?: number,
): ParsedReply | null {
  const normalized = text.trim().toUpperCase()

  let action: ApprovalAction | null = null
  let override_size: number | undefined

  if (normalized === 'APPROVE') {
    action = 'approve'
  } else if (normalized === 'SKIP') {
    action = 'skip'
  } else if (normalized === 'PAUSE STRATEGY') {
    action = 'pause'
  } else {
    // Accept optional leading $ so "APPROVE BIGGER $250" works
    const biggerMatch = normalized.match(/^APPROVE BIGGER \$?(\d+(?:\.\d+)?)$/)
    if (biggerMatch) {
      action = 'approve'
      const rawAmount = parseFloat(biggerMatch[1])

      // Phase 1 cap: reject zero/negative sizes
      if (rawAmount <= 0) return null

      // Hard cap at $500 for Phase 1 -- raise when limits lift
      const CAP = 500
      if (rawAmount > CAP) {
        logger.warn({ requested: rawAmount, capped: CAP }, 'APPROVE BIGGER amount capped at Phase 1 limit')
        override_size = CAP
      } else {
        override_size = rawAmount
      }
    }
  }

  if (!action) return null

  // Read the most recent pending approval row (read-only -- no race yet)
  const pending = db.prepare(`
    SELECT id, decision_id FROM trader_approvals
    WHERE responded_at IS NULL AND response IS NULL
    ORDER BY sent_at DESC LIMIT 1
  `).get() as { id: string; decision_id: string } | undefined

  if (!pending) return null

  // Atomically claim the row by targeting the specific id.
  // The AND responded_at IS NULL guard ensures only one concurrent caller
  // wins -- if two webhook retries both read the same pending row above, the
  // second UPDATE finds changes === 0 because the first already set responded_at.
  const claimed = db.prepare(`
    UPDATE trader_approvals
    SET response = ?, responded_at = ?, override_size = ?
    WHERE id = ? AND responded_at IS NULL
  `).run(action, Date.now(), override_size ?? null, pending.id)

  if (claimed.changes === 0) return null  // another handler already claimed this row

  if (action === 'skip') {
    bulkSkipMatchingSignals(db, pending.decision_id)
  }

  if (action === 'pause') {
    db.prepare("UPDATE trader_signals SET status='paused' WHERE id=?").run(pending.decision_id)
  }

  return {
    approvalId: pending.id,
    decisionId: pending.decision_id,
    action,
    override_size,
    fromUserId,
  }
}
