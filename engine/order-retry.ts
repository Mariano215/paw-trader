import type Database from 'better-sqlite3'
import type { EngineClient } from './engine-client.js'
import type { EngineOrder } from './types.js'
import { DECISION_STATUS, MAX_SUBMIT_RETRIES } from './order-lifecycle.js'
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
}

/**
 * Re-attempt decisions parked at retry_pending whose next_retry_at has
 * elapsed. Duplicate-safe: BEFORE resending, fetch GET /orders and skip
 * any decision whose order already exists at the broker (matched by
 * client_order_id == decision.id) -- that order is the reconcile phase's
 * job, not ours. After MAX_SUBMIT_RETRIES, park at engine_down (terminal
 * but resumable). On the next tick where the engine is healthy, callers
 * pass engineHealthy=true and any engine_down rows are returned to
 * retry_pending so they resume cleanly.
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
      `SELECT id, signal_id, asset, action, size_usd, entry_type, confidence, submit_attempts
       FROM trader_decisions
       WHERE status = ? AND (next_retry_at IS NULL OR next_retry_at <= ?)`,
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
    const alreadyAtBroker = orders.some((o) => o.client_order_id === row.id)
    if (alreadyAtBroker) {
      // The original submit DID reach the broker. Reconcile owns it now;
      // flip back to submitted so the reconcile phase tracks it.
      db.prepare("UPDATE trader_decisions SET status = ? WHERE id = ?").run(DECISION_STATUS.SUBMITTED, row.id)
      continue
    }
    if (row.submit_attempts >= MAX_SUBMIT_RETRIES) {
      db.prepare("UPDATE trader_decisions SET status = ? WHERE id = ?").run(DECISION_STATUS.ENGINE_DOWN, row.id)
      summary.parkedEngineDown++
      continue
    }
    try {
      const res = await client.submitDecision({
        decision_id: row.id,
        asset: row.asset,
        side: row.action as 'buy' | 'sell',
        size_usd: row.size_usd,
        entry_type: row.entry_type,
        entry_price: 0,
        strategy: '',
        confidence: row.confidence,
      })
      db.prepare(
        "UPDATE trader_decisions SET status = ?, engine_order_id = ?, submit_attempts = submit_attempts + 1 WHERE id = ?",
      ).run(DECISION_STATUS.SUBMITTED, res.broker_order_id ?? null, row.id)
      summary.resubmitted++
    } catch (err) {
      const backoffMs = 5 * 60 * 1000
      db.prepare(
        "UPDATE trader_decisions SET submit_attempts = submit_attempts + 1, next_retry_at = ? WHERE id = ?",
      ).run(now + backoffMs, row.id)
      logger.warn({ err, decisionId: row.id }, 'Retry sweep: resubmit failed, backing off')
    }
  }
  return summary
}
