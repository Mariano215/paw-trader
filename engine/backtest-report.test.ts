import { describe, it, expect } from 'vitest'
import { backtestEvidenceFromReport, V2_STOCK_UNIVERSE } from './backtest-report.js'
import type { BacktestGateReport } from './types.js'

const report: BacktestGateReport = {
  version: 1, computed_at_ms: 5, engine_revision: 'abc', days: 1260, universe: V2_STOCK_UNIVERSE,
  strategies: {
    'momentum-stocks': {
      live_params: { min_score: 0.7, horizon_days: 20 },
      fixed_rule: { strategy: 'momentum', sharpe: 3.3, n_trades: 93 } as never,
      sweep: { n_trials: 8, sharpe_variance_per_period: 0.002, best: null, trials: [] },
      walk_forward: { oos_sharpe: 0.9, oos_n_trades: 60, oos_expectancy: 0.004, oos_max_drawdown: 0.1, oos_win_rate: 0.55, folds: [], train_bars: 504, test_bars: 126, step: 126, method: 'wf' },
    },
  },
}

describe('backtestEvidenceFromReport', () => {
  it('records the walk-forward OOS numbers and the trial statistics', () => {
    const ev = backtestEvidenceFromReport(report, 'momentum-stocks', 'fp')
    expect(ev).toMatchObject({ configFingerprint: 'fp', sharpe: 0.9, tradeCount: 60, maxDrawdownPct: 0.1 })
    expect(ev.report).toMatchObject({ n_trials: 8, sharpe_variance_per_period: 0.002, engine_revision: 'abc', source: 'walk_forward_oos' })
  })
  it('refuses a strategy the report does not cover', () => {
    expect(() => backtestEvidenceFromReport(report, 'mean-reversion-stocks', 'fp')).toThrow(/no report entry/)
  })
  it('has twelve symbols in the v2 universe', () => {
    expect(V2_STOCK_UNIVERSE).toHaveLength(12)
  })
})
