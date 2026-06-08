import type Database from 'better-sqlite3'
import type { EngineClient } from './engine-client.js'
import type { EngineOrder } from './types.js'
import { DECISION_STATUS, OPEN_AT_BROKER } from './order-lifecycle.js'
import { logger } from '../logger.js'
import { recordFill } from './audit-log.js'

/**
 * How old a submitted/pending_fill decision must be (ms) before a missing
 * broker record is treated as a permanent orphan rather than propagation lag.
 * 6 hours gives ample time for broker API propagation and Tailscale blips.
 */
export const RECONCILE_ORPHAN_HORIZON_MS = 6 * 60 * 60 * 1000

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
}

/**
 * Reconcile every decision the brain believes is live at the broker
 * (submitted / pending_fill) against the engine's order snapshot.
 *
 * Source of truth is GET /orders -> EngineOrder[]. We match by
 * broker_order_id (engine_order_id on our side) and fall back to
 * client_order_id == decision.id. Transitions:
 *   filled_qty > 0 and status terminal-filled  -> executed
 *   live but unfilled                          -> pending_fill
 *   canceled / rejected / expired              -> failed
 *
 * ENGINE DEPENDENCY: today the engine never reports filled_qty>0 or a
 * 'filled' status (it writes only 'placed'). Until that lands, this
 * function correctly leaves rows at submitted/pending_fill and promotes
 * nothing. No row is ever fabricated to 'executed'. See engineDependencies.
 */
export async function reconcileOpenOrders(
  db: Database.Database,
  client: EngineClient,
  send?: (text: string) => Promise<void>,
): Promise<ReconcileSummary> {
  const open = db
    .prepare(
      `SELECT id, asset, action, size_usd, engine_order_id, status, decided_at
       FROM trader_decisions
       WHERE status IN (${OPEN_AT_BROKER.map(() => '?').join(',')})`,
    )
    .all(...OPEN_AT_BROKER) as OpenRow[]

  const summary: ReconcileSummary = {
    checked: open.length,
    promotedToFilled: 0,
    promotedToPending: 0,
    canceledOrRejected: 0,
    expiredOrphans: 0,
  }
  if (open.length === 0) return summary

  // Source of truth: the broker order snapshot. One call per tick.
  let orders: EngineOrder[]
  try {
    orders = await client.getOrders()
  } catch (err) {
    // Engine unreachable: do NOT mutate. Leave rows live; next tick retries.
    logger.warn({ err }, 'Order reconcile: getOrders failed, skipping (no mutation)')
    return summary
  }

  for (const row of open) {
    const match = orders.find(
      (o) =>
        (row.engine_order_id != null && o.broker_order_id === row.engine_order_id) ||
        o.client_order_id === row.id,
    )
    if (!match) {
      // No broker record. Recent orders may still be propagating -- skip them.
      // Old orders with no broker record after RECONCILE_ORPHAN_HORIZON_MS are
      // true orphans: the submit may have silently failed or been lost. Mark
      // failed and alert so the signal is not silently stuck forever.
      const age = Date.now() - row.decided_at
      if (age < RECONCILE_ORPHAN_HORIZON_MS) continue
      db.prepare(`UPDATE trader_decisions SET status = ? WHERE id = ?`).run(
        DECISION_STATUS.FAILED,
        row.id,
      )
      summary.expiredOrphans++
      logger.warn({ decisionId: row.id, asset: row.asset, ageMs: age }, 'Order reconcile: orphan order expired (no broker record after horizon), marking failed')
      await send?.(
        `TRADER ALERT: Decision ${row.id} (${row.asset} ${row.action}) has no broker record after ${Math.round(age / 3600000)}h. Marked failed -- possible silent submit loss.`,
      ).catch(() => {/* send must not block */})
      continue
    }

    const status = match.status.toLowerCase()
    const filled = typeof match.filled_qty === 'number' ? match.filled_qty : 0

    if (filled > 0 && (status === 'filled' || status === 'partially_filled')) {
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
      // fees_usd = 0 because the engine does not expose fees yet; the realized
      // P&L layer notes this in its lot_match_rule column.
      const brokerFillId = `${match.broker_order_id ?? row.id}:${filled}`
      recordFill(db, {
        decisionId:     row.id,
        clientOrderId:  row.id,
        brokerOrderId:  match.broker_order_id ?? null,
        asset:          row.asset,
        side:           (row.action === 'sell' ? 'sell' : 'buy') as 'buy' | 'sell',
        fillQty:        filled,
        fillPrice:      match.filled_avg_price ?? 0,
        fillTsMs:       match.updated_at,
        feeUsd:         0,
      }, Date.now(), brokerFillId)
      summary.promotedToFilled++
      logger.info({ decisionId: row.id, asset: row.asset, filled }, 'Order reconcile: promoted to executed (filled)')
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
  return summary
}
