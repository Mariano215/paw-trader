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
 *   - One positions round-trip per sweep; one /prices fetch per exiting
 *     asset only.
 *   - Each decision wrapped in try/catch so one failure never stops the
 *     sweep.
 *   - A duplicate guard prevents re-submitting an exit already in flight.
 *
 * ENGINE DEPENDENCY: the Python engine is buy-side only today and
 * ignores stop_loss/take_profit. This module submits side:'sell' via
 * /decisions/submit; the engine must honor a sell as a position close
 * for the live exit to actually fire. See plan engineDependencies.
 */
import { randomUUID } from 'crypto'
import type Database from 'better-sqlite3'
import type { EngineClient } from './engine-client.js'
import type { EnginePosition } from './types.js'
import { logger } from '../logger.js'
import { DECISION_STATUS } from './order-lifecycle.js'

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * Momentum-decay deadband for longs (pct, negative).
 * Enrichment is captured at signal time -- not live -- so a bare
 * negative 20d change whipsaws on routine dips in a trend. Only exit
 * when momentum has deteriorated beyond this threshold. Revisit with a
 * live GET /prices momentum refresh once the engine exposes it.
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
 * Guard is keyed on the entry DECISION id (d.id): the exit row stores the
 * entry decision's id in its signal_id column (convention: exit.signal_id =
 * entry_decision.id). This means two executed decisions for the same signal
 * (e.g. a partial-fill pair) each get their own independent exit guard
 * rather than the first decision's in-flight exit suppressing the second.
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
        WHERE e.signal_id = d.id
          AND e.status = ?
      )
  `).all(DECISION_STATUS.EXIT_SUBMITTED) as OpenExitRow[]
}

/** Pure exit decision for one open position given the latest price. */
export function evaluateExit(
  row: OpenExitRow,
  ctx: { lastPrice: number; nowMs: number },
): ExitDecision {
  const isLong = row.action !== 'sell'
  const exitSide: 'buy' | 'sell' = isLong ? 'sell' : 'buy'

  // 1. Stop breach (only when a stop is stored).
  if (row.stop_loss != null) {
    const hit = isLong ? ctx.lastPrice <= row.stop_loss : ctx.lastPrice >= row.stop_loss
    if (hit) return { exit: true, reason: 'stop', side: exitSide }
  }

  // 2. Target breach (only when a target is stored).
  if (row.take_profit != null) {
    const hit = isLong ? ctx.lastPrice >= row.take_profit : ctx.lastPrice <= row.take_profit
    if (hit) return { exit: true, reason: 'target', side: exitSide }
  }

  // 3. Time-stop: held past the signal horizon.
  const horizon = row.horizon_days > 0 ? row.horizon_days : 10
  if (ctx.nowMs - row.decided_at > horizon * DAY_MS) {
    return { exit: true, reason: 'time', side: exitSide }
  }

  // 4. Momentum decay: 20d % change exceeded the deadband against the position.
  //    Enrichment is captured at signal time, not live, so a bare negative
  //    reading whipsaws on routine dips. Only fire when momentum has
  //    deteriorated beyond MOMENTUM_EXIT_DEADBAND_PCT (default -5%). For
  //    shorts the mirror applies: exit only when m > +5%.
  //    TODO: replace with a live GET /prices momentum refresh once the engine
  //    exposes it, so the enrichment-staleness limitation is removed.
  if (row.enrichment_json) {
    try {
      const e = JSON.parse(row.enrichment_json) as { price_change_20d_pct?: number | null }
      const m = e.price_change_20d_pct
      if (typeof m === 'number') {
        const decayed = isLong
          ? m < MOMENTUM_EXIT_DEADBAND_PCT
          : m > -MOMENTUM_EXIT_DEADBAND_PCT
        if (decayed) return { exit: true, reason: 'momentum', side: exitSide }
      }
    } catch { /* malformed -> no momentum opinion */ }
  }

  return { exit: false, reason: 'hold', side: exitSide }
}

/** Latest close from a /prices series, or null when empty. */
function lastClose(bars: { close: number }[]): number | null {
  if (bars.length === 0) return null
  const c = bars[bars.length - 1].close
  return typeof c === 'number' && isFinite(c) ? c : null
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
): Promise<{ checked: number; exited: number; errors: number }> {
  const candidates = findOpenExitCandidates(db)
  if (candidates.length === 0) return { checked: 0, exited: 0, errors: 0 }

  let positions: EnginePosition[]
  try {
    positions = await engineClient.getPositions()
  } catch (err) {
    logger.warn({ err, candidates: candidates.length }, 'Exit sweep: getPositions failed')
    return { checked: 0, exited: 0, errors: 1 }
  }
  const hasPosition = (asset: string): EnginePosition | undefined =>
    positions.find(p => p.asset === asset && Math.abs(p.qty) > 1e-9)

  const nowMs = Date.now()
  let checked = 0
  let exited = 0
  let errors = 0

  for (const row of candidates) {
    try {
      const pos = hasPosition(row.asset)
      if (!pos) continue  // closed already; close-out-watcher will grade it
      checked += 1

      const bars = await engineClient.getPrices(row.asset, nowMs - 7 * DAY_MS, nowMs)
      const last = lastClose(bars)
      if (last == null) {
        logger.info({ asset: row.asset, decisionId: row.id }, 'Exit sweep: no price bar, skipping')
        continue
      }

      const verdict = evaluateExit(row, { lastPrice: last, nowMs })
      if (!verdict.exit) continue

      const exitDecisionId = randomUUID()
      // Record intent BEFORE the broker sees the order so a crash between
      // submit and record cannot lose the exit.
      // I3: signal_id on the exit row is set to the ENTRY DECISION's id (row.id),
      // not the signal id. The duplicate guard in findOpenExitCandidates matches
      // on e.signal_id = d.id, so each entry decision has its own guard slot and
      // two executed decisions for the same signal are guarded independently.
      db.prepare(`
        INSERT INTO trader_decisions
          (id, signal_id, action, asset, size_usd, entry_type, thesis, confidence, decided_at, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        exitDecisionId, row.id, verdict.side, row.asset,
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

  return { checked, exited, errors }
}
