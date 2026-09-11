import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import { matchLotsFifo, type FillRow } from './audit-log.js'
import { deflatedSharpe, maxDrawdown, sharpe, tradeStats, TRADING_DAYS_PER_YEAR } from './metrics.js'
import { canonicalJson, currentFingerprintMatches, type EvaluationCohortRow } from './evaluation-cohort.js'
import { recordTraderOperationalEvent } from './operational-events.js'

export const COHORT_MAX_FAILURE_RATE = 0.15
export const COHORT_RECONCILE_MAX_AGE_MS = 10 * 60 * 1000
export const COHORT_NAV_MAX_AGE_MS = 36 * 60 * 60 * 1000

export interface CohortOperationalEvidence {
  engineMode: string | null
  brokerConnected: boolean | null
  coinbaseConnected: boolean | null
  cryptoEnabled: boolean | null
  reconcilerHalted: boolean | null
  reconcileDriftDetected: boolean | null
  reconcileRanAt: number | null
  nav: number | null
  navRecordedAt: number | null
}

export interface CohortCriterion {
  name: string
  passed: boolean
  detail: string
}

export interface CohortScorecard {
  cohortId: string
  strategyId: string
  status: string
  tradeCount: number
  winCount: number
  netPnlUsd: number
  expectancy: number
  sharpe: number
  deflatedSharpe: number
  maxDrawdownPct: number
  benchmarkReturn: number | null
  excessReturn: number | null
  failureRate: number
  regimes: string[]
  evidenceComplete: boolean
  passed: boolean
  criteria: CohortCriterion[]
  computedAt: number
}

interface CompletedTrade {
  entryDecisionId: string
  exitTsMs: number
  netPnlUsd: number
  netReturn: number
}

function cohortFills(db: Database.Database, cohortId: string): FillRow[] {
  return db.prepare(`SELECT f.* FROM trader_fills f
    JOIN trader_decisions d ON d.id=f.decision_id
    WHERE d.cohort_id=?
    ORDER BY f.fill_ts_ms,f.recorded_at,f.id`).all(cohortId) as FillRow[]
}

function completedTrades(fills: FillRow[], cohort: EvaluationCohortRow): CompletedTrade[] {
  const lots = matchLotsFifo(fills)
  const boughtQty = new Map<string, number>()
  for (const fill of fills) {
    if (fill.side === 'buy') boughtQty.set(fill.decision_id, (boughtQty.get(fill.decision_id) ?? 0) + fill.fill_qty)
  }
  const grouped = new Map<string, {matchedQty: number; entryNotional: number; exitNotional: number; gross: number; actualFees: number; exitTsMs: number}>()
  for (const lot of lots) {
    const current = grouped.get(lot.entryDecisionId) ?? {matchedQty: 0, entryNotional: 0, exitNotional: 0, gross: 0, actualFees: 0, exitTsMs: 0}
    current.matchedQty += lot.qty
    current.entryNotional += lot.qty * lot.entryPrice
    current.exitNotional += lot.qty * lot.exitPrice
    current.gross += lot.pnlGross
    current.actualFees += lot.feesUsd
    current.exitTsMs = Math.max(current.exitTsMs, lot.exitTsMs)
    grouped.set(lot.entryDecisionId, current)
  }
  const result: CompletedTrade[] = []
  for (const [entryDecisionId, trade] of grouped) {
    const totalBought = boughtQty.get(entryDecisionId) ?? 0
    if (totalBought <= 0 || Math.abs(totalBought - trade.matchedQty) > 1e-8 || trade.entryNotional <= 0) continue
    const bothLegNotional = trade.entryNotional + trade.exitNotional
    const modeledFees = bothLegNotional * cohort.fee_bps_per_side / 10_000
    const modeledSlippage = bothLegNotional * cohort.slippage_bps_per_side / 10_000
    const net = trade.gross - Math.max(trade.actualFees, modeledFees) - modeledSlippage
    result.push({entryDecisionId, exitTsMs: trade.exitTsMs, netPnlUsd: net, netReturn: net / trade.entryNotional})
  }
  return result.sort((a, b) => a.exitTsMs - b.exitTsMs || a.entryDecisionId.localeCompare(b.entryDecisionId))
}

function readRegimes(db: Database.Database, cohortId: string, trades: CompletedTrade[]): string[] {
  const completedEntries = new Set(trades.map(trade => trade.entryDecisionId))
  const rows = db.prepare(`SELECT d.id,s.enrichment_json FROM trader_decisions d
    JOIN trader_signals s ON s.id=d.signal_id
    WHERE d.cohort_id=? AND d.parent_decision_id IS NULL`).all(cohortId) as Array<{id: string; enrichment_json: string | null}>
  const regimes = new Set<string>()
  for (const row of rows) {
    if (!completedEntries.has(row.id)) continue
    if (!row.enrichment_json) continue
    try {
      const e = JSON.parse(row.enrichment_json) as Record<string, unknown>
      const m = e.markov_regime as Record<string, unknown> | undefined
      const candidate = m?.current_state ?? m?.regime ?? e.regime
      if (typeof candidate === 'string' && candidate.trim()) regimes.add(candidate)
    } catch { /* malformed evidence stays absent */ }
  }
  return [...regimes].sort()
}

function benchmarkEvidence(db: Database.Database, cohortId: string, trades: CompletedTrade[]): {value: number | null; complete: boolean} {
  if (trades.length === 0) return {value: null, complete: false}
  const rows = db.prepare(`SELECT d.id,v.bench_return FROM trader_decisions d
    JOIN trader_verdicts v ON v.decision_id=d.id
    WHERE d.cohort_id=? AND v.excluded_at IS NULL`).all(cohortId) as Array<{id: string; bench_return: number}>
  const byDecision = new Map(rows.filter(r => Number.isFinite(r.bench_return)).map(r => [r.id, r.bench_return]))
  const values = trades.map(t => byDecision.get(t.entryDecisionId)).filter((v): v is number => v != null)
  return {value: values.length === trades.length ? values.reduce((growth, value) => growth * (1 + value), 1) - 1 : null, complete: values.length === trades.length}
}

export function evaluateCohort(
  db: Database.Database,
  cohortId: string,
  nowMs = Date.now(),
  operations?: CohortOperationalEvidence,
): CohortScorecard {
  const cohort = db.prepare('SELECT * FROM trader_evaluation_cohorts WHERE id=?').get(cohortId) as EvaluationCohortRow | undefined
  if (!cohort) throw new Error('cohort not found')
  const fills = cohortFills(db, cohortId)
  const trades = completedTrades(fills, cohort)
  const returns = trades.map(t => t.netReturn)
  const stats = tradeStats(returns)
  const observedSharpe = sharpe(returns)
  const variantRows = db.prepare(`SELECT c.id,s.sharpe FROM trader_evaluation_cohorts c
    LEFT JOIN trader_cohort_scorecards s ON s.cohort_id=c.id
    WHERE c.strategy_id=? ORDER BY c.created_at,c.id`).all(cohort.strategy_id) as Array<{id:string; sharpe:number|null}>
  const trialSharpes = variantRows.map(row => row.id === cohort.id ? observedSharpe : row.sharpe)
  const completeTrialEvidence = trialSharpes.every((value): value is number => value != null && Number.isFinite(value))
  let trialVariance: number | undefined
  if (variantRows.length > 1 && completeTrialEvidence) {
    const perPeriod = trialSharpes.map(value => value / Math.sqrt(TRADING_DAYS_PER_YEAR))
    const mean = perPeriod.reduce((sum, value) => sum + value, 0) / perPeriod.length
    trialVariance = perPeriod.reduce((sum, value) => sum + (value - mean) ** 2, 0) / perPeriod.length
  }
  // A second tuned variant cannot pass until every searched variant has a
  // measured Sharpe; then DSR uses their observed cross-trial variance.
  const dsr = deflatedSharpe(observedSharpe, returns, Math.max(1, variantRows.length), trialVariance)
  const equity = [{ts_ms: cohort.started_at ?? cohort.created_at, equity: 1}]
  let cumulative = 1
  for (const trade of trades) {
    cumulative *= Math.max(0.000001, 1 + trade.netReturn)
    equity.push({ts_ms: trade.exitTsMs, equity: cumulative})
  }
  const drawdown = maxDrawdown(equity).maxDrawdown
  const regimes = readRegimes(db, cohortId, trades)
  const benchmark = benchmarkEvidence(db, cohortId, trades)
  const netPnl = trades.reduce((sum, t) => sum + t.netPnlUsd, 0)
  const strategyReturn = returns.reduce((growth, r) => growth * (1 + r), 1) - 1
  const excessReturn = benchmark.value == null ? null : strategyReturn - benchmark.value

  const statusRows = db.prepare(`SELECT status,count(*) AS n FROM trader_decisions
    WHERE cohort_id=? AND parent_decision_id IS NULL GROUP BY status`).all(cohortId) as Array<{status: string; n: number}>
  const counts = new Map(statusRows.map(r => [r.status, r.n]))
  const failed = counts.get('failed') ?? 0
  const attempted = [...counts.entries()].filter(([status]) => !['committee_abstain'].includes(status))
    .reduce((sum, [, n]) => sum + n, 0)
  const failureRate = attempted > 0 ? failed / attempted : 0
  const unresolved = [...counts.entries()].filter(([status]) =>
    ['submitting','submitted','pending_fill','retry_pending','engine_down','unknown','exit_unknown'].includes(status))
    .reduce((sum, [, n]) => sum + n, 0)
  const ungraded = (db.prepare('SELECT count(*) AS n FROM trader_decisions WHERE cohort_id=? AND ungraded_at IS NOT NULL')
    .get(cohortId) as {n: number}).n
  const openQty = new Map<string, number>()
  for (const fill of fills) openQty.set(fill.asset, (openQty.get(fill.asset) ?? 0) + (fill.side === 'buy' ? fill.fill_qty : -fill.fill_qty))
  const openAssets = [...openQty.values()].filter(q => Math.abs(q) > 1e-8).length
  const configCurrent = currentFingerprintMatches(db, cohort)
  const backtestReady = cohort.backtest_sharpe != null && Number.isFinite(cohort.backtest_sharpe) && cohort.backtest_sharpe > 0 &&
    cohort.backtest_trade_count != null && cohort.backtest_trade_count >= cohort.min_closed_trades &&
    cohort.backtest_max_drawdown_pct != null && cohort.backtest_max_drawdown_pct <= cohort.max_drawdown_pct &&
    cohort.backtest_fingerprint === cohort.config_fingerprint && cohort.backtest_evaluated_at != null && cohort.backtest_evaluated_at >= cohort.created_at
  const backtestRatio = backtestReady ? observedSharpe / cohort.backtest_sharpe! : null
  const reconcileFresh = operations?.reconcileRanAt != null && Number.isFinite(operations.reconcileRanAt) &&
    operations.reconcileRanAt <= nowMs && nowMs - operations.reconcileRanAt < COHORT_RECONCILE_MAX_AGE_MS
  const navFresh = operations?.navRecordedAt != null && Number.isFinite(operations.navRecordedAt) &&
    operations.navRecordedAt <= nowMs && nowMs - operations.navRecordedAt < COHORT_NAV_MAX_AGE_MS &&
    operations.nav != null && Number.isFinite(operations.nav) && operations.nav > 0
  const dataVenueConnected = cohort.asset_class === 'crypto'
    ? operations?.coinbaseConnected === true && operations.cryptoEnabled === true
    : operations?.brokerConnected === true
  const operationalEvidenceCurrent = operations?.engineMode === 'paper' && operations.brokerConnected === true &&
    dataVenueConnected && operations.reconcilerHalted === false && operations.reconcileDriftDetected === false &&
    reconcileFresh && navFresh
  const evidenceComplete = configCurrent && benchmark.complete && unresolved === 0 && ungraded === 0 && openAssets === 0 &&
    backtestReady && operationalEvidenceCurrent

  const criteria: CohortCriterion[] = [
    {name: 'frozen_config', passed: configCurrent, detail: configCurrent ? 'runtime matches frozen fingerprint' : 'runtime/config differs from cohort'},
    {name: 'paper_mode', passed: cohort.mode === 'paper', detail: `execution mode ${cohort.mode}`},
    {name: 'closed_trades', passed: trades.length >= cohort.min_closed_trades, detail: `${trades.length}/${cohort.min_closed_trades} completed round trips`},
    {name: 'trade_linked_regimes', passed: regimes.length >= cohort.min_regimes, detail: `${regimes.length}/${cohort.min_regimes} regimes`},
    {name: 'no_retune', passed: cohort.no_retune === 1, detail: cohort.no_retune === 1 ? 'frozen prospective window' : 'retuning invalidated the window'},
    {name: 'deflated_sharpe', passed: dsr >= cohort.min_deflated_sharpe, detail: `${dsr.toFixed(4)} vs ${cohort.min_deflated_sharpe.toFixed(2)}`},
    {name: 'positive_expectancy', passed: stats.expectancy > 0, detail: `${stats.expectancy.toFixed(6)} net per trade`},
    {name: 'max_drawdown', passed: drawdown <= cohort.max_drawdown_pct, detail: `${(drawdown * 100).toFixed(2)}% vs ${(cohort.max_drawdown_pct * 100).toFixed(0)}% ceiling`},
    {name: 'matched_backtest', passed: backtestReady, detail: backtestReady ? `Sharpe ${cohort.backtest_sharpe!.toFixed(3)}, ${cohort.backtest_trade_count} trades, ${(cohort.backtest_max_drawdown_pct! * 100).toFixed(2)}% max drawdown` : 'missing qualified current config-bound backtest'},
    {name: 'paper_backtest_ratio', passed: backtestRatio != null && backtestRatio >= cohort.min_backtest_ratio, detail: backtestRatio == null ? 'unavailable' : `${backtestRatio.toFixed(3)} vs ${cohort.min_backtest_ratio.toFixed(2)}`},
    {name: 'execution_failures', passed: attempted > 0 && failureRate < COHORT_MAX_FAILURE_RATE, detail: `${(failureRate * 100).toFixed(1)}% vs ${(COHORT_MAX_FAILURE_RATE * 100).toFixed(0)}% ceiling`},
    {name: 'broker_evidence_current', passed: operationalEvidenceCurrent,
      detail: `paper=${operations?.engineMode === 'paper'} broker=${operations?.brokerConnected === true} data=${dataVenueConnected} reconcile=${reconcileFresh && operations?.reconcileDriftDetected === false && operations?.reconcilerHalted === false} nav=${navFresh}`},
    {name: 'complete_evidence', passed: evidenceComplete, detail: `benchmark=${benchmark.complete} unresolved=${unresolved} ungraded=${ungraded} open_assets=${openAssets}`},
    {name: 'positive_net_pnl', passed: netPnl > 0, detail: `$${netPnl.toFixed(2)} after modeled costs`},
    {name: 'beats_benchmark', passed: excessReturn != null && excessReturn > 0, detail: excessReturn == null ? 'benchmark unavailable' : `${(excessReturn * 100).toFixed(2)}% excess`},
  ]
  return {
    cohortId, strategyId: cohort.strategy_id, status: cohort.status,
    tradeCount: trades.length, winCount: trades.filter(t => t.netPnlUsd > 0).length,
    netPnlUsd: netPnl, expectancy: stats.expectancy, sharpe: observedSharpe,
    deflatedSharpe: dsr, maxDrawdownPct: drawdown, benchmarkReturn: benchmark.value,
    excessReturn, failureRate, regimes, evidenceComplete,
    passed: criteria.every(c => c.passed), criteria, computedAt: nowMs,
  }
}

export function refreshCohortScorecards(
  db: Database.Database,
  nowMs = Date.now(),
  operations?: CohortOperationalEvidence,
): CohortScorecard[] {
  const ids = db.prepare("SELECT id FROM trader_evaluation_cohorts WHERE status IN ('running','closed','passed') ORDER BY id")
    .all() as Array<{id: string}>
  const results = ids.map(({id}) => evaluateCohort(db, id, nowMs, operations))
  const save = db.transaction(() => {
    const upsert = db.prepare(`INSERT INTO trader_cohort_scorecards
      (cohort_id,trade_count,win_count,net_pnl_usd,expectancy,sharpe,deflated_sharpe,max_drawdown_pct,
       benchmark_return,excess_return,failure_rate,regimes_json,evidence_complete,passed,criteria_json,computed_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(cohort_id) DO UPDATE SET
       trade_count=excluded.trade_count,win_count=excluded.win_count,net_pnl_usd=excluded.net_pnl_usd,
       expectancy=excluded.expectancy,sharpe=excluded.sharpe,deflated_sharpe=excluded.deflated_sharpe,
       max_drawdown_pct=excluded.max_drawdown_pct,benchmark_return=excluded.benchmark_return,
       excess_return=excluded.excess_return,failure_rate=excluded.failure_rate,regimes_json=excluded.regimes_json,
       evidence_complete=excluded.evidence_complete,passed=excluded.passed,criteria_json=excluded.criteria_json,
       computed_at=excluded.computed_at`)
    for (const score of results) {
      upsert.run(score.cohortId,score.tradeCount,score.winCount,score.netPnlUsd,score.expectancy,score.sharpe,
        score.deflatedSharpe,score.maxDrawdownPct,score.benchmarkReturn,score.excessReturn,score.failureRate,
        canonicalJson(score.regimes),score.evidenceComplete ? 1 : 0,score.passed ? 1 : 0,
        canonicalJson(score.criteria),score.computedAt)
      if (score.passed && score.status === 'running') {
        const cohort = db.prepare('SELECT strategy_id FROM trader_evaluation_cohorts WHERE id=?').get(score.cohortId) as {strategy_id: string}
        db.prepare("UPDATE trader_evaluation_cohorts SET status='passed',ended_at=? WHERE id=? AND status='running'").run(nowMs,score.cohortId)
        db.prepare("UPDATE trader_strategies SET status='paused',updated_at=? WHERE id=?").run(nowMs,cohort.strategy_id)
        const cohortEventId = randomUUID()
        db.prepare(`INSERT INTO trader_cohort_events (id,cohort_id,event_type,detail_json,actor,created_at)
          VALUES (?,?, 'passed', ?, 'system', ?)`).run(cohortEventId,score.cohortId,canonicalJson({scorecardComputedAt: nowMs}),nowMs)
        recordTraderOperationalEvent(db, {
          eventId: `cohort:${cohortEventId}`,
          sourceTs: nowMs,
          source: 'brain.cohort-scorecard',
          stage: 'cohort',
          eventType: 'cohort.lifecycle.passed',
          state: 'completed',
          strategyId: cohort.strategy_id,
          cohortId: score.cohortId,
          metadata: { trade_count: score.tradeCount, passed: true },
        })
      }
    }
  })
  save()
  return results
}
