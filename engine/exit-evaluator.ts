/**
 * Position-aware exit evaluator -- the first brain component that emits
 * a sell/exit. Runs as a deterministic trader-scheduler phase (no LLM).
 *
 * For every open executed decision that still has a live engine
 * position, it checks four exit triggers and, on any hit, submits a
 * closing order (opposite side) and records an 'exit_submitted'
 * decision row.
 *
 * Triggers:
 *   - stop:     last price breached the stored stop_loss
 *   - target:   last price reached the stored take_profit
 *   - time:     now - decided_at exceeded horizon_days (time-stop)
 *   - momentum: 20d momentum flipped against a long / short
 *
 * Hot-path rules (mirrors close-out-watcher):
 *   - One positions round-trip per sweep; historical data only when a
 *     fresh stop/target or time exit has not already fired.
 *   - Each decision wrapped in try/catch so one failure never stops the
 *     sweep.
 *   - A duplicate guard prevents re-submitting an exit already in flight.
 *
 * Engine migration 0007 and idempotent submission are required for safe
 * recovery of ambiguous submission results. Live protection is separate.
 */
import { randomUUID } from 'crypto'
import type Database from 'better-sqlite3'
import type { EngineClient } from './engine-client.js'
import type { EnginePosition } from './types.js'
import { logger } from '../logger.js'
import { DECISION_STATUS } from './order-lifecycle.js'
import { isEquityMarketHours } from './signal-poller.js'

const DAY_MS = 24 * 60 * 60 * 1000
export const EXIT_MARK_MAX_AGE_MS = 5 * 60 * 1000

/**
 * Momentum-decay deadband for longs (pct, negative).
 * Evaluated from current 20-session bars, not entry-time enrichment.
 * The deadband avoids treating every small negative move as a reversal.
 */
export const MOMENTUM_EXIT_DEADBAND_PCT = -5.0

export interface OpenExitRow {
  id: string
  signal_id: string
  asset: string
  action: string
  entry_price: number | null
  stop_loss: number | null
  take_profit: number | null
  horizon_days: number
  decided_at: number
  enrichment_json: string | null
}

export type ExitReason = 'stop' | 'target' | 'time' | 'momentum' | 'hold'

export interface ExitDecision {
  exit: boolean
  reason: ExitReason
  side: 'buy' | 'sell'
}

/**
 * Open long/short decisions that have NOT already had an exit submitted,
 * joined to their signal's enrichment for momentum.
 * 'executed' = entry filled-or-submitted (the dispatcher's success state).
 *
 * Guard is keyed on the entry DECISION id via the exit row's
 * parent_decision_id column (exit.parent_decision_id = entry_decision.id).
 * Two executed decisions for the same signal (e.g. a partial-fill pair) each
 * get their own independent exit guard rather than the first decision's
 * in-flight exit suppressing the second.
 *
 * HISTORY: the original convention stored the entry decision id in the exit
 * row's signal_id column. trader_decisions.signal_id has an FK to
 * trader_signals(id) and production runs PRAGMA foreign_keys = ON, so every
 * exit INSERT threw SQLITE_CONSTRAINT_FOREIGNKEY and no sweep-exit ever
 * succeeded (May-Jun 2026). Schema v5 added parent_decision_id for the
 * linkage; signal_id now always carries a real signal id.
 */
export function findOpenExitCandidates(db: Database.Database): OpenExitRow[] {
  return db.prepare(`
    SELECT d.id, d.signal_id, d.asset, d.action, d.entry_price,
           d.stop_loss, d.take_profit, s.horizon_days, d.decided_at,
           s.enrichment_json
    FROM trader_decisions d
    JOIN trader_signals s ON s.id = d.signal_id
    WHERE d.status = 'executed'
      AND d.action IN ('buy', 'sell')
      AND NOT EXISTS (
        SELECT 1 FROM trader_decisions e
        WHERE e.parent_decision_id = d.id
          AND e.status IN (?, ?)
      )
  `).all(DECISION_STATUS.EXIT_SUBMITTED, DECISION_STATUS.EXIT_UNKNOWN) as OpenExitRow[]
}

/** Pure exit decision for one open position given the latest price. */
export function evaluateExit(
  row: OpenExitRow,
  ctx: { lastPrice: number | null; nowMs: number; momentumPct?: number | null },
): ExitDecision {
  const isLong = row.action !== 'sell'
  const exitSide: 'buy' | 'sell' = isLong ? 'sell' : 'buy'

  // 1. Stop breach (only when a stop is stored).
  if (row.stop_loss != null && ctx.lastPrice != null && Number.isFinite(ctx.lastPrice) && ctx.lastPrice > 0) {
    const hit = isLong ? ctx.lastPrice <= row.stop_loss : ctx.lastPrice >= row.stop_loss
    if (hit) return { exit: true, reason: 'stop', side: exitSide }
  }

  // 2. Target breach (only when a target is stored).
  if (row.take_profit != null && ctx.lastPrice != null && Number.isFinite(ctx.lastPrice) && ctx.lastPrice > 0) {
    const hit = isLong ? ctx.lastPrice >= row.take_profit : ctx.lastPrice <= row.take_profit
    if (hit) return { exit: true, reason: 'target', side: exitSide }
  }

  // 3. Time-stop: held past the signal horizon.
  const horizon = row.horizon_days > 0 ? row.horizon_days : 10
  if (ctx.nowMs - row.decided_at > horizon * DAY_MS) {
    return { exit: true, reason: 'time', side: exitSide }
  }

  // Entry-time enrichment is historical context, not a current exit signal.
  const m = ctx.momentumPct
  if (m != null && Number.isFinite(m)) {
    const decayed = isLong ? m < MOMENTUM_EXIT_DEADBAND_PCT : m > -MOMENTUM_EXIT_DEADBAND_PCT
    if (decayed) return { exit: true, reason: 'momentum', side: exitSide }
  }

  return { exit: false, reason: 'hold', side: exitSide }
}

/** Current 20-session return, or null for incomplete/stale market data. */
export function currentMomentum(bars: {close: number; ts_ms: number}[], nowMs: number, crypto: boolean): number | null {
  const sorted = [...new Map(bars.filter(b => Number.isFinite(b.close) && b.close > 0 &&
    Number.isFinite(b.ts_ms) && b.ts_ms <= nowMs).map(b => [b.ts_ms, b])).values()].sort((a, b) => a.ts_ms - b.ts_ms)
  if (sorted.length < 21) return null
  const last = sorted[sorted.length - 1]
  if (nowMs - last.ts_ms > (crypto ? 2 : 4) * DAY_MS) return null
  return (last.close / sorted[sorted.length - 21].close - 1) * 100
}

/**
 * Walk open positions, exit any that hit a trigger. One getPositions
 * round-trip; one /prices fetch per still-open asset. Submits the
 * closing order and records an 'exit_submitted' decision row, then
 * alerts the operator.
 */
export async function runExitSweep(
  db: Database.Database,
  engineClient: EngineClient,
  send: (text: string) => Promise<void>,
  /**
   * Injectable clock and market-hours check. The scheduler already owns an
   * isMarketOpen dep; the exit sweep honours the same one so a single source
   * decides whether equities are tradeable.
   */
  opts?: { nowMs?: number; isMarketOpen?: () => boolean },
): Promise<{ checked: number; exited: number; errors: number; drifted: number; skippedClosed: number }> {
  // Preserve the decision ID across ambiguous transport failure. The engine's
  // durable idempotency contract either returns that order or creates it once.
  const uncertain = db.prepare("SELECT id, asset, action FROM trader_decisions WHERE status=?")
    .all(DECISION_STATUS.EXIT_UNKNOWN) as Array<{id: string; asset: string; action: 'buy' | 'sell'}>
  let recovered = 0
  let recoveryErrors = 0
  for (const intent of uncertain) {
    if (!intent.asset.includes('/') && !(opts?.isMarketOpen ?? (() => isEquityMarketHours(opts?.nowMs ?? Date.now())))()) continue
    try {
      const response = await engineClient.submitDecision({decision_id: intent.id, asset: intent.asset,
        side: intent.action, size_usd: 0, entry_type: 'market', entry_price: 0, strategy: 'exit', confidence: 1})
      if (response.status !== 'unknown') {
        db.prepare('UPDATE trader_decisions SET status=?, engine_order_id=? WHERE id=?')
          .run(DECISION_STATUS.EXIT_SUBMITTED, response.broker_order_id ?? response.client_order_id, intent.id)
        recovered++
      }
    } catch (err) {
      recoveryErrors++
      logger.warn({decisionId: intent.id, err}, 'Exit acceptance remains unknown; original intent retained')
    }
  }
  const candidates = findOpenExitCandidates(db)
  if (candidates.length === 0) return { checked: 0, exited: recovered, errors: recoveryErrors, drifted: 0, skippedClosed: 0 }

  let positions: EnginePosition[]
  try {
    positions = await engineClient.getPositions()
  } catch (err) {
    logger.warn({ err, candidates: candidates.length }, 'Exit sweep: getPositions failed')
    return { checked: 0, exited: recovered, errors: 1 + recoveryErrors, drifted: 0, skippedClosed: 0 }
  }
  const hasPosition = (asset: string): EnginePosition | undefined =>
    positions.find(p => p.asset === asset && Math.abs(p.qty) > 1e-9)

  const nowMs = opts?.nowMs ?? Date.now()
  const equitiesOpen = opts?.isMarketOpen ?? (() => isEquityMarketHours(nowMs))
  let checked = 0
  let exited = recovered
  let errors = recoveryErrors
  let drifted = 0
  let skippedClosed = 0

  for (const row of candidates) {
    try {
      // Market-hours gate, per asset class. Crypto ('/' in the ticker) trades
      // 24/7 and must never be gated here, or crypto positions could never be
      // closed. Equities outside NYSE hours are skipped BEFORE the intent row
      // is written.
      //
      // Without this the sweep ran every 5 minutes around the clock: it
      // inserted an exit_submitted row, the engine rejected it with
      // 422 blocked_by:["market_closed"], the row was deleted, and the error
      // was rethrown. 4,119 insert-delete cycles by 2026-08-02, 3,547 of them
      // purely market_closed, against 11 exits that actually submitted. The
      // signal poller already gates the same way (signal-poller.ts:193).
      const isCrypto = row.asset.includes('/')
      if (!isCrypto && !equitiesOpen()) {
        skippedClosed += 1
        continue
      }

      const pos = hasPosition(row.asset)
      if (!pos) {
        // Broker is flat but the brain still holds the decision. Usually the
        // engine's bracket order closed the position without telling us. This
        // used to be a bare `continue` with no log and no counter, so six QQQ
        // lots drifted for 52 days completely invisibly. Count it; the
        // close-out watcher terminates the row once it is past the orders
        // window, and the drift collector alerts if the count stays high.
        drifted += 1
        continue
      }
      checked += 1

      const mark = Math.abs(pos.market_value / pos.qty)
      const last = Number.isFinite(mark) && mark > 0 && Number.isFinite(pos.updated_at) &&
        nowMs >= pos.updated_at && nowMs - pos.updated_at <= EXIT_MARK_MAX_AGE_MS ? mark : null
      let verdict = evaluateExit(row, {lastPrice: last, nowMs})
      // Stops and time exits do not wait on historical market-data requests.
      if (!verdict.exit) {
        try {
          const bars = await engineClient.getPrices(row.asset, nowMs - 45 * DAY_MS, nowMs)
          verdict = evaluateExit(row, {lastPrice: last, nowMs, momentumPct: currentMomentum(bars, nowMs, isCrypto)})
        } catch (err) {
          logger.warn({asset: row.asset, err}, 'Exit momentum unavailable; no momentum-based action')
        }
      }
      if (!verdict.exit) continue

      const exitDecisionId = randomUUID()
      // Record intent BEFORE the broker sees the order so a crash between
      // submit and record cannot lose the exit.
      // I3: the entry-decision linkage is parent_decision_id = row.id; the
      // duplicate guard in findOpenExitCandidates matches on
      // e.parent_decision_id = d.id, so each entry decision has its own guard
      // slot and two executed decisions for the same signal are guarded
      // independently. signal_id carries the entry's REAL signal id -- it has
      // an enforced FK to trader_signals(id) in production.
      db.prepare(`
        INSERT INTO trader_decisions
          (id, signal_id, parent_decision_id, action, asset, size_usd, entry_type, thesis, confidence, decided_at, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        exitDecisionId, row.signal_id, row.id, verdict.side, row.asset,
        0, 'market',
        `Auto-exit (${verdict.reason}): last=${last} entry=${row.entry_price} stop=${row.stop_loss} target=${row.take_profit}`,
        1.0, nowMs, DECISION_STATUS.EXIT_SUBMITTED,
      )

      try {
        // I2: size_usd = 0 is the full-close sentinel per the E3 contract.
        // The engine closes the entire position when size_usd <= 0. Sending
        // market_value would be interpreted as a share count and could
        // mis-size the close for fractional positions.
        await engineClient.submitDecision({
          decision_id: exitDecisionId,
          asset: row.asset,
          side: verdict.side,
          size_usd: 0,
          entry_type: 'market',
          entry_price: 0,
          strategy: 'exit',
          confidence: 1.0,
        })
      } catch (submitErr) {
        const msg = submitErr instanceof Error ? submitErr.message : String(submitErr)
        // C1: 422 no_position means the bracket order (E2) already closed the
        // position in this tick. The exit_submitted row we just inserted is now
        // orphaned and would permanently block future exits for this decision via
        // the duplicate guard. Clean it up and log at info (not error) so the
        // close-out-watcher can grade the original entry on the next sweep.
        if (msg.includes('no_position')) {
          db.prepare(`DELETE FROM trader_decisions WHERE id = ?`).run(exitDecisionId)
          logger.info(
            { asset: row.asset, decisionId: row.id },
            'Exit sweep: position already closed by bracket (no_position), skipping',
          )
          continue
        }
        db.prepare('UPDATE trader_decisions SET status=? WHERE id=?')
          .run(DECISION_STATUS.EXIT_UNKNOWN, exitDecisionId)
        logger.warn(
          { asset: row.asset, decisionId: row.id, err: msg },
          'Exit sweep: acceptance uncertain; next sweep will recover the same intent ID',
        )
        throw submitErr
      }

      exited += 1
      logger.warn({ asset: row.asset, reason: verdict.reason, last, decisionId: row.id }, 'Exit sweep: position exit submitted')
      await send(
        `TRADER EXIT: ${verdict.side.toUpperCase()} ${row.asset} (${verdict.reason}). ` +
        `Last ${last}, entry ${row.entry_price}, stop ${row.stop_loss}, target ${row.take_profit}.`,
      ).catch(() => { /* send failure must not break the sweep */ })
    } catch (err) {
      logger.error({ err, decisionId: row.id, asset: row.asset }, 'Exit sweep: exit attempt failed')
      errors += 1
    }
  }

  if (drifted > 0) {
    logger.warn(
      { drifted, checked, candidates: candidates.length },
      'Exit sweep: decisions whose asset is flat at the broker (position drift)',
    )
  }

  return { checked, exited, errors, drifted, skippedClosed }
}
