import { describe, it, expect } from 'vitest'
import Database from 'better-sqlite3'
import { initTraderTables } from './db.js'
import {
  backtestDeflatedSharpe, backtestEvidenceFromReport, bypassesScoreThreshold, isMeanReversionFamily, MIN_TRIAL_SHARPE_VARIANCE, dailyBacktestEvidence, familyTrialCount, strategyFamily,
  stressGateFailures, V2_STOCK_UNIVERSE, EQUITY_REVERSION_UNIVERSE,
} from './backtest-report.js'
import type { BacktestGateReport, BacktestStress } from './types.js'

const report: BacktestGateReport = {
  version: 3, computed_at_ms: 5, engine_revision: 'abc', days: 1260, universe: V2_STOCK_UNIVERSE,
  strategies: {
    'momentum-stocks': {
      live_params: { min_score: 0.7, horizon_days: 20 },
      fixed_rule: { strategy: 'momentum', sharpe: 3.3, n_trades: 93 } as never,
      sweep: { n_trials: 8, sharpe_variance_per_period: 0.002, best: null, trials: [] },
      walk_forward: { oos_sharpe: 0.9, oos_n_trades: 60, oos_expectancy: 0.004, oos_max_drawdown: 0.1, oos_win_rate: 0.55, folds: [], train_bars: 504, test_bars: 126, step: 126, method: 'wf',
        oos_n_days: 756, oos_daily_skew: -0.2, oos_daily_kurtosis: 5, n_signal_days: 50, per_trade_sharpe_unannualized: 0.2 },
    },
  },
}

describe('backtestEvidenceFromReport', () => {
  it('records the walk-forward OOS numbers and the trial statistics', () => {
    const ev = backtestEvidenceFromReport(report, 'momentum-stocks', 'fp')
    expect(ev).toMatchObject({ configFingerprint: 'fp', sharpe: 0.9, tradeCount: 60, maxDrawdownPct: 0.1 })
    expect(ev.report).toMatchObject({ n_trials: 8, sharpe_variance_per_period: 0.002, engine_revision: 'abc', source: 'walk_forward_oos', report_version: 3 })
  })
  it('refuses a v2 report: its Sharpe is per-trade and inflated', () => {
    expect(() => backtestEvidenceFromReport({ ...report, version: 2 }, 'momentum-stocks', 'fp')).toThrow(/v3/)
  })
  it('refuses a strategy the report does not cover', () => {
    expect(() => backtestEvidenceFromReport(report, 'mean-reversion-stocks', 'fp')).toThrow(/no report entry/)
  })
  it('has twelve symbols in the v2 universe', () => {
    expect(V2_STOCK_UNIVERSE).toHaveLength(12)
  })
  it('has the 17 equity symbols in the RSI(2)/IBS universe', () => {
    expect([...EQUITY_REVERSION_UNIVERSE].sort()).toEqual(['AAPL', 'EEM', 'EFA', 'IWM', 'MSFT', 'QQQ', 'SPY', 'VTI',
      'XLB', 'XLE', 'XLF', 'XLI', 'XLK', 'XLP', 'XLU', 'XLV', 'XLY'])
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

describe('daily backtest evidence and DSR', () => {
  const blob = (sharpe: number, over: Record<string, unknown> = {}) => ({
    report_version: 3, n_trials: 1, sharpe_variance_per_period: null,
    walk_forward: { oos_sharpe: sharpe, oos_n_days: 1000, oos_daily_skew: 0, oos_daily_kurtosis: 3 }, ...over,
  })
  function db() {
    const d = new Database(':memory:')
    d.pragma('foreign_keys=OFF')
    initTraderTables(d)
    return d
  }
  function addCohort(d: Database.Database, id: string, strategyId: string, report: unknown) {
    d.prepare(`INSERT INTO trader_evaluation_cohorts (id,strategy_id,asset_class,status,config_json,config_fingerprint,universe_json,
      data_venue,execution_venue,mode,fee_bps_per_side,slippage_bps_per_side,benchmark_asset,max_position_usd,daily_trade_cap,
      min_closed_trades,min_regimes,max_drawdown_pct,min_deflated_sharpe,min_backtest_ratio,claudepaw_revision,engine_revision,
      backtest_report_json,no_retune,created_at)
      VALUES (?,?,'stocks','draft','{}','fp','["SPY"]','alpaca','alpaca','paper',0,5,'SPY',10000,5,100,2,0.2,0.95,0.5,'abc1234','abc1234',?,1,1)`)
      .run(id, strategyId, report == null ? null : JSON.stringify(report))
  }

  it('groups the mean-reversion family and leaves others alone', () => {
    expect(strategyFamily('rsi2-stocks')).toContain('mean-reversion-stocks')
    expect(strategyFamily('momentum-stocks')).toEqual(['momentum-stocks'])
    expect(strategyFamily('trend-4h-crypto')).toEqual(['trend-4h-crypto'])
  })

  it('counts every cohort ever created in the family plus the sweep trials', () => {
    const d = db()
    addCohort(d, 'mr-v1', 'mean-reversion-stocks', null)
    addCohort(d, 'mr-v4', 'mean-reversion-stocks', null)
    addCohort(d, 'rsi2-v1', 'rsi2-stocks', null)
    addCohort(d, 'mom-v2', 'momentum-stocks', null)
    expect(familyTrialCount(d, 'ibs-stocks', 1)).toBe(4)
    expect(familyTrialCount(d, 'momentum-stocks', 8)).toBe(9)
  })

  it('reads v3 evidence and marks v2 evidence as unusable', () => {
    expect(dailyBacktestEvidence(blob(1.2))).toMatchObject({ sharpe: 1.2, nDays: 1000, skew: 0, kurtosis: 3 })
    expect(dailyBacktestEvidence({ ...blob(8.6), report_version: undefined })).toBeNull()
    expect(dailyBacktestEvidence(blob(1.2, { walk_forward: { oos_sharpe: 1.2 } }))).toBeNull()
    expect(dailyBacktestEvidence(null)).toBeNull()
  })

  it('needs three family Sharpes for the fallback variance, uses n-1, and floors it', () => {
    const d = db()
    addCohort(d, 'rsi2-v1', 'rsi2-stocks', blob(1.5))
    addCohort(d, 'ibs-v1', 'ibs-stocks', blob(1.4))
    const two = backtestDeflatedSharpe(d, 'rsi2-stocks', dailyBacktestEvidence(blob(1.5)))
    expect(two.trials).toBe(3)
    expect(two.variance).toBeUndefined()
    expect(two.dsr).toBe(0)
    addCohort(d, 'mr-v5', 'mean-reversion-stocks', blob(1.45))
    const three = backtestDeflatedSharpe(d, 'rsi2-stocks', dailyBacktestEvidence(blob(1.5)))
    // Sample variance of 1.5, 1.4, 1.45 (annual) is tiny, so the floor applies.
    expect(three.variance).toBe(MIN_TRIAL_SHARPE_VARIANCE)
    addCohort(d, 'mr-v6', 'mean-reversion-stocks', blob(-1))
    const wide = backtestDeflatedSharpe(d, 'rsi2-stocks', dailyBacktestEvidence(blob(1.5)))
    const per = [1.5, 1.4, 1.45, -1].map(v => v / Math.sqrt(252))
    const m = per.reduce((acc, v) => acc + v, 0) / 4
    expect(wide.variance).toBeCloseTo(per.reduce((acc, v) => acc + (v - m) ** 2, 0) / 3, 12)
    expect(backtestDeflatedSharpe(d, 'rsi2-stocks', null)).toMatchObject({ dsr: 0 })
  })

  it('floors the sweep variance too and still passes a strong backtest', () => {
    const d = db()
    const ev = dailyBacktestEvidence(blob(2.0, { n_trials: 8, sharpe_variance_per_period: 0.0001 }))
    const r = backtestDeflatedSharpe(d, 'momentum-stocks', ev)
    expect(r).toMatchObject({ trials: 8, variance: MIN_TRIAL_SHARPE_VARIANCE })
    expect(r.dsr).toBeGreaterThan(0.95)
    expect(MIN_TRIAL_SHARPE_VARIANCE).toBeCloseTo(0.25 / 252, 12)
  })

  it('names the reversion family and the binary-entry strategies', () => {
    expect(['mean-reversion-stocks', 'rsi2-stocks', 'ibs-stocks', 'mean-reversion-hourly-crypto'].every(isMeanReversionFamily)).toBe(true)
    expect(isMeanReversionFamily('momentum-stocks')).toBe(false)
    expect(bypassesScoreThreshold('rsi2-stocks') && bypassesScoreThreshold('ibs-stocks')).toBe(true)
    expect(bypassesScoreThreshold('mean-reversion-stocks')).toBe(false)
  })
})
