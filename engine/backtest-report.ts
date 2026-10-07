// Turns the engine's sweep + walk-forward report into cohort backtest evidence.
// The recorded Sharpe is OUT OF SAMPLE (walk-forward), never the fixed-rule
// in-sample number, so a cohort's backtest_sharpe is a claim the data never
// tuned on.
import type { BacktestGateReport, BacktestStress } from './types.js'
import type { CohortBacktestEvidence } from './evaluation-cohort.js'

/** Engine default_universe() as of 2026-09-18, frozen here so the cohort covers every symbol the engine scores. */
export const V2_STOCK_UNIVERSE = ['SPY', 'QQQ', 'IWM', 'VTI', 'AAPL', 'MSFT', 'TLT', 'IEF', 'GLD', 'DBC', 'EFA', 'EEM']

/** Engine default_universe() as of 2026-10-07: V2 plus the nine US sector SPDRs. */
export const V4_STOCK_UNIVERSE = [...V2_STOCK_UNIVERSE, 'XLK', 'XLF', 'XLE', 'XLV', 'XLI', 'XLP', 'XLU', 'XLY', 'XLB']

export function backtestEvidenceFromReport(report: BacktestGateReport, strategyId: string, configFingerprint: string): CohortBacktestEvidence {
  const entry = report.strategies?.[strategyId]
  if (!entry) throw new Error(`no report entry for ${strategyId}`)
  const wf = entry.walk_forward
  if (wf.oos_sharpe == null || !Number.isFinite(wf.oos_sharpe) || wf.oos_n_trades < 2 || wf.oos_max_drawdown == null) {
    throw new Error(`walk-forward evidence incomplete for ${strategyId}: trades=${wf.oos_n_trades} sharpe=${wf.oos_sharpe} maxDD=${wf.oos_max_drawdown}`)
  }
  return {
    configFingerprint,
    sharpe: wf.oos_sharpe,
    tradeCount: wf.oos_n_trades,
    maxDrawdownPct: wf.oos_max_drawdown,
    report: {
      source: 'walk_forward_oos',
      engine_revision: report.engine_revision,
      computed_at_ms: report.computed_at_ms,
      n_trials: entry.sweep.n_trials,
      sharpe_variance_per_period: entry.sweep.sharpe_variance_per_period,
      live_params: entry.live_params,
      walk_forward: wf,
      fixed_rule: entry.fixed_rule,
      stress: entry.stress ?? null,
      config_fingerprint: configFingerprint,
    },
  }
}

/** Minimum OOS trades in each market type before its result counts as tested. */
export const STRESS_MIN_TRADES_PER_REGIME = 20

/**
 * Pre-paper stress gate. A stock strategy starts paper only if it
 *   1. keeps positive OOS expectancy at 2x modeled costs, and
 *   2. was tested in both calm and volatile markets (>= 20 OOS trades each)
 *      without negative expectancy in either.
 * Trend buckets are reported but not gated: 5 years hold too few down-trend trades.
 * Returns the failures; an empty list means pass. Missing evidence fails closed.
 */
export function stressGateFailures(stress: BacktestStress | null | undefined): string[] {
  if (!stress) return ['no stress evidence: rerun scripts/run_backtest_gate.py (report v2) and record-engine-backtest']
  const failures: string[] = []
  const x2 = stress.cost_x2?.oos_expectancy
  if (x2 == null || !(x2 > 0)) failures.push(`2x costs: OOS expectancy ${x2 == null ? 'n/a' : (x2 * 100).toFixed(3) + '%'} is not positive`)
  for (const regime of ['calm', 'volatile']) {
    const b = stress.vol?.[regime]
    if (!b || b.n < STRESS_MIN_TRADES_PER_REGIME) {
      failures.push(`${regime} market: ${b?.n ?? 0} OOS trades, need ${STRESS_MIN_TRADES_PER_REGIME}`)
    } else if (b.expectancy < 0) {
      failures.push(`${regime} market: OOS expectancy ${(b.expectancy * 100).toFixed(3)}% over ${b.n} trades`)
    }
  }
  return failures
}
