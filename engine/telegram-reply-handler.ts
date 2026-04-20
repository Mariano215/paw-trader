import type Database from 'better-sqlite3'
import { BIGGER_SIZE_USD } from './approval-manager.js'
import { logger } from '../logger.js'

export type ApprovalAction = 'approve' | 'skip' | 'pause'

export interface ParsedReply {
  approvalId: string
  decisionId: string
  action: ApprovalAction
  override_size?: number
  fromUserId?: number
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
  // Map button action strings to canonical ApprovalAction values
  const actionMap: Record<string, { action: ApprovalAction; override_size?: number }> = {
    approve: { action: 'approve' },
    skip:    { action: 'skip' },
    bigger:  { action: 'approve', override_size: BIGGER_SIZE_USD },
    pause:   { action: 'pause' },
  }
  const mapped = actionMap[rawAction]
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

  return {
    approvalId,
    decisionId: row.decision_id,
    action,
    override_size,
    fromUserId,
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

  return {
    approvalId: pending.id,
    decisionId: pending.decision_id,
    action,
    override_size,
    fromUserId,
  }
}
