/**
 * Exit-calculator -- deterministic stop / target / time-stop off entry.
 *
 * Every entry gets a predefined stop-loss, take-profit, and time-stop.
 * Pure function: no DB, no network, no LLM. The dispatcher calls this
 * right before submitDecision and writes the result into both the
 * DecisionRequest payload and the trader_decisions row.
 *
 * Volatility rule (research): WIDE vol-scaled stops raise win rate;
 * tight stops get whipsawed. So when we have a price window we size the
 * stop off it and FLOOR it at 6% (never tighter than the percent band)
 * and CAP it at 20% (never risk the book on a blown-out range). With no
 * window we fall back to a fixed 8% band. Target is always 2R from the
 * stop distance.
 */

export type ExitBasis = 'volatility' | 'percent' | 'none'

export interface ExitInputs {
  side: 'buy' | 'sell'
  /** Resolved entry reference price. <= 0 means "unknown" -> no exits. */
  entryPrice: number
  /** Signal horizon in days. <= 0 falls back to FALLBACK_TIME_STOP_DAYS. */
  horizonDays: number
  /** Raw trader_signals.enrichment_json string, or null. */
  enrichment: string | null
}

export interface ExitResult {
  /** Absolute stop price, or null when entry is unknown. */
  stopLoss: number | null
  /** Absolute target price, or null when entry is unknown. */
  takeProfit: number | null
  /** Days after entry at which the position should be force-exited. */
  timeStopDays: number
  /** Which path produced the prices. */
  basis: ExitBasis
}

// Fixed band used when no usable price window is present.
export const DEFAULT_STOP_PCT = 0.08
// Target is 2R: target distance = REWARD_RISK * stop distance.
export const REWARD_RISK = 2
// Volatility band guards (research: wide, not tight).
export const VOL_STOP_FLOOR_PCT = 0.06
export const VOL_STOP_CAP_PCT = 0.20
// Half the 35-day range becomes the stop distance before flooring/capping.
export const VOL_RANGE_MULTIPLIER = 0.5
// Time stop when the signal carries no usable horizon.
export const FALLBACK_TIME_STOP_DAYS = 10

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

interface WindowFields {
  price_current?: number | null
  window_high?: number | null
  window_low?: number | null
}

/** Range-based volatility stop fraction, or null when the window is unusable. */
function volStopPct(entryPrice: number, enrichment: string | null): number | null {
  if (!enrichment) return null
  let parsed: WindowFields
  try {
    parsed = JSON.parse(enrichment) as WindowFields
  } catch {
    return null
  }
  const hi = parsed.window_high
  const lo = parsed.window_low
  if (typeof hi !== 'number' || typeof lo !== 'number' || hi <= lo) return null
  const rangePct = (hi - lo) / entryPrice
  if (!isFinite(rangePct) || rangePct <= 0) return null
  const scaled = rangePct * VOL_RANGE_MULTIPLIER
  return Math.min(VOL_STOP_CAP_PCT, Math.max(VOL_STOP_FLOOR_PCT, scaled))
}

export function computeExits(input: ExitInputs): ExitResult {
  const timeStopDays = input.horizonDays > 0 ? input.horizonDays : FALLBACK_TIME_STOP_DAYS

  if (!(input.entryPrice > 0) || !isFinite(input.entryPrice)) {
    return { stopLoss: null, takeProfit: null, timeStopDays, basis: 'none' }
  }

  const vol = volStopPct(input.entryPrice, input.enrichment)
  const stopPct = vol ?? DEFAULT_STOP_PCT
  const basis: ExitBasis = vol != null ? 'volatility' : 'percent'

  const stopDist = input.entryPrice * stopPct
  const targetDist = stopDist * REWARD_RISK

  // Long: stop below, target above. Short: mirror.
  const stopLoss = input.side === 'buy'
    ? round2(input.entryPrice - stopDist)
    : round2(input.entryPrice + stopDist)
  const takeProfit = input.side === 'buy'
    ? round2(input.entryPrice + targetDist)
    : round2(input.entryPrice - targetDist)

  return { stopLoss, takeProfit, timeStopDays, basis }
}
