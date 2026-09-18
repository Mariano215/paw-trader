// Turns the engine's sweep + walk-forward report into cohort backtest evidence.
// The recorded Sharpe is OUT OF SAMPLE (walk-forward), never the fixed-rule
// in-sample number, so a cohort's backtest_sharpe is a claim the data never
// tuned on.
import type { BacktestGateReport } from './types.js'
import type { CohortBacktestEvidence } from './evaluation-cohort.js'

/** Engine default_universe() as of 2026-09-18, frozen here so the cohort covers every symbol the engine scores. */
export const V2_STOCK_UNIVERSE = ['SPY', 'QQQ', 'IWM', 'VTI', 'AAPL', 'MSFT', 'TLT', 'IEF', 'GLD', 'DBC', 'EFA', 'EEM']

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
      config_fingerprint: configFingerprint,
    },
  }
}
