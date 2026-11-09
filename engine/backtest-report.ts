// Turns the engine's sweep + walk-forward report into cohort backtest evidence.
// The recorded Sharpe is OUT OF SAMPLE (walk-forward), never the fixed-rule
// in-sample number, so a cohort's backtest_sharpe is a claim the data never
// tuned on.
import type Database from 'better-sqlite3'
import type { BacktestGateReport, BacktestStress } from './types.js'
import type { CohortBacktestEvidence } from './evaluation-cohort.js'
import { deflatedSharpeFromMoments, TRADING_DAYS_PER_YEAR } from './metrics.js'

/** Engine default_universe() as of 2026-09-18, frozen here so the cohort covers every symbol the engine scores. */
export const V2_STOCK_UNIVERSE = ['SPY', 'QQQ', 'IWM', 'VTI', 'AAPL', 'MSFT', 'TLT', 'IEF', 'GLD', 'DBC', 'EFA', 'EEM']

/** Engine default_universe() as of 2026-10-07: V2 plus the nine US sector SPDRs. */
export const V4_STOCK_UNIVERSE = [...V2_STOCK_UNIVERSE, 'XLK', 'XLF', 'XLE', 'XLV', 'XLI', 'XLP', 'XLU', 'XLY', 'XLB']

/** RSI(2) and IBS sleeves: V4 without TLT, IEF, GLD, DBC. The published edge is on equities. */
export const EQUITY_REVERSION_UNIVERSE = V4_STOCK_UNIVERSE.filter(s => !['TLT', 'IEF', 'GLD', 'DBC'].includes(s))

export function backtestEvidenceFromReport(report: BacktestGateReport, strategyId: string, configFingerprint: string): CohortBacktestEvidence {
  // v1/v2 reports annualized per-trade returns as if each trade were one day; that Sharpe is inflated.
  if (!(report.version >= 3)) throw new Error(`backtest report v${report.version} has per-trade Sharpe; rerun the engine gate for a v3 report`)
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
      report_version: report.version,
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

/**
 * Strategy families for the Deflated Sharpe trial count. Every cohort ever
 * created in a family is one more look at the same idea. A strategy not
 * listed is its own family.
 */
export const STRATEGY_FAMILIES: readonly (readonly string[])[] = [
  ['mean-reversion-stocks', 'rsi2-stocks', 'ibs-stocks', 'spy-bollinger-rsi-stocks'],
  ['momentum-stocks'],
]

export function strategyFamily(strategyId: string): readonly string[] {
  return STRATEGY_FAMILIES.find(f => f.includes(strategyId)) ?? [strategyId]
}

/**
 * Reversion strategies buy weakness, so a bear Markov regime is their entry,
 * not a veto. The hourly Bitcoin pullback ('mean-reversion-hourly-crypto') is
 * reversion too and keeps the exemption it always had.
 */
export function isMeanReversionFamily(strategyId: string): boolean {
  return strategyFamily('mean-reversion-stocks').includes(strategyId) || strategyId.startsWith('mean-reversion-')
}

/**
 * Strategies the brain Markov pre-gate and the risk-officer Markov veto skip.
 * momentum-vt-crypto: its backtest applies no regime gate, so live must not either.
 */
export function skipsMarkovGate(strategyId: string): boolean {
  return isMeanReversionFamily(strategyId) || strategyId === 'momentum-vt-crypto'
}

/**
 * Binary-entry strategies: the engine score only says how deep the setup is,
 * and the backtest takes every positive score (MIN_SCORE=1e-9). Score
 * thresholds would drop valid entries, so these skip them.
 */
const BINARY_ENTRY_STRATEGIES = new Set(['rsi2-stocks', 'ibs-stocks'])
export function bypassesScoreThreshold(strategyId: string | null | undefined): boolean {
  return strategyId != null && BINARY_ENTRY_STRATEGIES.has(strategyId)
}

/**
 * Floor on the per-period trial Sharpe variance: an annual Sharpe spread of 0.5
 * across trials. Without it a few near-identical trials make the multiple-
 * testing haircut vanish.
 */
export const MIN_TRIAL_SHARPE_VARIANCE = (0.5 / Math.sqrt(TRADING_DAYS_PER_YEAR)) ** 2
/** Fewest recorded family Sharpes from which a fallback variance is estimated. */
export const MIN_VARIANCE_SAMPLES = 3

/** Trials = cohorts ever created in the family + the report's sweep grid points. */
export function familyTrialCount(db: Database.Database, strategyId: string, sweepTrials: number): number {
  const family = strategyFamily(strategyId)
  const cohorts = (db.prepare(`SELECT count(*) AS n FROM trader_evaluation_cohorts
    WHERE strategy_id IN (${family.map(() => '?').join(',')})`).get(...family) as { n: number }).n
  return cohorts + (Number.isFinite(sweepTrials) && sweepTrials > 0 ? sweepTrials : 0)
}

export interface DailyBacktestEvidence {
  /** Annualized daily-portfolio OOS Sharpe (sample sd). */
  sharpe: number
  nDays: number
  skew: number
  /** Non-excess (normal = 3). */
  kurtosis: number
  nTrials: number
  sharpeVariancePerPeriod: number | null
}

/**
 * Daily-portfolio evidence from a recorded report blob (backtest_report_json).
 * Null for v1/v2 evidence: those Sharpes are per-trade and inflated, so they
 * can never feed a DSR check.
 */
export function dailyBacktestEvidence(blob: unknown): DailyBacktestEvidence | null {
  if (!blob || typeof blob !== 'object') return null
  const b = blob as { report_version?: number; n_trials?: number; sharpe_variance_per_period?: number | null; walk_forward?: Record<string, unknown> }
  if (!(Number(b.report_version) >= 3) || !b.walk_forward) return null
  const wf = b.walk_forward
  const num = (v: unknown): number | null => typeof v === 'number' && Number.isFinite(v) ? v : null
  const sharpe = num(wf.oos_sharpe), nDays = num(wf.oos_n_days), skew = num(wf.oos_daily_skew), kurtosis = num(wf.oos_daily_kurtosis)
  if (sharpe == null || nDays == null || skew == null || kurtosis == null) return null
  return { sharpe, nDays, skew, kurtosis, nTrials: num(b.n_trials) ?? 0, sharpeVariancePerPeriod: num(b.sharpe_variance_per_period) }
}

/**
 * DSR of the backtest, the gate's edge check. Trial variance: the sweep's own
 * when it searched more than one point, else the sample variance of at least
 * three family v3 Sharpes; floored at MIN_TRIAL_SHARPE_VARIANCE either way.
 * With several trials and no measured variance it fails closed.
 */
export function backtestDeflatedSharpe(
  db: Database.Database,
  strategyId: string,
  evidence: DailyBacktestEvidence | null,
): { dsr: number; trials: number; variance: number | undefined } {
  if (!evidence) return { dsr: 0, trials: 0, variance: undefined }
  const trials = Math.max(1, familyTrialCount(db, strategyId, evidence.nTrials))
  let variance: number | undefined
  if (evidence.nTrials > 1 && evidence.sharpeVariancePerPeriod != null && evidence.sharpeVariancePerPeriod >= 0) {
    variance = evidence.sharpeVariancePerPeriod
  } else {
    const family = strategyFamily(strategyId)
    const rows = db.prepare(`SELECT backtest_report_json FROM trader_evaluation_cohorts
      WHERE strategy_id IN (${family.map(() => '?').join(',')}) AND backtest_report_json IS NOT NULL`).all(...family) as Array<{ backtest_report_json: string }>
    const perPeriod: number[] = []
    for (const row of rows) {
      let parsed: unknown = null
      try { parsed = JSON.parse(row.backtest_report_json) } catch { /* unreadable evidence is skipped */ }
      const ev = dailyBacktestEvidence(parsed)
      if (ev) perPeriod.push(ev.sharpe / Math.sqrt(TRADING_DAYS_PER_YEAR))
    }
    if (perPeriod.length >= MIN_VARIANCE_SAMPLES) {
      const m = perPeriod.reduce((s, v) => s + v, 0) / perPeriod.length
      variance = perPeriod.reduce((s, v) => s + (v - m) ** 2, 0) / (perPeriod.length - 1)
    }
  }
  if (variance != null) variance = Math.max(variance, MIN_TRIAL_SHARPE_VARIANCE)
  const dsr = deflatedSharpeFromMoments(evidence.sharpe, evidence.nDays, evidence.skew, evidence.kurtosis, trials, variance)
  return { dsr, trials, variance }
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
