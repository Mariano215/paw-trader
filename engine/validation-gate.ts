/**
 * Phase E Task 3 -- pre-live validation gate.
 *
 * Reads the derived realized-P&L layer (trader_realized_pnl) and the
 * metrics module, never engine_orders or the verdict path. Returns a
 * structured pass/fail with a per-criterion breakdown so the operator
 * sees exactly which conditions block go-live.
 *
 * Framing corrections baked in:
 *  - 100 closed trades sizes a win-rate confidence interval. It is NOT
 *    proof of edge. Edge is gated by deflatedSharpe + positive
 *    expectancy, evaluated separately.
 *  - The max-drawdown kill level is a DELIBERATELY CHOSEN number, not a
 *    universal constant. It is pre-committed here and reviewed in code.
 *  - Out-of-sample/no-retuning cannot be proven from data; the caller
 *    asserts it via `outOfSampleNoRetune`. A false value fails the gate.
 *  - The 30-trade live reconciliation is EARLY WARNING only and never
 *    contributes to the pass decision.
 */
import { sharpe, deflatedSharpe, tradeStats, maxDrawdown, type EquityPoint } from './metrics.js'

// --- Pre-committed thresholds (review these in code, do not tune per run) ---
export const GATE_MIN_CLOSED_TRADES = 100
export const GATE_MIN_REGIMES = 2
/** Probability that true Sharpe > 0, from deflatedSharpe. 0.95 floor. */
export const GATE_MIN_DEFLATED_SHARPE = 0.95
/** Expectancy must be strictly positive (net of costs). */
export const GATE_MIN_EXPECTANCY = 0
/**
 * Pre-committed max-drawdown kill level on the paper equity curve.
 * Chosen deliberately at 20%: deep enough to let a real strategy
 * breathe through normal variance, shallow enough that a broken one
 * trips before it would on live money. Revisit only by code review.
 */
export const GATE_MAX_DRAWDOWN_KILL = 0.20
/**
 * Live-vs-backtest degradation kill. If live Sharpe falls below this
 * fraction of backtest Sharpe, the gate fails. 0.5 = live may be at
 * most half as good as backtest before we refuse go-live.
 */
export const GATE_MIN_LIVE_BACKTEST_RATIO = 0.5
/** Early-warning sample size for the live reconciliation. Not a gate. */
export const LIVE_RECON_EARLY_WARNING_TRADES = 30

export interface GateInput {
  /** Per-trade fractional net returns from trader_realized_pnl. */
  closedReturns: number[]
  /** Paper equity curve over the validation window. */
  equityCurve: EquityPoint[]
  /** Count of distinct market regimes the closed trades span. */
  regimesObserved: number
  /** Effective independent variants tested, for deflatedSharpe. */
  variantsTested: number
  /** Caller asserts the test window had no re-tuning. Cannot be data-proven. */
  outOfSampleNoRetune: boolean
  /** Backtest Sharpe for the same strategy, for the degradation check. */
  backtestSharpe: number
  /** Live (paper) per-trade returns observed so far, for early warning. */
  liveReconReturns: number[]
}

export interface GateCriterion {
  name: string
  passed: boolean
  detail: string
}

export interface GateResult {
  passed: boolean
  criteria: GateCriterion[]
  /** Non-blocking early-warning notes (live reconciliation). */
  warnings: string[]
}

/**
 * Evaluate the full pre-live gate. `passed` is the AND of every
 * blocking criterion. Warnings never affect `passed`.
 */
export function evaluateGate(input: GateInput): GateResult {
  const criteria: GateCriterion[] = []
  const warnings: string[] = []

  const n = input.closedReturns.length
  criteria.push({
    name: 'closed_trades',
    passed: n >= GATE_MIN_CLOSED_TRADES,
    detail: `${n}/${GATE_MIN_CLOSED_TRADES} closed trades (sizes a win-rate CI, not proof of edge)`,
  })

  criteria.push({
    name: 'market_regimes',
    passed: input.regimesObserved >= GATE_MIN_REGIMES,
    detail: `${input.regimesObserved}/${GATE_MIN_REGIMES} distinct regimes observed`,
  })

  criteria.push({
    name: 'out_of_sample_no_retune',
    passed: input.outOfSampleNoRetune === true,
    detail: input.outOfSampleNoRetune
      ? 'caller asserts true out-of-sample, no re-tuning on the test set'
      : 'NOT asserted out-of-sample; re-tuning on the test set invalidates the gate',
  })

  const observedSharpe = sharpe(input.closedReturns)
  // Math.max(1, ...) clamps variantsTested to at least 1. With exactly 1
  // variant, deflatedSharpe returns ~1.0 for any positive observed Sharpe
  // because a single un-repeated test has no selection bias per Bailey/Lopez
  // de Prado. The DSR criterion therefore auto-passes when only one variant
  // was tested. The honesty of variantsTested is the caller's responsibility
  // and cannot be enforced here.
  const dsr = deflatedSharpe(observedSharpe, input.closedReturns, Math.max(1, input.variantsTested))
  criteria.push({
    name: 'deflated_sharpe',
    passed: dsr >= GATE_MIN_DEFLATED_SHARPE,
    detail: `deflated Sharpe ${dsr.toFixed(4)} vs floor ${GATE_MIN_DEFLATED_SHARPE} ` +
      `(observed Sharpe ${observedSharpe.toFixed(3)}, ${input.variantsTested} variants tested)`,
  })

  const stats = tradeStats(input.closedReturns)
  criteria.push({
    name: 'positive_expectancy',
    passed: stats.expectancy > GATE_MIN_EXPECTANCY,
    detail: `expectancy ${stats.expectancy.toFixed(5)} (win rate ${(stats.winRate * 100).toFixed(1)}%, ` +
      `avgWin ${stats.avgWin.toFixed(4)}, avgLoss ${stats.avgLoss.toFixed(4)})`,
  })

  const dd = maxDrawdown(input.equityCurve)
  criteria.push({
    name: 'max_drawdown_kill',
    passed: dd.maxDrawdown <= GATE_MAX_DRAWDOWN_KILL,
    detail: `max drawdown ${(dd.maxDrawdown * 100).toFixed(1)}% vs kill ${(GATE_MAX_DRAWDOWN_KILL * 100).toFixed(0)}% ` +
      `(duration ${Math.round(dd.durationMs / 86_400_000)}d)`,
  })

  const liveSharpe = sharpe(input.liveReconReturns)
  const ratio = input.backtestSharpe > 0 ? liveSharpe / input.backtestSharpe : 0
  criteria.push({
    name: 'live_vs_backtest_degradation',
    passed: input.backtestSharpe <= 0 ? false : ratio >= GATE_MIN_LIVE_BACKTEST_RATIO,
    detail: input.backtestSharpe <= 0
      ? 'backtest Sharpe non-positive; cannot certify live degradation'
      : `live/backtest Sharpe ratio ${ratio.toFixed(2)} vs floor ${GATE_MIN_LIVE_BACKTEST_RATIO}`,
  })

  // Early warning only -- never blocks the gate.
  if (input.liveReconReturns.length < LIVE_RECON_EARLY_WARNING_TRADES) {
    warnings.push(
      `live reconciliation has ${input.liveReconReturns.length}/${LIVE_RECON_EARLY_WARNING_TRADES} ` +
      'trades; reconciliation is early-warning only and not part of the pass decision',
    )
  } else {
    const liveStats = tradeStats(input.liveReconReturns)
    if (liveStats.expectancy <= 0) {
      warnings.push(
        `live reconciliation expectancy ${liveStats.expectancy.toFixed(5)} is non-positive (early warning)`,
      )
    }
  }

  const passed = criteria.every((c) => c.passed)
  return { passed, criteria, warnings }
}
