import type { EnginePosition } from './types.js'

/** Default per-trade risk as a fraction of equity (1%). Range 0.5%-2%. */
export const DEFAULT_RISK_PCT = 0.01

/** Default stop distance as a fraction of entry when no ATR/stop is provided.
 *  8% is a conservative momentum stop; tighten per-strategy later. */
export const DEFAULT_STOP_DISTANCE_PCT = 0.08

/** Total portfolio heat ceiling as a fraction of equity (6%). The sum of
 *  per-trade risk across open positions plus the new trade must stay under. */
export const MAX_PORTFOLIO_HEAT_PCT = 0.06

export interface RiskSizingInput {
  nav: number | null
  riskPct?: number
  stopDistancePct?: number
  /** Open positions, used to estimate already-committed heat. */
  positions: EnginePosition[]
  /** Hard dollar ceiling applied on top of the risk math (per-strategy cap). */
  capUsd: number
  /** Floor so we never submit a sub-dollar order the engine rejects. */
  floorUsd: number
}

export interface RiskSizingResult {
  sizeUsd: number
  riskUsd: number
  stopDistancePct: number
  heatBeforePct: number
  reason: string
}

/**
 * Estimate heat already committed: per open position we assume the same
 * default stop distance, so committed risk per position ~= |market_value| *
 * stopDistancePct. This is a proxy (the engine has no real stops) but it lets
 * us cap how many correlated risk units stack up.
 */
function committedHeatUsd(positions: EnginePosition[], stopDistancePct: number): number {
  return positions.reduce((sum, p) => sum + Math.abs(p.market_value) * stopDistancePct, 0)
}

/**
 * Risk-based position size. PS = (Equity * Risk%) / stopDistanceFraction,
 * expressed in dollars: riskUsd = nav * riskPct; sizeUsd = riskUsd /
 * stopDistancePct. Clamped by the portfolio-heat ceiling, the per-strategy
 * cap, and the floor.
 *
 * NAV unavailable -> fall back to the floor (do not block the trade).
 */
export function computeRiskBasedSize(input: RiskSizingInput): RiskSizingResult {
  const riskPct = input.riskPct ?? DEFAULT_RISK_PCT
  const stopDistancePct = input.stopDistancePct ?? DEFAULT_STOP_DISTANCE_PCT

  if (input.nav == null || input.nav <= 0) {
    // Respect the cap even when falling back; if cap < floor, use cap so we
    // never submit more than the strategy ceiling allows.
    const fallback = Math.min(input.floorUsd, input.capUsd)
    return {
      sizeUsd: Math.max(0, fallback),
      riskUsd: 0,
      stopDistancePct,
      heatBeforePct: 0,
      reason: 'NAV unavailable; risk sizing fell back to floor',
    }
  }

  const heatBefore = committedHeatUsd(input.positions, stopDistancePct)
  const heatBeforePct = heatBefore / input.nav
  const heatCeilingUsd = input.nav * MAX_PORTFOLIO_HEAT_PCT
  const heatHeadroomUsd = Math.max(0, heatCeilingUsd - heatBefore)

  // Risk dollars for this trade, clamped by remaining heat headroom.
  const riskUsd = Math.min(input.nav * riskPct, heatHeadroomUsd)

  // Convert risk dollars to a position size via the stop distance.
  let sizeUsd = riskUsd / stopDistancePct

  // Apply per-strategy cap.
  sizeUsd = Math.min(sizeUsd, input.capUsd)

  // Apply floor ONLY when the risk-derived size already supports it.
  // Flooring up a headroom-limited size would add more risk than the remaining
  // heat budget allows -- e.g. $1 headroom -> risk $12.5 -> floored to $200
  // adds $16 heat over a $1 budget. Guard: floor applies iff the floor-sized
  // position's implied risk (floor * stopDistancePct) fits in heatHeadroomUsd.
  const floorRiskUsd = input.floorUsd * stopDistancePct
  const floorAllowed = riskUsd > 0 && floorRiskUsd <= heatHeadroomUsd
  if (floorAllowed) {
    sizeUsd = Math.max(sizeUsd, input.floorUsd)
  }
  // Cap must always win: re-clamp after floor so floor never overrides the cap.
  sizeUsd = Math.min(sizeUsd, input.capUsd)
  sizeUsd = Math.round(sizeUsd * 100) / 100

  return {
    sizeUsd,
    riskUsd: Math.round(riskUsd * 100) / 100,
    stopDistancePct,
    heatBeforePct: Math.round(heatBeforePct * 10000) / 10000,
    reason: riskUsd <= 0
      ? `portfolio heat ${(heatBeforePct * 100).toFixed(1)}% at/over ceiling ${(MAX_PORTFOLIO_HEAT_PCT * 100).toFixed(0)}%; size 0`
      : `risk ${(riskPct * 100).toFixed(2)}% of NAV / stop ${(stopDistancePct * 100).toFixed(0)}% -> $${sizeUsd}`,
  }
}

/** Derive the stop price the brain would set, given entry and stop distance.
 *  Buy-side: stop below entry. Passed on DecisionRequest.stop_loss even though
 *  the engine currently ignores it. */
export function deriveStopPrice(entryPrice: number, stopDistancePct = DEFAULT_STOP_DISTANCE_PCT): number {
  return Math.round(entryPrice * (1 - stopDistancePct) * 100) / 100
}
