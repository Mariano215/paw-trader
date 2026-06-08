import type { PricePoint } from '../types.js'

/**
 * Core stdev computation over an already-sorted, already-filtered closes
 * array. No copying, no sorting -- caller owns ordering.
 * Returns null when closes is too short or variance is zero/non-finite.
 */
function stdevDollarsFromCloses(closes: number[], minBars: number): number | null {
  if (closes.length < minBars + 1) return null
  const rets: number[] = []
  for (let i = 1; i < closes.length; i++) {
    rets.push((closes[i] - closes[i - 1]) / closes[i - 1])
  }
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length
  const variance =
    rets.reduce((a, r) => a + (r - mean) * (r - mean), 0) / (rets.length - 1)
  const stdevPct = Math.sqrt(variance)
  const lastClose = closes[closes.length - 1]
  const dollars = stdevPct * lastClose
  return Number.isFinite(dollars) && dollars > 0 ? dollars : null
}

/**
 * Daily-return standard deviation in PRICE terms (a dollar move), computed
 * from close-only bars. This is a proxy for ATR: the engine's PricePoint has
 * no high/low (types.ts:113-117), so a true Wilder ATR is impossible
 * brain-side. We use stdev of simple daily returns * last close.
 *
 * Returns null when there are too few bars to be meaningful (< minBars+1).
 * Callers MUST treat null as "no usable vol -> do not size a vol-based stop".
 */
export function dailyReturnStdevDollars(
  bars: PricePoint[],
  minBars = 20,
): number | null {
  if (bars.length < minBars + 1) return null
  // Ensure chronological order; engine returns ascending but do not assume.
  const sorted = [...bars].sort((a, b) => a.ts_ms - b.ts_ms)
  const closes = sorted.map((b) => b.close).filter((c) => Number.isFinite(c) && c > 0)
  return stdevDollarsFromCloses(closes, minBars)
}

/**
 * Same as dailyReturnStdevDollars but takes a pre-sorted PricePoint array.
 * Used internally by evaluateRegime which sorts once and reuses the result.
 * Not exported -- callers outside this module should use the public API.
 */
export function _dailyReturnStdevDollarsFromSorted(
  sortedBars: PricePoint[],
  minBars = 20,
): number | null {
  if (sortedBars.length < minBars + 1) return null
  const closes = sortedBars.map((b) => b.close).filter((c) => Number.isFinite(c) && c > 0)
  return stdevDollarsFromCloses(closes, minBars)
}

/**
 * Vol-scaled stop distance in dollars. mult is the vol-multiple (default
 * 2.5, inside the published 1.5-3x band). Wider stops RAISE win rate, so
 * keep this >= 1.5. Returns null when vol is unavailable.
 */
export function volStopDistanceDollars(
  bars: PricePoint[],
  mult = 2.5,
  minBars = 20,
): number | null {
  if (mult < 1.5) mult = 1.5  // floor: never ship tight stops
  const sigma = dailyReturnStdevDollars(bars, minBars)
  return sigma == null ? null : sigma * mult
}

/**
 * Same as volStopDistanceDollars but takes a pre-sorted PricePoint array.
 * Used internally when the caller already owns the sort (no double-sort).
 */
export function _volStopDistanceDollarsFromSorted(
  sortedBars: PricePoint[],
  mult = 2.5,
  minBars = 20,
): number | null {
  if (mult < 1.5) mult = 1.5
  const sigma = _dailyReturnStdevDollarsFromSorted(sortedBars, minBars)
  return sigma == null ? null : sigma * mult
}
