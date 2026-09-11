/**
 * Phase E Task 2 -- per-trade audit log.
 *
 * trader_fills stores broker truth. Native execution events are append-only;
 * cumulative engine order snapshots are replaced by broker order id so a
 * partial fill followed by its final quantity cannot be double-counted.
 * trader_realized_pnl is the derived layer. This module is the only writer
 * for both and is unit-tested against synthetic fills.
 *
 * Lot-matching rule for v1 is FIFO, recorded on every derived row so
 * the rule is auditable and changeable without rewriting history.
 */
import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import type { EngineOrder } from './types.js'
import { recordTraderOperationalEvent } from './operational-events.js'

export const LOT_MATCH_RULE = 'FIFO' as const

export interface FillInput {
  decisionId: string
  clientOrderId: string
  brokerOrderId?: string | null
  asset: string
  side: 'buy' | 'sell'
  fillQty: number
  fillPrice: number
  intendedPrice?: number | null
  intendedTsMs?: number | null
  fillTsMs: number
  feeUsd?: number
  entryThesis?: string | null
  exitReason?: string | null
}

export interface FillRow {
  id: string
  decision_id: string
  client_order_id: string
  broker_order_id: string | null
  asset: string
  side: 'buy' | 'sell'
  fill_qty: number
  fill_price: number
  intended_price: number | null
  intended_ts_ms: number | null
  fill_ts_ms: number
  fee_usd: number
  slippage_usd: number
  entry_thesis: string | null
  exit_reason: string | null
  recorded_at: number
}

/**
 * Slippage in USD relative to the intended price. Positive means the
 * fill was worse than intended (paid more on a buy, received less on a
 * sell). Zero when no intended price was recorded.
 */
export function computeSlippageUsd(
  side: 'buy' | 'sell',
  fillPrice: number,
  fillQty: number,
  intendedPrice: number | null | undefined,
): number {
  if (intendedPrice == null) return 0
  const perUnit = side === 'buy' ? fillPrice - intendedPrice : intendedPrice - fillPrice
  return perUnit * fillQty
}

/**
 * Append one immutable fill row. Returns the row id. Never updates an
 * existing row. The id is a fresh UUID unless the caller pins one (the
 * engine may pass a stable broker fill id to make ingestion
 * idempotent via INSERT OR IGNORE on the PK).
 */
export function recordFill(
  db: Database.Database,
  input: FillInput,
  nowMs: number = Date.now(),
  pinnedId?: string,
): string {
  const id = pinnedId ?? randomUUID()
  const slippage = computeSlippageUsd(input.side, input.fillPrice, input.fillQty, input.intendedPrice)
  const inserted = db.prepare(`
    INSERT OR IGNORE INTO trader_fills
      (id, decision_id, client_order_id, broker_order_id, asset, side,
       fill_qty, fill_price, intended_price, intended_ts_ms, fill_ts_ms,
       fee_usd, slippage_usd, entry_thesis, exit_reason, recorded_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, input.decisionId, input.clientOrderId, input.brokerOrderId ?? null,
    input.asset, input.side, input.fillQty, input.fillPrice,
    input.intendedPrice ?? null, input.intendedTsMs ?? null, input.fillTsMs,
    input.feeUsd ?? 0, slippage, input.entryThesis ?? null,
    input.exitReason ?? null, nowMs,
  )
  if (inserted.changes > 0) {
    recordTraderOperationalEvent(db, {
      eventId: `fill:${id}:${input.fillQty}:${input.fillTsMs}`,
      sourceTs: input.fillTsMs,
      recordedAt: nowMs,
      source: 'brain.fill-ledger',
      stage: 'broker',
      eventType: 'broker.fill.recorded',
      state: 'filled',
      asset: input.asset,
      decisionId: input.decisionId,
      orderId: input.brokerOrderId ?? input.clientOrderId,
      metadata: {
        side: input.side,
        filled_qty: input.fillQty,
        fill_price: input.fillPrice,
        fee_usd: input.feeUsd ?? 0,
        slippage_usd: slippage,
      },
    })
  }
  return id
}

/**
 * Store one canonical cumulative snapshot for a broker order. Engine `/orders`
 * reports cumulative filled quantity, not execution deltas. Replacing an older
 * partial snapshot prevents `3 filled` followed by `6 filled` from becoming
 * nine shares in FIFO accounting.
 */
export function upsertCumulativeOrderFill(
  db: Database.Database,
  input: FillInput & {brokerOrderId: string},
  nowMs: number = Date.now(),
): string {
  const existing = db.prepare(`
    SELECT * FROM trader_fills
    WHERE broker_order_id = ?
    ORDER BY fill_qty DESC, fill_ts_ms DESC
  `).all(input.brokerOrderId) as FillRow[]
  const best = existing[0]
  if (best && (best.fill_qty > input.fillQty ||
      (best.fill_qty === input.fillQty && (best.fill_ts_ms > input.fillTsMs ||
        (best.fill_ts_ms === input.fillTsMs && best.fill_price === input.fillPrice))))) {
    return best.id
  }

  const canonicalId = `order:${input.brokerOrderId}`
  const merged: FillInput = {
    ...input,
    intendedPrice: input.intendedPrice ?? best?.intended_price ?? null,
    intendedTsMs: input.intendedTsMs ?? best?.intended_ts_ms ?? null,
    feeUsd: Math.max(input.feeUsd ?? 0, best?.fee_usd ?? 0),
    entryThesis: input.entryThesis ?? best?.entry_thesis ?? null,
    exitReason: input.exitReason ?? best?.exit_reason ?? null,
  }
  const replace = db.transaction(() => {
    db.prepare('DELETE FROM trader_fills WHERE broker_order_id = ?').run(input.brokerOrderId)
    recordFill(db, merged, nowMs, canonicalId)
  })
  replace()
  return canonicalId
}

/** Archive cumulative engine order snapshots for decisions known to the brain. */
export function archiveCumulativeOrderFills(
  db: Database.Database,
  orders: EngineOrder[],
  nowMs: number = Date.now(),
): number {
  const findDecision = db.prepare(`
    SELECT id, entry_price, decided_at, thesis
    FROM trader_decisions
    WHERE id = ? OR engine_order_id = ?
    ORDER BY CASE WHEN id = ? THEN 0 ELSE 1 END
    LIMIT 1
  `)
  let archived = 0
  for (const order of orders) {
    if (!order.broker_order_id || !(Number.isFinite(order.filled_qty) && order.filled_qty > 0) ||
        order.filled_avg_price == null || !Number.isFinite(order.filled_avg_price) || order.filled_avg_price <= 0) continue
    const decisionKey = order.decision_id ?? order.client_order_id
    const decision = findDecision.get(decisionKey, order.broker_order_id, decisionKey) as
      | {id: string; entry_price: number | null; decided_at: number; thesis: string | null}
      | undefined
    if (!decision) continue
    upsertCumulativeOrderFill(db, {
      decisionId: decision.id,
      clientOrderId: order.client_order_id,
      brokerOrderId: order.broker_order_id,
      asset: order.asset,
      side: order.side,
      fillQty: order.filled_qty,
      fillPrice: order.filled_avg_price,
      intendedPrice: decision.entry_price,
      intendedTsMs: decision.decided_at,
      fillTsMs: order.updated_at,
      feeUsd: 0,
      entryThesis: order.side === 'buy' ? decision.thesis : null,
    }, nowMs)
    archived++
  }
  return archived
}

/** Read all fills for a decision, ascending by fill time. */
export function listFillsForDecision(db: Database.Database, decisionId: string): FillRow[] {
  return db.prepare(`
    SELECT * FROM trader_fills WHERE decision_id = ? ORDER BY fill_ts_ms ASC
  `).all(decisionId) as FillRow[]
}

/**
 * Read all fills for an asset across ALL decisions, ascending by fill time.
 * Entry (buy) fills live under the entry decision id; exit (sell) fills live
 * under a separate exit decision id. Realized P&L can only be computed by
 * pooling both legs per asset -- see recomputeRealizedPnlForAsset.
 */
export function listFillsForAsset(db: Database.Database, asset: string): FillRow[] {
  return db.prepare(`
    SELECT * FROM trader_fills WHERE asset = ? ORDER BY fill_ts_ms ASC, recorded_at ASC
  `).all(asset) as FillRow[]
}

export interface RealizedLot {
  qty: number
  entryPrice: number
  exitPrice: number
  entryTsMs: number
  exitTsMs: number
  feesUsd: number
  pnlGross: number
  pnlNet: number
  /** Decision id of the buy lot this realized row closed (valid trader_decisions FK). */
  entryDecisionId: string
  /** Decision id of the sell that closed it (may be a separate exit decision). */
  exitDecisionId: string
}

/**
 * FIFO lot matcher. Walks fills in time order, queues buy lots, and
 * closes them against sells oldest-first. Fees are pro-rated to each
 * matched quantity on both legs so pnl_net is gross minus the fees the
 * matched share carried. Partial fills split a lot. Unmatched residual
 * (open position, or a sell with no inventory) is ignored here; only
 * fully matched lots produce realized rows.
 */
export function matchLotsFifo(fills: FillRow[]): RealizedLot[] {
  interface OpenLot { qty: number; price: number; tsMs: number; feePerUnit: number; decisionId: string }
  const open: OpenLot[] = []
  const realized: RealizedLot[] = []
  for (const f of fills) {
    const feePerUnit = f.fill_qty > 0 ? f.fee_usd / f.fill_qty : 0
    if (f.side === 'buy') {
      open.push({ qty: f.fill_qty, price: f.fill_price, tsMs: f.fill_ts_ms, feePerUnit, decisionId: f.decision_id })
      continue
    }
    // Sell: close oldest buy lots first.
    let remaining = f.fill_qty
    while (remaining > 1e-12 && open.length > 0) {
      const lot = open[0]
      const matched = Math.min(remaining, lot.qty)
      const entryFee = lot.feePerUnit * matched
      const exitFee = feePerUnit * matched
      const pnlGross = (f.fill_price - lot.price) * matched
      realized.push({
        qty: matched,
        entryPrice: lot.price,
        exitPrice: f.fill_price,
        entryTsMs: lot.tsMs,
        exitTsMs: f.fill_ts_ms,
        feesUsd: entryFee + exitFee,
        pnlGross,
        pnlNet: pnlGross - entryFee - exitFee,
        entryDecisionId: lot.decisionId,
        exitDecisionId: f.decision_id,
      })
      lot.qty -= matched
      remaining -= matched
      if (lot.qty <= 1e-12) open.shift()
    }
  }
  return realized
}

/**
 * Recompute trader_realized_pnl for one decision from its fills. Pure
 * derived layer: deletes the decision's prior derived rows and rewrites
 * them so a re-run after a corrective fill is idempotent. trader_fills
 * is never touched. Returns the realized lots written.
 */
export function recomputeRealizedPnl(
  db: Database.Database,
  decisionId: string,
  nowMs: number = Date.now(),
): RealizedLot[] {
  const fills = listFillsForDecision(db, decisionId)
  if (fills.length === 0) return []
  const lots = matchLotsFifo(fills)
  const asset = fills[0].asset
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM trader_realized_pnl WHERE decision_id = ?').run(decisionId)
    const ins = db.prepare(`
      INSERT INTO trader_realized_pnl
        (id, decision_id, asset, qty, entry_price, exit_price,
         entry_ts_ms, exit_ts_ms, fees_usd, pnl_gross, pnl_net,
         lot_match_rule, computed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    for (const lot of lots) {
      ins.run(
        randomUUID(), decisionId, asset, lot.qty, lot.entryPrice, lot.exitPrice,
        lot.entryTsMs, lot.exitTsMs, lot.feesUsd, lot.pnlGross, lot.pnlNet,
        LOT_MATCH_RULE, nowMs,
      )
    }
  })
  tx()
  return lots
}

/**
 * Recompute trader_realized_pnl for one ASSET from the full fill history of
 * that asset, pooling entry (buy) and exit (sell) fills that live under
 * DIFFERENT decision ids. This is the canonical realized-P&L path: an exit is
 * always a separate decision from its entry, so per-decision matching (above)
 * never sees a buy and its matching sell together and yields zero realized
 * rows. FIFO across the asset closes oldest buy lots first.
 *
 * Each realized row is keyed by the entry (buy) decision id -- the lot that
 * was closed -- which is a live trader_decisions FK (entries persist; exits
 * may be deleted/aggregated). Full rebuild per asset, so re-runs are
 * idempotent. Returns the realized lots written.
 */
export function recomputeRealizedPnlForAsset(
  db: Database.Database,
  asset: string,
  nowMs: number = Date.now(),
): RealizedLot[] {
  const fills = listFillsForAsset(db, asset)
  if (fills.length === 0) return []
  const lots = matchLotsFifo(fills)
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM trader_realized_pnl WHERE asset = ?').run(asset)
    const ins = db.prepare(`
      INSERT INTO trader_realized_pnl
        (id, decision_id, asset, qty, entry_price, exit_price,
         entry_ts_ms, exit_ts_ms, fees_usd, pnl_gross, pnl_net,
         lot_match_rule, computed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    for (const lot of lots) {
      ins.run(
        randomUUID(), lot.entryDecisionId, asset, lot.qty, lot.entryPrice, lot.exitPrice,
        lot.entryTsMs, lot.exitTsMs, lot.feesUsd, lot.pnlGross, lot.pnlNet,
        LOT_MATCH_RULE, nowMs,
      )
    }
  })
  tx()
  return lots
}
