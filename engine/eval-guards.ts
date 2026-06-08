/**
 * Phase E Task 4 -- evaluation pitfall guards.
 *
 * Each guard returns { ok, reason }. The caller decides whether to
 * throw or degrade the affected section. These exist so the known
 * pitfalls (NAV drift as P&L, look-ahead/same-bar close, fees/slippage
 * omitted) fail loudly instead of producing a flattering number.
 */
import type { FillRow } from './audit-log.js'
import type { EquityPoint } from './metrics.js'

export interface GuardResult { ok: boolean; reason: string }

/**
 * Strategy P&L must come from realized trades, not raw NAV deltas. NAV
 * moves on deposits, withdrawals, and unrealized marks that are not
 * strategy edge. This guard fails when the caller tries to attribute a
 * NAV delta to strategy P&L while the realized P&L over the same window
 * differs from it by more than a small tolerance. Pass the summed
 * realized pnl_net and the NAV delta; equality within tol means the
 * caller correctly used realized P&L.
 */
export function guardNoNavDriftAsPnl(
  realizedPnlNet: number,
  navDelta: number,
  tolUsd = 0.01,
): GuardResult {
  if (Math.abs(realizedPnlNet - navDelta) <= tolUsd) {
    return { ok: true, reason: 'reported P&L matches realized trades' }
  }
  return {
    ok: false,
    reason: `reported value ${navDelta.toFixed(2)} differs from realized P&L ` +
      `${realizedPnlNet.toFixed(2)}; NAV drift must not be reported as strategy P&L`,
  }
}

/**
 * Look-ahead guard: an exit fill must not share the same bar/timestamp
 * as its entry fill. Same-bar close means we acted on information not
 * available at decision time. Fails when any sell fill_ts_ms equals a
 * prior buy fill_ts_ms for the decision.
 */
export function guardNoSameBarClose(fills: FillRow[]): GuardResult {
  const buyTs = new Set<number>()
  for (const f of fills) {
    if (f.side === 'buy') buyTs.add(f.fill_ts_ms)
    else if (buyTs.has(f.fill_ts_ms)) {
      return {
        ok: false,
        reason: `sell at ${f.fill_ts_ms} shares a bar with an entry; same-bar close is look-ahead`,
      }
    }
  }
  return { ok: true, reason: 'no entry/exit share a bar' }
}

/**
 * Costs-present guard: a closed round trip must carry non-zero costs
 * unless the venue is explicitly fee-free. Real fills with exactly zero
 * fees AND zero slippage on every leg usually means costs were dropped.
 * Fails when every fill has fee_usd == 0 and slippage_usd == 0 and
 * `feeFreeVenue` is false.
 */
export function guardCostsIncluded(fills: FillRow[], feeFreeVenue = false): GuardResult {
  if (feeFreeVenue) return { ok: true, reason: 'venue is fee-free by configuration' }
  if (fills.length === 0) return { ok: true, reason: 'no fills to check' }
  const anyCost = fills.some((f) => f.fee_usd !== 0 || f.slippage_usd !== 0)
  if (anyCost) return { ok: true, reason: 'fees or slippage present' }
  return {
    ok: false,
    reason: 'every fill has zero fees and zero slippage; costs were likely omitted',
  }
}

/**
 * Monotonic-time guard for an equity curve. Out-of-order timestamps
 * silently corrupt CAGR and drawdown. Fails on the first non-increasing
 * step.
 */
export function guardMonotonicCurve(curve: EquityPoint[]): GuardResult {
  for (let i = 1; i < curve.length; i++) {
    if (curve[i].ts_ms <= curve[i - 1].ts_ms) {
      return { ok: false, reason: `equity curve ts out of order at index ${i}` }
    }
  }
  return { ok: true, reason: 'curve timestamps strictly increasing' }
}
