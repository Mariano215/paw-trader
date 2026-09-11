import type Database from 'better-sqlite3'
import type { EngineClient } from './engine-client.js'
import type { EngineOrder } from './types.js'
import { DECISION_STATUS, MAX_SUBMIT_RETRIES, matchesBrokerOrder, isTerminalSubmitError } from './order-lifecycle.js'
import { recordTraderOperationalEvent } from './operational-events.js'
import { logger } from '../logger.js'

export interface RetrySweepSummary {
  eligible: number
  resubmitted: number
  parkedEngineDown: number
  resumedFromEngineDown: number
}

interface RetryRow {
  id: string
  signal_id: string
  asset: string
  action: string
  size_usd: number
  entry_type: string
  confidence: number
  submit_attempts: number
  engine_order_id: string | null
  entry_price: number | null
  stop_loss: number | null
  take_profit: number | null
  generated_at: number
  strategy_id: string
  strategy_status: string
}

export const MAX_RETRY_SIGNAL_AGE_MS = 30 * 60 * 1000

/**
 * Re-attempt decisions parked at retry_pending whose next_retry_at has
 * elapsed. BEFORE resending, fetch GET /orders and skip
 * any decision whose order already exists at the broker (matchesBrokerOrder,
 * shared with the reconciler) -- that order is the reconcile phase's job, not
 * ours. This guard previously compared client_order_id to the decision id,
 * which the engine never echoes back, so it matched nothing and the sweep
 * could place a second real broker order for a decision already live.
 * Expired, unprotected, paused or exhausted intents terminate after this
 * reconciliation check. Full duplicate safety still requires engine-side
 * idempotency: the broker snapshot alone cannot exclude late acceptance.
 */
export async function runRetrySweep(
  db: Database.Database,
  client: EngineClient,
  now: number,
  engineHealthy: boolean,
): Promise<RetrySweepSummary> {
  const summary: RetrySweepSummary = {
    eligible: 0,
    resubmitted: 0,
    parkedEngineDown: 0,
    resumedFromEngineDown: 0,
  }

  // Resume: engine is healthy again, un-park engine_down -> retry_pending
  // with a fresh immediate eligibility so the sweep below picks them up.
  if (engineHealthy) {
    const resumed = db
      .prepare(
        "UPDATE trader_decisions SET status = ?, next_retry_at = ? WHERE status = ?",
      )
      .run(DECISION_STATUS.RETRY_PENDING, now, DECISION_STATUS.ENGINE_DOWN)
    summary.resumedFromEngineDown = resumed.changes
  }

  const due = db
    .prepare(
      `SELECT d.id, d.signal_id, d.asset, d.action, d.size_usd, d.entry_type, d.confidence,
              d.submit_attempts, d.engine_order_id, d.entry_price, d.stop_loss, d.take_profit,
              s.generated_at, s.strategy_id, st.status AS strategy_status
       FROM trader_decisions d
       LEFT JOIN trader_signals s ON s.id = d.signal_id
       LEFT JOIN trader_strategies st ON st.id = s.strategy_id
       WHERE d.status = ? AND (d.next_retry_at IS NULL OR d.next_retry_at <= ?)`,
    )
    .all(DECISION_STATUS.RETRY_PENDING, now) as RetryRow[]
  summary.eligible = due.length
  if (due.length === 0) return summary

  // Duplicate guard: fetch the broker snapshot once. If getOrders fails the
  // engine is down -- park everything at engine_down and bail (no blind resend).
  let orders: EngineOrder[]
  try {
    orders = await client.getOrders()
  } catch (err) {
    for (const row of due) {
      db.prepare("UPDATE trader_decisions SET status = ? WHERE id = ?").run(DECISION_STATUS.ENGINE_DOWN, row.id)
      summary.parkedEngineDown++
    }
    logger.warn({ err, parked: summary.parkedEngineDown }, 'Retry sweep: engine unreachable, parked engine_down')
    return summary
  }

  for (const row of due) {
    const alreadyAtBroker = orders.some((o) => matchesBrokerOrder(o, row))
    if (alreadyAtBroker) {
      // The original submit DID reach the broker. Reconcile owns it now;
      // flip back to submitted so the reconcile phase tracks it.
      db.prepare("UPDATE trader_decisions SET status = ? WHERE id = ?").run(DECISION_STATUS.SUBMITTED, row.id)
      continue
    }
    // Reconcile first: a late broker acknowledgement still owns real exposure.
    const invalid = row.submit_attempts >= MAX_SUBMIT_RETRIES ? 'retry budget exhausted'
      : row.strategy_status !== 'active' ? 'strategy is not active'
      : !Number.isFinite(row.generated_at) || now < row.generated_at || now - row.generated_at > MAX_RETRY_SIGNAL_AGE_MS ? 'signal expired'
      : row.action !== 'buy' ? 'entry retry does not support this side'
      : row.entry_type !== 'limit' ? 'entry retry is not a limit order'
      : !(row.entry_price != null && Number.isFinite(row.entry_price) && row.entry_price > 0 &&
          row.stop_loss != null && Number.isFinite(row.stop_loss) && row.stop_loss > 0 && row.stop_loss < row.entry_price &&
          row.take_profit != null && Number.isFinite(row.take_profit) && row.take_profit > row.entry_price)
        ? 'entry protection is missing or invalid' : null
    if (invalid) {
      db.prepare("UPDATE trader_decisions SET status = ?, next_retry_at = NULL, thesis = thesis || ? WHERE id = ?")
        .run(DECISION_STATUS.FAILED, ` [Retry stopped: ${invalid}]`, row.id)
      logger.warn({ decisionId: row.id, reason: invalid }, 'Retry intent terminated')
      continue
    }
    try {
      const res = await client.submitDecision({
        decision_id: row.id,
        asset: row.asset,
        side: row.action as 'buy' | 'sell',
        size_usd: row.size_usd,
        entry_type: 'limit',
        entry_price: row.entry_price!,
        stop_loss: row.stop_loss!,
        take_profit: row.take_profit!,
        strategy: row.strategy_id,
        confidence: row.confidence,
      })
      db.prepare(
        "UPDATE trader_decisions SET status = ?, engine_order_id = ?, submit_attempts = submit_attempts + 1 WHERE id = ?",
      ).run(DECISION_STATUS.SUBMITTED, res.broker_order_id ?? null, row.id)
      recordTraderOperationalEvent(db, {
        eventId: `retry-submitted:${row.id}:${row.submit_attempts + 1}`,
        sourceTs: now,
        source: 'brain.order-retry',
        stage: 'broker',
        eventType: 'broker.order.retry_submitted',
        state: 'submitted',
        asset: row.asset,
        strategyId: row.strategy_id,
        signalId: row.signal_id,
        decisionId: row.id,
        orderId: res.broker_order_id ?? null,
        metadata: { side: row.action, size_usd: row.size_usd, status: res.status },
      })
      summary.resubmitted++
    } catch (err) {
      if (isTerminalSubmitError(err)) {
        db.prepare("UPDATE trader_decisions SET status = ?, next_retry_at = NULL WHERE id = ?")
          .run(DECISION_STATUS.FAILED, row.id)
        logger.warn({ decisionId: row.id }, 'Retry rejected permanently by engine')
        continue
      }
      const backoffMs = 5 * 60 * 1000
      db.prepare(
        "UPDATE trader_decisions SET submit_attempts = submit_attempts + 1, next_retry_at = ? WHERE id = ?",
      ).run(now + backoffMs, row.id)
      logger.warn({ err, decisionId: row.id }, 'Retry sweep: resubmit failed, backing off')
    }
  }
  return summary
}
