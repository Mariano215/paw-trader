import type { PricePoint } from '../types.js'
import { _dailyReturnStdevDollarsFromSorted } from './volatility.js'

export type VolState = 'calm' | 'normal' | 'extreme'

export interface RegimeVerdict {
  allow: boolean
  aboveTrend: boolean | null   // null = not enough data to judge trend
  volState: VolState | null    // null = not enough data to judge vol
  reason: string
}

export interface RegimeParams {
  smaWindow: number       // trend lookback in bars (default 200)
  volWindow: number       // vol lookback in bars (default 20)
  // Daily-return-stdev-as-fraction-of-price thresholds for the vol overlay.
  // Illustrative defaults; retune from realized data. Above extremePct =>
  // suppress longs (chop/blowoff). Below calmPct => 'calm'.
  calmPct: number         // default 0.008  (0.8% daily move)
  extremePct: number      // default 0.030  (3.0% daily move)
}

export const DEFAULT_REGIME_PARAMS: RegimeParams = {
  smaWindow: 200,
  volWindow: 20,
  calmPct: 0.008,
  extremePct: 0.030,
}

/**
 * Long-only regime gate. Allows a long ONLY when price > smaWindow-DMA AND
 * vol state is not 'extreme'. Fails OPEN to suppress (allow=false) whenever
 * data is insufficient: a blind long is worse than no trade.
 *
 * Crypto note: caller decides whether to apply this. Engine serves no price
 * bars for crypto, so bars will be empty and the gate suppresses -- which is
 * the safe default until a crypto regime source exists.
 */
export function evaluateRegime(
  bars: PricePoint[],
  params: RegimeParams = DEFAULT_REGIME_PARAMS,
): RegimeVerdict {
  const sorted = [...bars].sort((a, b) => a.ts_ms - b.ts_ms)
  const closes = sorted.map((b) => b.close).filter((c) => Number.isFinite(c) && c > 0)

  // --- Trend gate (200DMA) ---
  let aboveTrend: boolean | null = null
  if (closes.length >= params.smaWindow) {
    const window = closes.slice(-params.smaWindow)
    const sma = window.reduce((a, b) => a + b, 0) / window.length
    const last = closes[closes.length - 1]
    aboveTrend = last > sma
  }

  // --- Vol overlay ---
  // sorted is already chronological; use the pre-sorted variant to avoid a
  // second O(n log n) sort inside dailyReturnStdevDollars.
  let volState: VolState | null = null
  const sigmaDollars = _dailyReturnStdevDollarsFromSorted(sorted, params.volWindow)
  const lastClose = closes.length ? closes[closes.length - 1] : null
  if (sigmaDollars != null && lastClose != null) {
    const sigmaPct = sigmaDollars / lastClose
    volState =
      sigmaPct >= params.extremePct ? 'extreme'
      : sigmaPct <= params.calmPct ? 'calm'
      : 'normal'
  }

  if (aboveTrend == null) {
    return {
      allow: false,
      aboveTrend,
      volState,
      reason: `Insufficient bars for ${params.smaWindow}DMA trend gate (have ${closes.length}). Suppressing long.`,
    }
  }
  if (!aboveTrend) {
    return {
      allow: false,
      aboveTrend,
      volState,
      reason: `Price below ${params.smaWindow}DMA. Long suppressed (trend filter).`,
    }
  }
  if (volState === 'extreme') {
    return {
      allow: false,
      aboveTrend,
      volState,
      reason: `Volatility state extreme (daily sigma >= ${(params.extremePct * 100).toFixed(1)}%). Long suppressed (vol overlay).`,
    }
  }
  return {
    allow: true,
    aboveTrend,
    volState,
    reason: `Above ${params.smaWindow}DMA, vol state ${volState ?? 'unknown'}. Long permitted.`,
  }
}
