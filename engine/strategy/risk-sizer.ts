export interface RiskSizeInput {
  navUsd: number              // account equity (engine getNav())
  entryPrice: number          // last/limit price
  stopDistanceDollars: number // vol-scaled stop distance (volStopDistanceDollars)
  openRiskUsd: number         // sum of risk on currently open positions
  riskPct?: number            // fraction of NAV to risk per trade (default 0.01)
  heatCapPct?: number         // max total open risk as fraction of NAV (default 0.06)
  hardCeilingUsd?: number     // absolute notional ceiling (default 1000, matches dispatcher)
}

export interface RiskSizeResult {
  sizeUsd: number             // notional to send to the engine (0 => do not trade)
  riskUsd: number             // dollar risk this trade adds (size/entry * stopDistance)
  allow: boolean
  reason: string
}

/**
 * Fixed-fractional position sizing behind a vol-scaled stop.
 *
 * risk_per_trade = riskPct * NAV. shares = risk_per_trade / stopDistance.
 * notional = shares * entryPrice. Then clamp by:
 *   - hardCeilingUsd (absolute notional cap),
 *   - remaining portfolio heat (heatCapPct*NAV - openRiskUsd).
 *
 * Returns allow=false / sizeUsd=0 when NAV/entry/stop are unusable or the
 * heat cap is already exhausted. No leverage: notional never exceeds NAV.
 */
export function sizePosition(input: RiskSizeInput): RiskSizeResult {
  const riskPct = input.riskPct ?? 0.01
  const heatCapPct = input.heatCapPct ?? 0.06
  const hardCeiling = input.hardCeilingUsd ?? 1000

  if (!(input.navUsd > 0) || !(input.entryPrice > 0) || !(input.stopDistanceDollars > 0)) {
    return {
      sizeUsd: 0,
      riskUsd: 0,
      allow: false,
      reason: 'Unusable NAV, entry, or stop distance. No trade.',
    }
  }

  const heatBudget = heatCapPct * input.navUsd
  const remainingHeat = heatBudget - input.openRiskUsd
  if (remainingHeat <= 0) {
    return {
      sizeUsd: 0,
      riskUsd: 0,
      allow: false,
      reason: `Portfolio heat cap reached (open risk $${input.openRiskUsd.toFixed(2)} >= budget $${heatBudget.toFixed(2)}). No new trade.`,
    }
  }

  // Risk this trade is allowed to add: the smaller of per-trade risk and
  // whatever heat budget remains.
  const targetRisk = Math.min(riskPct * input.navUsd, remainingHeat)
  const shares = targetRisk / input.stopDistanceDollars
  let notional = shares * input.entryPrice

  // No leverage in paper phase: never exceed NAV; respect the hard ceiling.
  notional = Math.min(notional, hardCeiling, input.navUsd)
  if (!(notional > 0)) {
    return {
      sizeUsd: 0,
      riskUsd: 0,
      allow: false,
      reason: 'Computed notional <= 0. No trade.',
    }
  }

  // Recompute realized risk at the clamped notional (clamping lowers risk).
  const realizedShares = notional / input.entryPrice
  const realizedRisk = realizedShares * input.stopDistanceDollars
  return {
    sizeUsd: Math.round(notional * 100) / 100,
    riskUsd: Math.round(realizedRisk * 100) / 100,
    allow: true,
    reason: `1%-NAV fixed-fractional behind a vol stop. risk $${realizedRisk.toFixed(2)}, size $${notional.toFixed(2)}.`,
  }
}
