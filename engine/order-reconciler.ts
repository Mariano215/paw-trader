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

/**
 * Exit rows get a much shorter orphan horizon: an exit_submitted row with no
 * broker record means an OPEN POSITION IS UNMANAGED while the duplicate guard
 * blocks any retry. Live incident 2026-06-11: two pre-market exits were
 * accepted by the engine, the engine restarted, the queued orders were lost,
 * and the rows blocked re-exit forever. 15 minutes covers propagation lag
 * without leaving risk unmanaged for hours.
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
  // Exit rows (status exit_submitted) are tracked alongside entries: a lost
  // exit means an open position is unmanaged while the duplicate guard blocks
  // any retry, so they MUST be reconciled against the broker every tick.
  const open = db
    .prepare(
      `SELECT id, asset, action, size_usd, engine_order_id, status, decided_at, parent_decision_id
       FROM trader_decisions
       WHERE status IN (${OPEN_AT_BROKER.map(() => '?').join(',')}, ?)`,
    )
    .all(...OPEN_AT_BROKER, DECISION_STATUS.EXIT_SUBMITTED) as OpenRow[]

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
    const isExit = row.status === DECISION_STATUS.EXIT_SUBMITTED
    const match = orders.find(
      (o) =>
        (row.engine_order_id != null && o.broker_order_id === row.engine_order_id) ||
        o.client_order_id === row.id,
    )
    if (!match) {
      // No broker record. Recent orders may still be propagating -- skip them.
      // Old orders with no broker record after the horizon are true orphans:
      // the submit may have silently failed or been lost (e.g. queued in the
      // engine across a restart). Entries are marked failed; exit rows are
      // DELETED so the duplicate guard frees and the next sweep re-submits
      // the close.
      const age = Date.now() - row.decided_at
      const horizon = isExit ? EXIT_ORPHAN_HORIZON_MS : RECONCILE_ORPHAN_HORIZON_MS
      if (age < horizon) continue
      if (isExit) {
        db.prepare(`DELETE FROM trader_decisions WHERE id = ?`).run(row.id)
        summary.expiredOrphans++
        logger.warn(
          { decisionId: row.id, parentDecisionId: row.parent_decision_id, asset: row.asset, ageMs: age },
          'Order reconcile: exit order lost (no broker record after horizon), row removed so the exit sweep retries',
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
        `TRADER ALERT: Decision ${row.id} (${row.asset} ${row.action}) has no broker record after ${Math.round(age / 3600000)}h. Marked failed -- possible silent submit loss.`,
      ).catch(() => {/* send must not block */})
      continue
    }

    const status = match.status.toLowerCase()
    const filled = typeof match.filled_qty === 'number' ? match.filled_qty : 0

    if (isExit) {
      // Exit lifecycle: filled -> closed (terminal); canceled/rejected ->
      // delete the row so the sweep retries; live unfilled -> leave at
      // exit_submitted (it IS the guard state).
      if (filled > 0 && (status === 'filled' || status === 'partially_filled')) {
        db.prepare(
          `UPDATE trader_decisions SET status = ?, filled_qty = ?, filled_avg_price = ? WHERE id = ?`,
        ).run(DECISION_STATUS.CLOSED, filled, match.filled_avg_price ?? null, row.id)
        recordFill(db, {
          decisionId:    row.id,
          clientOrderId: row.id,
          brokerOrderId: match.broker_order_id ?? null,
          asset:         row.asset,
          side:          (row.action === 'sell' ? 'sell' : 'buy') as 'buy' | 'sell',
          fillQty:       filled,
          fillPrice:     match.filled_avg_price ?? 0,
          fillTsMs:      match.updated_at,
          feeUsd:        0,
        }, Date.now(), `${match.broker_order_id ?? row.id}:${filled}`)
        summary.promotedToFilled++
        logger.info({ decisionId: row.id, asset: row.asset, filled }, 'Order reconcile: exit filled, decision closed')
      } else if (status === 'canceled' || status === 'rejected' || status === 'expired') {
        db.prepare(`DELETE FROM trader_decisions WHERE id = ?`).run(row.id)
        summary.canceledOrRejected++
        logger.warn({ decisionId: row.id, asset: row.asset, status }, 'Order reconcile: exit order canceled/rejected, row removed so the exit sweep retries')
      }
      continue
    }

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
