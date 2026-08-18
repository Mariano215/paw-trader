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
 * Costs-present guard: a closed round trip must carry a real execution cost.
 *
 * `feeFreeVenue` is not a way to switch the guard off. Alpaca equities really
 * are commission-free, so demanding fee_usd != 0 there fails forever on a
 * condition nobody can fix, and a guard that can only fail is one people learn
 * to scroll past. On a fee-free venue the execution cost IS the slippage, so
 * the guard moves to slippage coverage instead: the fills must record what
 * price we meant to get, not just the one we got.
 *
 * Slippage is only computed when a fill carries an intended_price
 * (computeSlippageUsd returns 0 without one), so a fill missing that field is
 * not a zero-cost fill, it is an unmeasured one.
 */
export function guardCostsIncluded(fills: FillRow[], feeFreeVenue = false): GuardResult {
  if (fills.length === 0) return { ok: true, reason: 'no fills to check' }

  if (feeFreeVenue) {
    const measured = fills.filter((f) => f.intended_price != null).length
    if (measured === fills.length) {
      return { ok: true, reason: 'fee-free venue; slippage measured on every fill' }
    }
    return {
      ok: false,
      reason: `fee-free venue, but ${fills.length - measured} of ${fills.length} fills carry no ` +
        'intended_price, so their slippage is recorded as 0 without being measured',
    }
  }

  const anyCost = fills.some((f) => f.fee_usd !== 0 || f.slippage_usd !== 0)
  if (anyCost) return { ok: true, reason: 'fees or slippage present' }
  return {
    ok: false,
    reason: 'every fill has zero fees and zero slippage; costs were likely omitted',
  }
}

/**
 * Reconciliation guard: the brain's realized P&L must agree with the broker's.
 *
 * The 2026-08-02 weekly report claimed 127 internal trades and -$680.56 net for
 * momentum-stocks while broker truth showed 5 closed round-trips and -$763.27
 * realized. The two numbers are computed by completely separate paths (verdict
 * rows written per decision at close-out, versus FIFO lot matching over broker
 * fills), and nothing compared them, so a 25x divergence in trade count went
 * unnoticed for weeks while the go-live gate counted the inflated number toward
 * its 100-trade threshold.
 *
 * Tolerance is relative because absolute dollar drift is meaningless at
 * different book sizes. Pass tolFrac = 0.05 for "within 5%".
 */
export function guardMatchesBrokerTruth(
  internalRealizedNet: number,
  brokerRealizedNet: number,
  tolFrac = 0.05,
): GuardResult {
  const diff = Math.abs(internalRealizedNet - brokerRealizedNet)
  const scale = Math.max(Math.abs(brokerRealizedNet), Math.abs(internalRealizedNet))
  // Both effectively zero: nothing to reconcile.
  if (scale < 0.01) return { ok: true, reason: 'no realized P&L on either side' }
  if (diff / scale <= tolFrac) {
    return { ok: true, reason: 'internal realized P&L reconciles with broker truth' }
  }
  return {
    ok: false,
    reason: `internal realized P&L ${internalRealizedNet.toFixed(2)} diverges from broker truth ` +
      `${brokerRealizedNet.toFixed(2)} by ${((diff / scale) * 100).toFixed(1)}%; ` +
      'one of the two accounting paths is wrong',
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
