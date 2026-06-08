import type { EnginePosition } from './types.js'

/**
 * Static correlation clusters for the launch universe. Each symbol maps to a
 * cluster key. Unmapped symbols are their own singleton cluster (keyed by the
 * symbol itself), so a new ticker is never silently lumped with the index.
 *
 * 'us-large-cap-beta': SPY/QQQ/AAPL and friends move together (SPY-QQQ ~0.94,
 * QQQ is ~58-65% tech which AAPL dominates). Treat as ONE bet.
 *
 * E4 diversifier sleeves (treasuries/gold/commodities/intl-equity) each get
 * their own cluster key so the 20%-NAV cap is per-sleeve, not lumped into the
 * equity cluster. Low correlation is regime-dependent (stock-bond correlation
 * broke in 2022); these are static defaults -- retune from realized data.
 *
 * NOTE: This list is intentionally broader than INDEX_ETFS in committee.ts.
 * CLUSTER_MAP gates gross-exposure per cluster and includes single stocks
 * (AAPL/MSFT/NVDA) that correlate strongly with the index ETFs.
 * INDEX_ETFS gates the committee fast-path (lean assets skip the LLM panel)
 * and intentionally excludes single stocks. Two separate concerns; keep them
 * in sync deliberately, not automatically. If you add a ticker here, ask
 * whether it also belongs in INDEX_ETFS (committee fast-path).
 */
export const CLUSTER_MAP: Record<string, string> = {
  // US large-cap equity beta (one bet regardless of ticker)
  SPY:  'us-large-cap-beta',
  QQQ:  'us-large-cap-beta',
  VOO:  'us-large-cap-beta',
  VTI:  'us-large-cap-beta',
  DIA:  'us-large-cap-beta',
  IWM:  'us-large-cap-beta',
  AAPL: 'us-large-cap-beta',
  MSFT: 'us-large-cap-beta',
  NVDA: 'us-large-cap-beta',
  GOOGL:'us-large-cap-beta',
  AMZN: 'us-large-cap-beta',
  // Long-duration US Treasuries (low/negative equity correlation in most regimes)
  TLT:  'long-treasuries',
  IEF:  'long-treasuries',
  SHY:  'long-treasuries',
  GOVT: 'long-treasuries',
  // Gold (independent commodity / safe-haven sleeve)
  GLD:  'gold',
  IAU:  'gold',
  // Broad commodities
  DBC:  'commodities',
  GSG:  'commodities',
  USO:  'commodities',
  // Developed international ex-US equity
  VEA:  'intl-equity',
  EFA:  'intl-equity',
  VWO:  'intl-equity',
  EEM:  'intl-equity',
}

/** Default gross exposure cap per cluster as a fraction of NAV. */
export const DEFAULT_CLUSTER_CAP_PCT = 0.20

export function clusterFor(asset: string): string {
  return CLUSTER_MAP[asset.toUpperCase()] ?? asset.toUpperCase()
}

export interface ClusterGateInput {
  asset: string
  proposedSizeUsd: number
  positions: EnginePosition[]
  nav: number | null
  capPct?: number
}

export interface ClusterGateResult {
  allowed: boolean
  cluster: string
  currentExposureUsd: number
  capUsd: number
  /** Largest size that would fit under the cap (>= 0). */
  allowedSizeUsd: number
  reason: string
}

/**
 * Deterministic gross-exposure gate. Sums |market_value| of open positions in
 * the same cluster as the proposed asset and checks proposed + current against
 * the cluster cap (NAV * capPct). Buy-side only book, but we use abs
 * market_value so the math is side-agnostic.
 *
 * NAV unavailable (null/<=0) -> gate is a no-op pass (we do not block trades
 * on a missing NAV; the per-strategy cap and engine rails still apply).
 */
export function evaluateClusterGate(input: ClusterGateInput): ClusterGateResult {
  const cluster = clusterFor(input.asset)
  const capPct = input.capPct ?? DEFAULT_CLUSTER_CAP_PCT

  const currentExposureUsd = input.positions
    .filter((p) => clusterFor(p.asset) === cluster)
    .reduce((sum, p) => sum + Math.abs(p.market_value), 0)

  if (input.nav == null || input.nav <= 0) {
    return {
      allowed: true,
      cluster,
      currentExposureUsd,
      capUsd: Infinity,
      allowedSizeUsd: input.proposedSizeUsd,
      reason: 'NAV unavailable; cluster gate skipped',
    }
  }

  const capUsd = input.nav * capPct
  const headroom = Math.max(0, capUsd - currentExposureUsd)
  const allowed = input.proposedSizeUsd <= headroom

  return {
    allowed,
    cluster,
    currentExposureUsd,
    capUsd,
    allowedSizeUsd: Math.min(input.proposedSizeUsd, headroom),
    reason: allowed
      ? `cluster ${cluster} exposure ${currentExposureUsd.toFixed(0)} + ${input.proposedSizeUsd.toFixed(0)} <= cap ${capUsd.toFixed(0)}`
      : `cluster ${cluster} would breach cap: current ${currentExposureUsd.toFixed(0)} + proposed ${input.proposedSizeUsd.toFixed(0)} > cap ${capUsd.toFixed(0)} (headroom ${headroom.toFixed(0)})`,
  }
}
