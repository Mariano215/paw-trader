import { describe, it, expect } from 'vitest'
import { backtestEvidenceFromReport, stressGateFailures, V2_STOCK_UNIVERSE } from './backtest-report.js'
import type { BacktestGateReport, BacktestStress } from './types.js'

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

const bucket = (n: number, expectancy: number) => ({ n, expectancy, win_rate: 0.5, sharpe: null })
// Real 2026-10-07 numbers, 21-symbol universe, 5 years.
const meanRev: BacktestStress = {
  cost_x2: { oos_n_trades: 76, oos_sharpe: 8.28, oos_expectancy: 0.02332 },
  vol: { calm: bucket(36, 0.00115), volatile: bucket(40, 0.04522) },
  trend: { down: bucket(27, 0.05581), up: bucket(49, 0.00701) },
}

describe('stressGateFailures', () => {
  it('passes mean reversion as measured on 2026-10-07', () => {
    expect(stressGateFailures(meanRev)).toEqual([])
  })
  it('fails momentum, which lost in calm markets', () => {
    const momentum = { ...meanRev, vol: { calm: bucket(85, -0.00464), volatile: bucket(41, 0.02076) } }
    expect(stressGateFailures(momentum)).toEqual(['calm market: OOS expectancy -0.464% over 85 trades'])
  })
  it('fails a strategy that only pays at modeled costs', () => {
    const thin = { ...meanRev, cost_x2: { oos_n_trades: 83, oos_sharpe: -0.17, oos_expectancy: -0.00062 } }
    expect(stressGateFailures(thin)[0]).toMatch(/^2x costs/)
  })
  it('fails a strategy never tested in one market type', () => {
    expect(stressGateFailures({ ...meanRev, vol: { volatile: bucket(40, 0.04) } })).toEqual(['calm market: 0 OOS trades, need 20'])
  })
  it('fails closed without evidence', () => {
    expect(stressGateFailures(null)[0]).toMatch(/no stress evidence/)
  })
})
