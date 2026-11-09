import type { PricePoint } from '../types.js'
import { evaluateRegime, DEFAULT_REGIME_PARAMS, type RegimeParams } from './regime-gate.js'
import { _volStopDistanceDollarsFromSorted } from './volatility.js'
import { sizePosition } from './risk-sizer.js'
import { HARD_CEILING_USD } from '../trader-constants.js'

export interface GateDecisionInput {
  asset: string
  side: 'buy' | 'sell'
  bars: PricePoint[]
  entryPrice: number
  navUsd: number
  openRiskUsd: number
  regimeParams?: RegimeParams
}

export interface GateDecision {
  allow: boolean
  /** Recommended notional in USD when allow=true and the gate computed a size.
   *  null means no size recommendation (non-buy pass-through): the dispatcher
   *  MUST NOT apply Math.min shrinkage when this is null. */
  sizeUsd: number | null
  stopDistanceDollars: number | null
  reason: string
}

/**
 * Compose the regime gate + vol stop + risk sizer into one allow/size
 * decision. Long-only: a 'sell' side is passed through with allow=true and
 * sizeUsd=null (not zero) because the engine emits no sell candidates and
 * exit handling is out of scope for this gate. The dispatcher must only apply
 * Math.min shrinkage when sizeUsd is non-null to avoid zeroing a sell order.
 *
 * Sort once here, then hand the sorted slice to both the regime gate (which
 * also sorts its own copy -- one sort per call) and the vol helper (pre-sorted
 * variant, no second sort there).
 */
export function decideGatedTrade(input: GateDecisionInput): GateDecision {
  if (input.side !== 'buy') {
    // Pass-through: gate does not apply to sells. sizeUsd=null signals to the
    // dispatcher that no size recommendation was made -- do NOT shrink.
    return {
      allow: true,
      sizeUsd: null,
      stopDistanceDollars: null,
      reason: 'Non-buy side: strategy gate not applied (engine is buy-only).',
    }
  }

  // Sort once; regime gate sorts its own copy, vol helper reuses this sorted slice.
  const sorted = [...input.bars].sort((a, b) => a.ts_ms - b.ts_ms)

  const regime = evaluateRegime(input.bars, input.regimeParams ?? DEFAULT_REGIME_PARAMS)
  if (!regime.allow) {
    return { allow: false, sizeUsd: 0, stopDistanceDollars: null, reason: regime.reason }
  }

  const stop = _volStopDistanceDollarsFromSorted(sorted)
  if (stop == null) {
    return {
      allow: false,
      sizeUsd: 0,
      stopDistanceDollars: null,
      reason: 'No vol-based stop distance (insufficient bars). Suppressing.',
    }
  }

  const sized = sizePosition({
    navUsd: input.navUsd,
    entryPrice: input.entryPrice,
    stopDistanceDollars: stop,
    openRiskUsd: input.openRiskUsd,
    hardCeilingUsd: HARD_CEILING_USD,
  })
  return {
    allow: sized.allow,
    sizeUsd: sized.sizeUsd,
    stopDistanceDollars: stop,
    reason: `${regime.reason} ${sized.reason}`,
  }
}
