import { randomUUID } from 'crypto'
import type Database from 'better-sqlite3'
import { recordSignalSuppressionBySignalId } from './suppression-state.js'

export interface ApprovalCardParams {
  asset: string
  side: 'buy' | 'sell'
  size_usd: number
  entry_price: number
  stop_loss?: number
  take_profit?: number
  confidence: number
  strategy_name: string
  tier: number
  trade_num: number
  trades_until_promo: number
}

export function buildApprovalCard(p: ApprovalCardParams): string {
  const side = p.side.toUpperCase()
  // entry_price === 0 signals a market order where the engine resolves the fill price.
  // Without this check we would divide by zero on the shares estimate and render "$0.00"
  // as the limit price, which is misleading to the user.
  const isMarket = p.entry_price === 0
  const stopPct = p.stop_loss != null && !isMarket
    ? ` (${(((p.stop_loss - p.entry_price) / p.entry_price) * 100).toFixed(1)}%)`
    : ''
  const takePct = p.take_profit != null && !isMarket
    ? ` (+${(((p.take_profit - p.entry_price) / p.entry_price) * 100).toFixed(1)}%)`
    : ''

  const sizeLine = isMarket
    ? `Size: $${p.size_usd.toFixed(0)} (shares resolved at fill)`
    : `Size: $${p.size_usd.toFixed(0)} (~${(p.size_usd / p.entry_price).toFixed(3)} shares @ $${p.entry_price.toFixed(2)})`
  const entryLine = isMarket
    ? `Entry type: market`
    : `Entry type: limit $${p.entry_price.toFixed(2)}`

  return [
    `Trade Proposal -- ${p.strategy_name} (Tier ${p.tier}, trade ${p.trade_num} of 30)`,
    '',
    `Asset: ${p.asset}`,
    `Side: ${side}`,
    sizeLine,
    entryLine,
    p.stop_loss != null && !isMarket ? `Stop loss: $${p.stop_loss.toFixed(2)}${stopPct}` : null,
    p.take_profit != null && !isMarket ? `Take profit: $${p.take_profit.toFixed(2)}${takePct}` : null,
    `Confidence: ${p.confidence.toFixed(2)}`,
    '',
    `Thesis:`,
    `${p.asset} 12-1 month momentum score ${p.confidence > 0 ? '+' : ''}${p.confidence.toFixed(2)}. Tier 0 auto-thesis (committee in Phase 2).`,
    '',
    `${p.trades_until_promo} more trades needed for Tier 1 review.`,
    '',
    `Use the buttons below to respond.`,
  ].filter(l => l !== null).join('\n')
}

export type TraderApprovalKeyboard = {
  inline_keyboard: Array<Array<{ text: string; callback_data: string }>>
}

/**
 * Default trade size used for the standard APPROVE button and as the base
 * the committee scales by its size_multiplier. Phase 3 Task 6 lifted this
 * from $100 to $200 once the autonomy ladder (Task 5) was in place to gate
 * size on the strategy's track record.
 */
export const DEFAULT_SIZE_USD = 200

/**
 * Larger size offered via the APPROVE BIGGER button. The button still says
 * "$250" because it is a discretionary override on top of the default.
 */
export const BIGGER_SIZE_USD = 250

export function buildApprovalKeyboard(approvalId: string): TraderApprovalKeyboard {
  return {
    inline_keyboard: [
      [
        { text: 'APPROVE', callback_data: `trader:approve:${approvalId}` },
        { text: 'SKIP', callback_data: `trader:skip:${approvalId}` },
      ],
      [
        { text: `APPROVE $${BIGGER_SIZE_USD}`, callback_data: `trader:bigger:${approvalId}` },
        { text: 'PAUSE', callback_data: `trader:pause:${approvalId}` },
      ],
    ],
  }
}

const TIMEOUT_MS = 30 * 60 * 1000  // 30 minutes

export function createPendingApproval(db: Database.Database, signalId: string): string {
  const id = randomUUID()
  db.prepare('INSERT INTO trader_approvals (id, decision_id, sent_at) VALUES (?, ?, ?)').run(id, signalId, Date.now())
  return id
}

export interface ExpiredApproval {
  /** trader_approvals.id */
  id: string
  /** trader_approvals.decision_id (references trader_signals.id) */
  signalId: string
  /** trader_signals.asset -- may be null if the signal row is missing. */
  asset: string | null
  /** trader_signals.side -- may be null if the signal row is missing. */
  side: 'buy' | 'sell' | null
  /** Size the card was sent with. DEFAULT_SIZE_USD; changes with each cap revision. */
  sizeUsd: number
}

/**
 * Mark any pending approval older than the 30-min timeout as response='timeout'
 * and return metadata for each newly expired row so the caller can notify the
 * operator. Previously this was silent; Phase 2 Task 3 wires up a Telegram
 * alert so a missed signal is never invisible.
 *
 * Uses a LEFT JOIN so a missing signal row does not block the timeout
 * transition -- the approval still flips to 'timeout' but asset/side come
 * back as null and the caller should skip the notification.
 */
export function timeoutExpiredApprovals(db: Database.Database): ExpiredApproval[] {
  const cutoff = Date.now() - TIMEOUT_MS
  const now = Date.now()

  const rows = db.prepare(`
    SELECT a.id AS id,
           a.decision_id AS signal_id,
           s.asset AS asset,
           s.side AS side
    FROM trader_approvals a
    LEFT JOIN trader_signals s ON s.id = a.decision_id
    WHERE a.responded_at IS NULL AND a.sent_at < ?
  `).all(cutoff) as Array<{ id: string; signal_id: string; asset: string | null; side: 'buy' | 'sell' | null }>

  if (rows.length === 0) return []

  const update = db.prepare(`
    UPDATE trader_approvals
    SET response = 'timeout', responded_at = ?
    WHERE id = ?
  `)
  const txn = db.transaction(() => {
    for (const r of rows) {
      update.run(now, r.id)
      recordSignalSuppressionBySignalId(db, r.signal_id, 'timeout', now)
    }
  })
  txn()

  return rows.map((r) => ({
    id: r.id,
    signalId: r.signal_id,
    asset: r.asset,
    side: r.side,
    sizeUsd: DEFAULT_SIZE_USD,
  }))
}

/**
 * Format the operator-visible timeout message. Plain text, no markdown, no
 * em dashes -- Telegram plain text is the ClaudePaw hard rule. Returns null
 * when the signal metadata is incomplete so the caller skips the send.
 */
export function formatTimeoutNotice(expired: ExpiredApproval): string | null {
  if (!expired.asset || !expired.side) return null
  const action = expired.side.toUpperCase()
  return `Signal expired: ${expired.asset} ${action} $${expired.sizeUsd} - no trade placed.`
}
