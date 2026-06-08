/**
 * Phase E Task 1 -- evaluation metrics (pure functions).
 *
 * Operates on two inputs the caller derives from the raw-fills audit
 * layer (Task 2), never from engine_orders (which carry no fills):
 *
 *   EquityPoint[]  -- a NAV/equity curve, ascending by ts_ms.
 *   number[]       -- per-trade fractional net returns (0.012 = +1.2%).
 *
 * Annualization constant is 252 trading days. The Sharpe doc carries
 * the IID caveat on purpose: with momentum and overlapping holds the
 * naive Sharpe overstates edge, so the validation gate (Task 3) leans
 * on the Deflated Sharpe and expectancy, not raw Sharpe.
 */

export const TRADING_DAYS_PER_YEAR = 252
export const MS_PER_YEAR = 365.25 * 24 * 60 * 60 * 1000

export interface EquityPoint {
  ts_ms: number
  equity: number
}

export interface DrawdownResult {
  /** Magnitude as a non-negative fraction of the running peak (0.2 = 20% down). */
  maxDrawdown: number
  /** Calendar ms from the peak that started the worst drawdown to its trough. */
  durationMs: number
  peakTsMs: number | null
  troughTsMs: number | null
}

function mean(xs: number[]): number {
  if (xs.length === 0) return 0
  return xs.reduce((s, x) => s + x, 0) / xs.length
}

/** Population stdev (divide by N). Returns 0 for fewer than 2 points. */
function stdevPopulation(xs: number[]): number {
  if (xs.length < 2) return 0
  const m = mean(xs)
  const variance = xs.reduce((s, x) => s + (x - m) ** 2, 0) / xs.length
  return Math.sqrt(variance)
}

/**
 * CAGR from the equity curve over fractional years.
 * (end / start) ** (1 / years) - 1. Returns 0 when the span is under
 * one day, the curve has fewer than 2 points, or start <= 0.
 */
export function cagr(curve: EquityPoint[]): number {
  if (curve.length < 2) return 0
  const start = curve[0]
  const end = curve[curve.length - 1]
  if (start.equity <= 0) return 0
  const years = (end.ts_ms - start.ts_ms) / MS_PER_YEAR
  if (years <= 1 / 365.25) return 0
  return Math.pow(end.equity / start.equity, 1 / years) - 1
}

/**
 * Annualized Sharpe = mean(excess) / stdev(excess) * sqrt(252).
 * `returns` are per-period returns at the period implied by the 252
 * scaling (daily). `rfPerPeriod` defaults to 0. Returns 0 when stdev
 * is 0 or fewer than 2 returns.
 *
 * CAVEAT: valid only under IID returns. Momentum strategies and
 * overlapping positions break IID and inflate this number. Treat as a
 * ranking aid, not proof of edge. Use deflatedSharpe for gating.
 */
export function sharpe(returns: number[], rfPerPeriod = 0): number {
  if (returns.length < 2) return 0
  const excess = returns.map((r) => r - rfPerPeriod)
  const sd = stdevPopulation(excess)
  if (sd === 0) return 0
  return (mean(excess) / sd) * Math.sqrt(TRADING_DAYS_PER_YEAR)
}

/**
 * Annualized Sortino. Downside deviation divides the sum of squared
 * negative excess returns by TOTAL N (not the count of losers), per
 * the corrected definition. Returns 0 when there is no downside
 * dispersion or fewer than 2 returns.
 */
export function sortino(returns: number[], rfPerPeriod = 0): number {
  if (returns.length < 2) return 0
  const excess = returns.map((r) => r - rfPerPeriod)
  const downsideSq = excess.reduce((s, r) => (r < 0 ? s + r * r : s), 0)
  const downsideDev = Math.sqrt(downsideSq / excess.length)
  if (downsideDev === 0) return 0
  return (mean(excess) / downsideDev) * Math.sqrt(TRADING_DAYS_PER_YEAR)
}

/**
 * Max drawdown over an equity curve. Running-peak method. Reports the
 * magnitude (non-negative fraction of peak) AND the duration (peak ms
 * to trough ms of the single worst drawdown). Returns zeros for a
 * curve with fewer than 2 points or a non-positive first peak.
 */
export function maxDrawdown(curve: EquityPoint[]): DrawdownResult {
  const empty: DrawdownResult = {
    maxDrawdown: 0, durationMs: 0, peakTsMs: null, troughTsMs: null,
  }
  if (curve.length < 2) return empty
  let peak = curve[0].equity
  let peakTs = curve[0].ts_ms
  let worst = 0
  let worstPeakTs: number | null = null
  let worstTroughTs: number | null = null
  for (const p of curve) {
    if (p.equity > peak) {
      peak = p.equity
      peakTs = p.ts_ms
    }
    if (peak > 0) {
      const dd = (peak - p.equity) / peak
      if (dd > worst) {
        worst = dd
        worstPeakTs = peakTs
        worstTroughTs = p.ts_ms
      }
    }
  }
  return {
    maxDrawdown: worst,
    durationMs: worstPeakTs !== null && worstTroughTs !== null ? worstTroughTs - worstPeakTs : 0,
    peakTsMs: worstPeakTs,
    troughTsMs: worstTroughTs,
  }
}

/** Calmar = CAGR / max drawdown magnitude. Returns 0 when DD is 0. */
export function calmar(curve: EquityPoint[]): number {
  const dd = maxDrawdown(curve).maxDrawdown
  if (dd === 0) return 0
  return cagr(curve) / dd
}

export interface TradeStats {
  winRate: number
  avgWin: number
  avgLoss: number
  expectancy: number
  profitFactor: number
  count: number
}

/**
 * Per-trade stats from fractional net returns. Break-even (0) trades
 * count as losses (conservative, matches track-record.ts:106-110).
 *
 *  winRate     = wins / count
 *  avgWin      = mean of positive returns (0 if none)
 *  avgLoss     = mean magnitude of non-positive returns, reported as a
 *                positive number (0 if none)
 *  expectancy  = winRate*avgWin - (1-winRate)*avgLoss
 *  profitFactor= sum(wins) / sum(|losses|); Infinity when there are
 *                wins and no losses, 0 when there are no wins.
 */
export function tradeStats(returns: number[]): TradeStats {
  const zero: TradeStats = {
    winRate: 0, avgWin: 0, avgLoss: 0, expectancy: 0, profitFactor: 0, count: 0,
  }
  if (returns.length === 0) return zero
  const wins = returns.filter((r) => r > 0)
  const losses = returns.filter((r) => r <= 0)
  const winRate = wins.length / returns.length
  const avgWin = wins.length > 0 ? mean(wins) : 0
  const avgLoss = losses.length > 0 ? Math.abs(mean(losses)) : 0
  const expectancy = winRate * avgWin - (1 - winRate) * avgLoss
  const grossWin = wins.reduce((s, r) => s + r, 0)
  const grossLoss = Math.abs(losses.reduce((s, r) => s + r, 0))
  let profitFactor = 0
  if (grossLoss === 0) profitFactor = grossWin > 0 ? Infinity : 0
  else profitFactor = grossWin / grossLoss
  return { winRate, avgWin, avgLoss, expectancy, profitFactor, count: returns.length }
}

export interface AlphaBeta {
  beta: number
  /** Jensen's alpha at the SAME period frequency as the inputs (not annualized). */
  alpha: number
}

/**
 * Beta and Jensen's alpha of strategy returns vs benchmark returns.
 * Both arrays must be the SAME length and the SAME period frequency
 * (the caller aligns strategy returns to SPY total-return bars before
 * calling). beta = cov(strat, bench) / var(bench). alpha =
 * mean(strat) - rf - beta*(mean(bench) - rf). Returns {beta:0,alpha:0}
 * when lengths differ, are under 2, or benchmark variance is 0.
 */
export function alphaBeta(
  strat: number[],
  bench: number[],
  rfPerPeriod = 0,
): AlphaBeta {
  if (strat.length !== bench.length || strat.length < 2) return { beta: 0, alpha: 0 }
  const ms = mean(strat)
  const mb = mean(bench)
  let cov = 0
  let varB = 0
  for (let i = 0; i < strat.length; i++) {
    cov += (strat[i] - ms) * (bench[i] - mb)
    varB += (bench[i] - mb) ** 2
  }
  if (varB === 0) return { beta: 0, alpha: 0 }
  const beta = cov / varB
  const alpha = (ms - rfPerPeriod) - beta * (mb - rfPerPeriod)
  return { beta, alpha }
}

/**
 * Deflated Sharpe Ratio (Bailey & Lopez de Prado), the gate-relevant
 * Sharpe. Deflates the observed annualized Sharpe for the number of
 * effective INDEPENDENT trials (variants tested) and the return
 * sample's skew/kurtosis, then returns the probability (0..1) that the
 * true Sharpe exceeds 0. Inputs:
 *   observedSharpeAnnual -- output of sharpe()
 *   returns              -- the per-period return series it came from
 *   trials               -- effective independent variants tested (>=1)
 *
 * A higher number is better. The gate (Task 3) requires this to clear
 * a pre-committed floor, which raw Sharpe alone cannot establish.
 */
export function deflatedSharpe(
  observedSharpeAnnual: number,
  returns: number[],
  trials: number,
): number {
  const n = returns.length
  if (n < 4 || trials < 1) return 0
  const srPer = observedSharpeAnnual / Math.sqrt(TRADING_DAYS_PER_YEAR)
  const m = mean(returns)
  const sd = stdevPopulation(returns)
  if (sd === 0) return 0
  const skew = returns.reduce((s, r) => s + ((r - m) / sd) ** 3, 0) / n
  const kurt = returns.reduce((s, r) => s + ((r - m) / sd) ** 4, 0) / n
  // Expected max Sharpe under the null across `trials` independent trials.
  const e = 0.5772156649015329 // Euler-Mascheroni
  const z1 = inverseNormalCdf(1 - 1 / trials)
  const z2 = inverseNormalCdf(1 - 1 / (trials * Math.E))
  const expectedMaxSr = z1 * (1 - e) + z2 * e
  const radicand = 1 - skew * srPer + ((kurt - 1) / 4) * srPer * srPer
  if (radicand <= 0) return 0
  const denom = Math.sqrt(radicand)
  const dsr = (srPer - expectedMaxSr) * Math.sqrt(n - 1) / denom
  return normalCdf(dsr)
}

/** Standard normal CDF via Abramowitz-Stegun 7.1.26 erf approximation. */
function normalCdf(x: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(x))
  const d = 0.3989422804014327 * Math.exp(-x * x / 2)
  const p = d * t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))))
  return x >= 0 ? 1 - p : p
}

/** Inverse normal CDF (Acklam's rational approximation), good to ~1e-9. */
function inverseNormalCdf(p: number): number {
  if (p <= 0) return -Infinity
  if (p >= 1) return Infinity
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.383577518672690e2, -3.066479806614716e1, 2.506628277459239]
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1]
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783]
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416]
  const plow = 0.02425
  const phigh = 1 - plow
  if (p < plow) {
    const q = Math.sqrt(-2 * Math.log(p))
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
  }
  if (p > phigh) {
    const q = Math.sqrt(-2 * Math.log(1 - p))
    return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
  }
  const q = p - 0.5
  const r = q * q
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q /
    (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1)
}
