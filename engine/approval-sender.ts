import type Database from 'better-sqlite3'
import { buildApprovalCard, buildApprovalKeyboard, createPendingApproval, DEFAULT_SIZE_USD, type TraderApprovalKeyboard } from './approval-manager.js'
import { TRADER_BLIND_SIGNAL_SCORE_THRESHOLD } from '../config.js'
import { shouldSuppressSignalRealert } from './suppression-state.js'
import { logger } from '../logger.js'

// Trade count target for the promo ladder banner. Mirrors the autonomy
// ladder's cold-start gate (autonomy-ladder.ts:COLD_START_TRADES) so the
// banner countdown matches the moment cold-start scaling lifts.
// Paired cap constant DEFAULT_SIZE_USD lives in approval-manager.ts.
const TIER1_TRADE_COUNT_TARGET = 30

function isBlindLowConvictionSignal(signal: PendingSignalRow): boolean {
  return !signal.enrichment_json &&
    Math.abs(signal.raw_score) < TRADER_BLIND_SIGNAL_SCORE_THRESHOLD
}

export interface SendPendingApprovalsDeps {
  /** Called once per pending signal with the card text and inline keyboard. */
  sendWithKeyboard: (text: string, keyboard: TraderApprovalKeyboard) => Promise<void>
}

interface PendingSignalRow {
  id: string
  strategy_id: string
  asset: string
  side: 'buy' | 'sell'
  raw_score: number
  horizon_days: number
  enrichment_json: string | null
  generated_at: number
  status: string
}

interface StrategyRow {
  id: string
  name: string
  tier: number
  status: string
}

/**
 * Scan trader_signals for pending rows that have no corresponding trader_approvals row yet,
 * insert an approval record for each, and fire the approval card through `deps.send`.
 *
 * Signals attached to a paused strategy are skipped (but left pending so they can be
 * re-examined if the strategy resumes). Engine/Telegram failures are logged but do not
 * throw -- the caller (scheduler) is already guarding against exceptions.
 *
 * Returns the number of approval cards actually sent.
 */
export async function sendPendingApprovals(
  db: Database.Database,
  deps: SendPendingApprovalsDeps,
): Promise<number> {
  const signals = db.prepare(`
    SELECT s.*
    FROM trader_signals s
    LEFT JOIN trader_approvals a ON a.decision_id = s.id
    WHERE s.status = 'pending' AND a.id IS NULL
    ORDER BY s.raw_score DESC
  `).all() as PendingSignalRow[]

  if (signals.length === 0) return 0

  // Cached lookups for this sweep.
  const strategyCache = new Map<string, StrategyRow | null>()
  const getStrategy = (id: string): StrategyRow | null => {
    if (strategyCache.has(id)) return strategyCache.get(id)!
    const row = db.prepare(
      'SELECT id, name, tier, status FROM trader_strategies WHERE id = ?',
    ).get(id) as StrategyRow | undefined
    strategyCache.set(id, row ?? null)
    return row ?? null
  }

  // Trade counter is read once -- the in-flight sends for this sweep do not
  // change the executed count, they only create pending approval rows.
  const executedRow = db.prepare(
    "SELECT COUNT(*) AS n FROM trader_decisions WHERE status = 'executed'",
  ).get() as { n: number }
  const tradesSoFar = executedRow.n

  let sent = 0
  for (const signal of signals) {
    const strategy = getStrategy(signal.strategy_id)
    if (!strategy) {
      logger.warn({ signalId: signal.id, strategyId: signal.strategy_id }, 'Skipping signal: strategy missing')
      continue
    }
    if (strategy.status === 'paused') {
      logger.info({ signalId: signal.id, strategyId: strategy.id }, 'Skipping signal: strategy paused')
      continue
    }

    if (shouldSuppressSignalRealert(db, {
      strategy_id: signal.strategy_id,
      asset: signal.asset,
      side: signal.side,
      raw_score: signal.raw_score,
      enrichment_json: signal.enrichment_json,
    })) {
      logger.info(
        { signalId: signal.id, strategyId: signal.strategy_id, asset: signal.asset, side: signal.side },
        'Skipping signal: no material change since recent suppression',
      )
      db.prepare("UPDATE trader_signals SET status = 'suppressed_no_material_change' WHERE id = ?").run(signal.id)
      continue
    }

    if (isBlindLowConvictionSignal(signal)) {
      logger.info(
        {
          signalId: signal.id,
          strategyId: signal.strategy_id,
          asset: signal.asset,
          rawScore: signal.raw_score,
          blindThreshold: TRADER_BLIND_SIGNAL_SCORE_THRESHOLD,
        },
        'Suppressing blind low-conviction signal before operator alert',
      )
      db.prepare("UPDATE trader_signals SET status = 'suppressed_blind_low_score' WHERE id = ?").run(signal.id)
      continue
    }

    const tradeNum = tradesSoFar + sent + 1
    const tradesUntilPromo = Math.max(0, TIER1_TRADE_COUNT_TARGET - tradesSoFar - sent)

    const card = buildApprovalCard({
      asset: signal.asset,
      side: signal.side,
      size_usd: DEFAULT_SIZE_USD,
      // Phase 1 engine resolves the actual price at fill, so we render
      // this as a market order card. entry_price=0 triggers the market
      // formatting in buildApprovalCard.
      entry_price: 0,
      confidence: signal.raw_score,
      strategy_name: strategy.name,
      tier: strategy.tier,
      trade_num: tradeNum,
      trades_until_promo: tradesUntilPromo,
    })

    // Insert approval row first so the Telegram reply handler can match the
    // response to an approval even if a reply races the send ack.
    let approvalId: string
    try {
      approvalId = createPendingApproval(db, signal.id)
    } catch (err) {
      logger.error({ err, signalId: signal.id }, 'Failed to insert pending approval row')
      continue
    }

    try {
      await deps.sendWithKeyboard(card, buildApprovalKeyboard(approvalId))
      sent++
    } catch (err) {
      // Send failed: roll back the approval row so the next sweep will retry.
      // We keep the signal pending so it is not lost.
      logger.error({ err, signalId: signal.id, approvalId }, 'Approval send failed, rolling back approval row')
      db.prepare('DELETE FROM trader_approvals WHERE id = ?').run(approvalId)
    }
  }

  if (sent > 0) {
    logger.info({ sent, totalPending: signals.length }, 'Sent trader approval cards')
  }
  return sent
}
