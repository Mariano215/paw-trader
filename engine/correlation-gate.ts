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

/** Default gross exposure cap per cluster as a fraction of NAV.
 *  Raised 0.20 -> 0.50 (2026-06-28): the 20% cap suppressed ~53% of all
 *  signals because correlated ETFs (SPY/QQQ/IWM/VTI) share one cluster and a
 *  couple of positions exhausted the 20% headroom, freezing new entries.
 *  50% keeps a real concentration guard while letting trades flow. */
export const DEFAULT_CLUSTER_CAP_PCT = 0.50

/** Default gross exposure cap per SYMBOL as a fraction of NAV. Tighter than
 *  the cluster cap on purpose: a cluster can hold several tickers so 50% NAV
 *  spread across them is fine, but a singleton symbol (e.g. EEM, the only
 *  member of 'intl-equity' in most books) could otherwise absorb the whole
 *  cluster cap alone via repeated same-symbol signals, since nothing else
 *  checked for an existing position before sizing a new one. Added 2026-07-09
 *  after a 100%-EEM concentration incident. */
export const DEFAULT_SYMBOL_CAP_PCT = 0.15

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

/** Shared gross-exposure math: given current exposure in some grouping
 *  (cluster or single symbol) and a proposed additional size, checks against
 *  NAV * capPct. NAV unavailable (null/<=0) -> no-op pass (we do not block
 *  trades on a missing NAV; the per-strategy cap and engine rails still
 *  apply). */
function evaluateExposureCap(
  groupLabel: string,
  currentExposureUsd: number,
  proposedSizeUsd: number,
  nav: number | null,
  capPct: number,
  groupKind: string,
): ClusterGateResult {
  if (nav == null || nav <= 0) {
    return {
      allowed: true,
      cluster: groupLabel,
      currentExposureUsd,
      capUsd: Infinity,
      allowedSizeUsd: proposedSizeUsd,
      reason: `NAV unavailable; ${groupKind} gate skipped`,
    }
  }

  const capUsd = nav * capPct
  const headroom = Math.max(0, capUsd - currentExposureUsd)
  const allowed = proposedSizeUsd <= headroom

  return {
    allowed,
    cluster: groupLabel,
    currentExposureUsd,
    capUsd,
    allowedSizeUsd: Math.min(proposedSizeUsd, headroom),
    reason: allowed
      ? `${groupKind} ${groupLabel} exposure ${currentExposureUsd.toFixed(0)} + ${proposedSizeUsd.toFixed(0)} <= cap ${capUsd.toFixed(0)}`
      : `${groupKind} ${groupLabel} would breach cap: current ${currentExposureUsd.toFixed(0)} + proposed ${proposedSizeUsd.toFixed(0)} > cap ${capUsd.toFixed(0)} (headroom ${headroom.toFixed(0)})`,
  }
}

/**
 * Deterministic gross-exposure gate. Sums |market_value| of open positions in
 * the same cluster as the proposed asset and checks proposed + current against
 * the cluster cap (NAV * capPct). Buy-side only book, but we use abs
 * market_value so the math is side-agnostic.
 */
export function evaluateClusterGate(input: ClusterGateInput): ClusterGateResult {
  const cluster = clusterFor(input.asset)
  const capPct = input.capPct ?? DEFAULT_CLUSTER_CAP_PCT
  const currentExposureUsd = input.positions
    .filter((p) => clusterFor(p.asset) === cluster)
    .reduce((sum, p) => sum + Math.abs(p.market_value), 0)
  return evaluateExposureCap(cluster, currentExposureUsd, input.proposedSizeUsd, input.nav, capPct, 'cluster')
}

/**
 * Deterministic gross-exposure gate scoped to a single symbol, not its whole
 * cluster. Prevents one ticker from repeatedly absorbing signals (each sized
 * under the cluster cap individually) until it alone accounts for most of the
 * cluster's -- or the book's -- exposure. See DEFAULT_SYMBOL_CAP_PCT.
 */
export function evaluateSymbolGate(input: ClusterGateInput): ClusterGateResult {
  const symbol = input.asset.toUpperCase()
  const capPct = input.capPct ?? DEFAULT_SYMBOL_CAP_PCT
  const currentExposureUsd = input.positions
    .filter((p) => p.asset.toUpperCase() === symbol)
    .reduce((sum, p) => sum + Math.abs(p.market_value), 0)
  return evaluateExposureCap(symbol, currentExposureUsd, input.proposedSizeUsd, input.nav, capPct, 'symbol')
}
