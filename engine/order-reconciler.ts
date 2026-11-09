import type Database from 'better-sqlite3'
import type { EngineClient } from './engine-client.js'
import type { EngineOrder } from './types.js'
import { DECISION_STATUS, OPEN_AT_BROKER, matchesBrokerOrder } from './order-lifecycle.js'
import { logger } from '../logger.js'
import { renderAlert, explainLostOrder } from './plain-english.js'
import { recordFill, upsertCumulativeOrderFill } from './audit-log.js'
import { recordTraderOperationalEvent } from './operational-events.js'

/**
 * How old a submitted/pending_fill decision must be (ms) before a missing
 * broker record is treated as a permanent orphan rather than propagation lag.
 * 6 hours gives ample time for broker API propagation and Tailscale blips.
 */
export const RECONCILE_ORPHAN_HORIZON_MS = 6 * 60 * 60 * 1000

/**
 * After 15 minutes without a match, recover using the same immutable exit ID.
 * Missing from an order window is not proof the broker rejected the order.
 */
export const EXIT_ORPHAN_HORIZON_MS = 15 * 60 * 1000

export interface ReconcileSummary {
  checked: number
  promotedToFilled: number
  promotedToPending: number
  canceledOrRejected: number
  expiredOrphans: number
}

interface OpenRow {
  id: string
  asset: string
  action: string
  size_usd: number
  engine_order_id: string | null
  status: string
  decided_at: number
  parent_decision_id: string | null
  /** Entry reference price resolved at dispatch; the slippage baseline. */
  entry_price: number | null
  filled_qty: number | null
}

/**
 * The price we expected to trade at, used as the slippage baseline. Null when
 * the dispatcher could not resolve an entry reference (enrichment missing and
 * the engine price fetch failed), in which case slippage stays 0 because there
 * is nothing to measure against, rather than being silently assumed perfect.
 */
function intendedPriceOf(row: OpenRow): number | null {
  return row.entry_price != null && row.entry_price > 0 ? row.entry_price : null
}

/**
 * Reconcile every decision the brain believes is live at the broker
 * (submitted / pending_fill) against the engine's order snapshot.
 *
 * Source of truth is GET /orders -> EngineOrder[]. We match the brain's
 * engine_order_id to broker_order_id and fall back to the engine's persisted
 * decision_id. Transitions:
 *   filled_qty > 0 and status terminal-filled  -> executed
 *   live but unfilled                          -> pending_fill
 *   canceled / rejected / expired              -> failed
 *
 * Only broker-confirmed fills advance the lifecycle; partial exits retain
 * their in-flight guard until terminal completion or cancellation.
 */
export async function reconcileOpenOrders(
  db: Database.Database,
  client: EngineClient,
  send?: (text: string) => Promise<void>,
): Promise<ReconcileSummary> {
  const reconcileStartedAt = Date.now()
  // Exit rows (status exit_submitted) are tracked alongside entries: a lost
  // exit means an open position is unmanaged while the duplicate guard blocks
  // any retry, so they MUST be reconciled against the broker every tick.
  const open = db
    .prepare(
      `SELECT id, asset, action, size_usd, engine_order_id, status, decided_at, parent_decision_id,
              entry_price, filled_qty
       FROM trader_decisions
       WHERE status IN (${OPEN_AT_BROKER.map(() => '?').join(',')}, ?, ?, ?)`,
    )
    .all(...OPEN_AT_BROKER, DECISION_STATUS.EXIT_SUBMITTED, DECISION_STATUS.EXIT_UNKNOWN, DECISION_STATUS.EXECUTED) as OpenRow[]

  const summary: ReconcileSummary = {
    checked: open.length,
    promotedToFilled: 0,
    promotedToPending: 0,
    canceledOrRejected: 0,
    expiredOrphans: 0,
  }
  if (open.length === 0) {
    recordTraderOperationalEvent(db, {
      sourceTs: reconcileStartedAt,
      source: 'brain.reconciler',
      stage: 'reconcile',
      eventType: 'reconcile.run.completed',
      state: 'completed',
      metadata: { checked: 0 },
    })
    return summary
  }

  // Source of truth: the broker order snapshot. One call per tick.
  let orders: EngineOrder[]
  try {
    orders = await client.getOrders()
  } catch (err) {
    // Engine unreachable: do NOT mutate. Leave rows live; next tick retries.
    logger.warn({ err }, 'Order reconcile: getOrders failed, skipping (no mutation)')
    recordTraderOperationalEvent(db, {
      sourceTs: reconcileStartedAt,
      source: 'brain.reconciler',
      stage: 'reconcile',
      eventType: 'reconcile.run.failed',
      state: 'failed',
      metadata: { checked: open.length, reason: 'engine_unreachable' },
    })
    return summary
  }

  for (const row of open) {
    const isExit = row.status === DECISION_STATUS.EXIT_SUBMITTED || row.status === DECISION_STATUS.EXIT_UNKNOWN
    const match = orders.find((o) => matchesBrokerOrder(o, row))
    if (!match) {
      // No broker record. Recent orders may still be propagating -- skip them.
      // Missing exits retain their ID for recovery, never blind replacement.
      // Entry orphan handling remains a separate historical policy.
      if (row.status === DECISION_STATUS.EXECUTED) continue
      const age = Date.now() - row.decided_at
      const horizon = isExit ? EXIT_ORPHAN_HORIZON_MS : RECONCILE_ORPHAN_HORIZON_MS
      if (age < horizon) continue
      if (isExit) {
        db.prepare('UPDATE trader_decisions SET status=? WHERE id=?').run(DECISION_STATUS.EXIT_UNKNOWN, row.id)
        summary.expiredOrphans++
        logger.warn(
          { decisionId: row.id, parentDecisionId: row.parent_decision_id, asset: row.asset, ageMs: age },
          'Order reconcile: exit not in order window; retain ID for idempotent recovery',
        )
        continue
      }
      db.prepare(`UPDATE trader_decisions SET status = ? WHERE id = ?`).run(
        DECISION_STATUS.FAILED,
        row.id,
      )
      summary.expiredOrphans++
      logger.warn({ decisionId: row.id, asset: row.asset, ageMs: age }, 'Order reconcile: orphan order expired (no broker record after horizon), marking failed')
      await send?.(
        renderAlert(explainLostOrder(row.asset, row.action, Math.round(age / 3600000))),
      ).catch(() => {/* send must not block */})
      continue
    }

    const status = match.status.toLowerCase()
    const filled = typeof match.filled_qty === 'number' ? match.filled_qty : 0

    if (isExit) {
      // Cache every observed execution, including a canceled partial fill.
      // A partial order is still live: preserve its duplicate guard.
      const terminalFailure = ['canceled', 'rejected', 'expired', 'failed'].includes(status)
      if (filled > 0) {
        db.prepare(
          `UPDATE trader_decisions SET status = ?, filled_qty = ?, filled_avg_price = ? WHERE id = ?`,
        ).run(status === 'filled' ? DECISION_STATUS.CLOSED : DECISION_STATUS.EXIT_SUBMITTED,
          filled, match.filled_avg_price ?? null, row.id)
        const fillInput = {
          decisionId:    row.id,
          clientOrderId: row.id,
          asset:         row.asset,
          side:          (row.action === 'sell' ? 'sell' : 'buy') as 'buy' | 'sell',
          fillQty:       filled,
          fillPrice:     match.filled_avg_price ?? 0,
          // Same slippage baseline as the entry path: the exit decision's
          // reference price. Without it recordFill records zero slippage.
          intendedPrice: intendedPriceOf(row),
          intendedTsMs:  row.decided_at,
          fillTsMs:      match.updated_at,
          feeUsd:        0,
        }
        if (match.broker_order_id) {
          upsertCumulativeOrderFill(db, {...fillInput, brokerOrderId: match.broker_order_id}, Date.now())
        } else {
          recordFill(db, {...fillInput, brokerOrderId: null}, Date.now(), `${row.id}:${filled}`)
        }
        if (status === 'filled') summary.promotedToFilled++
        logger.info({ decisionId: row.id, asset: row.asset, filled, status }, 'Order reconcile: exit execution recorded')
      }
      if (terminalFailure) {
        db.prepare('UPDATE trader_decisions SET status=? WHERE id=?').run(DECISION_STATUS.FAILED, row.id)
        summary.canceledOrRejected++
        logger.warn({ decisionId: row.id, asset: row.asset, status }, 'Order reconcile: terminal exit retained for audit; remaining position may be retried')
      }
      continue
    }

    if (filled > 0) {
      if (row.filled_qty != null && filled < row.filled_qty) continue
      // Confirmed fill. Promote to executed and cache the fill numbers.
      // NOTE: for partially_filled the cached filled_qty may lag the final
      // total if the order continues filling. The verdict path calls
      // rollUpFills over live getOrders() results directly, so it always
      // reads the authoritative total -- the cached value here is only used
      // for fast dashboard display and does not affect PnL calculation.
      db.prepare(
        `UPDATE trader_decisions
         SET status = ?, filled_qty = ?, filled_avg_price = ?
         WHERE id = ?`,
      ).run(DECISION_STATUS.EXECUTED, filled, match.filled_avg_price ?? null, row.id)
      // Write an immutable fill row to the audit log. The broker_fill_id is
      // stable across reconcile ticks so INSERT OR IGNORE makes this idempotent.
      //
      // Costs: Alpaca equities are commission-free, so feeUsd 0 is genuinely
      // correct there and the engine exposes no fee field to read anyway. The
      // real execution cost is SLIPPAGE, and it was silently zero on all 190
      // fills recorded to 2026-08-02 for a mechanical reason: recordFill
      // computes slippage via computeSlippageUsd, but that returns 0 when
      // intendedPrice is null, and this call site never passed one. Passing the
      // decision's entry reference price fixes it without touching the engine.
      const fillInput = {
        decisionId:     row.id,
        clientOrderId:  row.id,
        asset:          row.asset,
        side:           (row.action === 'sell' ? 'sell' : 'buy') as 'buy' | 'sell',
        fillQty:        filled,
        fillPrice:      match.filled_avg_price ?? 0,
        intendedPrice:  intendedPriceOf(row),
        intendedTsMs:   row.decided_at,
        fillTsMs:       match.updated_at,
        feeUsd:         0,
      }
      if (match.broker_order_id) {
        upsertCumulativeOrderFill(db, {...fillInput, brokerOrderId: match.broker_order_id}, Date.now())
      } else {
        recordFill(db, {...fillInput, brokerOrderId: null}, Date.now(), `${row.id}:${filled}`)
      }
      if (row.status !== DECISION_STATUS.EXECUTED || row.filled_qty !== filled) summary.promotedToFilled++
      logger.info({ decisionId: row.id, asset: row.asset, filled }, 'Order reconcile: promoted to executed (filled)')
    } else if (row.status === DECISION_STATUS.EXECUTED) {
      // A previously observed partial fill remains real even when a later
      // order snapshot is terminal or temporarily reports no fill.
      continue
    } else if (status === 'canceled' || status === 'rejected' || status === 'expired') {
      db.prepare(`UPDATE trader_decisions SET status = ? WHERE id = ?`).run(
        DECISION_STATUS.FAILED,
        row.id,
      )
      summary.canceledOrRejected++
      logger.warn({ decisionId: row.id, asset: row.asset, status }, 'Order reconcile: order canceled/rejected, marking failed')
    } else if (row.status === DECISION_STATUS.SUBMITTED) {
      // Live at broker, not yet filled: advance submitted -> pending_fill once.
      db.prepare(`UPDATE trader_decisions SET status = ? WHERE id = ?`).run(
        DECISION_STATUS.PENDING_FILL,
        row.id,
      )
      summary.promotedToPending++
    }
  }
  recordTraderOperationalEvent(db, {
    sourceTs: reconcileStartedAt,
    source: 'brain.reconciler',
    stage: 'reconcile',
    eventType: 'reconcile.run.completed',
    state: summary.canceledOrRejected > 0 || summary.expiredOrphans > 0 ? 'warning' : 'completed',
    metadata: {
      checked: summary.checked,
      promoted_to_filled: summary.promotedToFilled,
      promoted_to_pending: summary.promotedToPending,
      canceled_or_rejected: summary.canceledOrRejected,
      expired_orphans: summary.expiredOrphans,
    },
  })
  return summary
}
