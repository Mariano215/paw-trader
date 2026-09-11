/**
 * Broker-truth P&L + enforced go-live gate.
 *
 * Two jobs:
 *  1. computeBrokerTruth: realized round-trips and open MTM computed from
 *     the ENGINE's filled orders and positions (broker truth), never from
 *     the local trader_realized_pnl layer. The local derived layer diverged
 *     from broker truth (2026-06-29 adopted-close batch) and stays
 *     internal-only for verdicts/learning; every human-facing P&L number
 *     must come from here.
 *  2. runGoLiveGate: feeds broker truth into evaluateGate() (validation-gate)
 *     and persists the result. The trader tick enforces it: engine in live
 *     mode while the last gate result is not passed -> trading halted.
 *
 * Regime accumulation: each gate run records the current SPY Markov state
 * into kv_settings, so regimesObserved grows as the paper record spans
 * more market conditions. Honest cold start: 1 regime until the tape changes.
 */
import type Database from 'better-sqlite3'
import type { EngineClient } from './engine-client.js'
import { archiveCumulativeOrderFills, matchLotsFifo, type FillRow, type RealizedLot } from './audit-log.js'
import { evaluateGate, type GateResult } from './validation-gate.js'
import type { EquityPoint } from './metrics.js'
import { logger } from '../logger.js'
import { createHash } from 'node:crypto'
import type { EngineOrder } from './types.js'
import { readCompleteOrderHistory } from './engine-client.js'
import { currentFingerprintMatches, type EvaluationCohortRow } from './evaluation-cohort.js'

export const GATE_KV_KEY = 'trader.gate.last'
export const GATE_REGIMES_KV_KEY = 'trader.gate.regimes_seen'
const GATE_RUN_KV_KEY = 'trader.gate.last_run_ms'
export const GATE_RUN_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000 // weekly
export const GATE_VERSION = 3
export const ACCOUNTING_KV_KEY = 'trader.accounting.last'
export const REQUIRED_GATE_CRITERIA = ['closed_trades', 'market_regimes', 'out_of_sample_no_retune',
  'deflated_sharpe', 'positive_expectancy', 'max_drawdown_kill', 'live_vs_backtest_degradation', 'evaluation_cohort'] as const

export interface BrokerTruth {
  realizedLots: RealizedLot[]
  realizedTotal: number
  openUnrealized: number
  roundTrips: number
  perAsset: Array<{ asset: string; roundTrips: number; realized: number }>
  closedReturns: number[]
  warnings: string[]
}

/** Existing trader_fills rows are cumulative order snapshots, not deltas.
 * Broker IDs bridge legacy rows whose client_order_id was a brain decision ID.
 * Prefer archived execution time and costs when quantities agree.
 */
export function mergeBrokerFills(orders: EngineOrder[], archived: FillRow[]): FillRow[] {
  const merged = new Map<string, FillRow>()
  const keyOf = (f: FillRow): string => f.broker_order_id || f.client_order_id || f.id
  const isRepairFill = (f: Pick<FillRow, 'client_order_id' | 'decision_id'>): boolean =>
    f.client_order_id.startsWith('repair-cover-') || f.decision_id.startsWith('repair-cover-')
  for (const f of archived) {
    // Corrective short covers restore the long-only invariant. They are not
    // strategy entries and must not improve or distort strategy P&L.
    if (isRepairFill(f)) continue
    if (!(Number.isFinite(f.fill_qty) && f.fill_qty > 0 && Number.isFinite(f.fill_price) && f.fill_price > 0)) continue
    const key = keyOf(f)
    const prev = merged.get(key)
    if (!prev || f.fill_qty > prev.fill_qty || (f.fill_qty === prev.fill_qty && f.fee_usd > prev.fee_usd)) merged.set(key, f)
  }
  for (const o of orders) {
    if (o.source === 'auto-repair' || o.client_order_id.startsWith('repair-cover-') ||
        o.decision_id?.startsWith('repair-cover-')) continue
    // A canceled or expired partially-filled order still owns real fills.
    if (!(Number.isFinite(o.filled_qty) && o.filled_qty > 0 && o.filled_avg_price != null &&
        Number.isFinite(o.filled_avg_price) && o.filled_avg_price > 0)) continue
    const key = o.broker_order_id || o.client_order_id
    const prev = merged.get(key)
    if (prev && prev.fill_qty >= o.filled_qty) continue
    merged.set(key, {
      id: key, decision_id: prev?.decision_id ?? o.decision_id ?? o.client_order_id,
      client_order_id: o.client_order_id, broker_order_id: o.broker_order_id,
      asset: o.asset, side: o.side, fill_qty: o.filled_qty, fill_price: o.filled_avg_price,
      intended_price: prev?.intended_price ?? null, intended_ts_ms: prev?.intended_ts_ms ?? null,
      fill_ts_ms: o.updated_at, fee_usd: prev?.fee_usd ?? 0, slippage_usd: prev?.slippage_usd ?? 0,
      entry_thesis: prev?.entry_thesis ?? null, exit_reason: prev?.exit_reason ?? null, recorded_at: o.updated_at,
    })
  }
  return [...merged.values()].sort((a, b) => a.fill_ts_ms - b.fill_ts_ms || a.id.localeCompare(b.id))
}

/**
 * Realized P&L from engine filled orders (FIFO per asset) + open MTM from
 * engine positions. When a DB is supplied, also repairs the cumulative fill
 * archive from complete engine history. Throws when the engine is unreachable
 * so callers never mistake "engine down" for "zero P&L".
 */
export async function computeBrokerTruth(client: EngineClient, db?: Database.Database): Promise<BrokerTruth> {
  // Keep awaits sequential so an incomplete/rolling-deploy client cannot
  // create an unhandled rejected promise while a second missing method throws.
  const orders = await readCompleteOrderHistory(client)
  const positions = await client.getPositions()
  let archived: FillRow[] = []
  if (db) {
    archiveCumulativeOrderFills(db, orders)
    archived = db.prepare('SELECT * FROM trader_fills ORDER BY fill_ts_ms, recorded_at').all() as FillRow[]
  }
  const merged = mergeBrokerFills(orders, archived)
  const byAsset = new Map<string, FillRow[]>()
  for (const f of merged) {
    const rows = byAsset.get(f.asset) ?? []
    rows.push(f)
    byAsset.set(f.asset, rows)
  }

  const realizedLots: RealizedLot[] = []
  const closedReturns: number[] = []
  const perAsset: BrokerTruth['perAsset'] = []
  for (const [asset, fills] of byAsset) {
    fills.sort((a, b) => a.fill_ts_ms - b.fill_ts_ms)
    const lots = matchLotsFifo(fills)
    realizedLots.push(...lots)
    // Count a completed entry once, regardless of how many exit lots match it.
    const entries = new Map<string, { qty: number; basis: number; closed: number; pnl: number }>()
    for (const f of fills.filter(f => f.side === 'buy')) {
      const e = entries.get(f.decision_id) ?? {qty: 0, basis: 0, closed: 0, pnl: 0}
      e.qty += f.fill_qty; e.basis += f.fill_qty * f.fill_price
      entries.set(f.decision_id, e)
    }
    for (const l of lots) {
      const e = entries.get(l.entryDecisionId)
      if (e) { e.closed += l.qty; e.pnl += l.pnlNet }
    }
    const completed = [...entries.values()].filter(e => Math.abs(e.qty - e.closed) <= 1e-8 && e.basis > 0)
    closedReturns.push(...completed.map(e => e.pnl / e.basis))
    if (lots.length > 0) {
      perAsset.push({
        asset,
        roundTrips: completed.length,
        realized: lots.reduce((s, l) => s + l.pnlNet, 0),
      })
    }
  }

  const openUnrealized = positions.reduce(
    (s, p) => s + (Math.abs(p.qty) > 1e-9 ? (p.unrealized_pnl ?? 0) : 0),
    0,
  )
  return {
    realizedLots,
    realizedTotal: realizedLots.reduce((s, l) => s + l.pnlNet, 0),
    openUnrealized,
    roundTrips: closedReturns.length,
    perAsset: perAsset.sort((a, b) => b.realized - a.realized),
    closedReturns,
    warnings: ['Recorded fees only; complete broker fees and estimated paper execution costs are not yet verified.'],
  }
}

/** One producer for dashboard/report accounting; never fabricate zero on outage. */
export async function refreshAccountingSnapshot(db: Database.Database, client: EngineClient, nowMs = Date.now()): Promise<void> {
  const truth = await computeBrokerTruth(client, db)
  writeKv(db, ACCOUNTING_KV_KEY, JSON.stringify({
    available: true, evaluated_at: nowMs, realized_total: truth.realizedTotal,
    open_unrealized: truth.openUnrealized, net: truth.realizedTotal + truth.openUnrealized,
    round_trips: truth.roundTrips,
    per_asset: truth.perAsset.map(p => ({asset: p.asset, round_trips: p.roundTrips, realized: p.realized})),
    warnings: truth.warnings, costs_complete: false,
  }))
}

export function gateConfigFingerprint(db: Database.Database): string {
  const strategies = db.prepare('SELECT id, status, params_json, max_size_usd FROM trader_strategies ORDER BY id').all()
  const cohorts = db.prepare(`SELECT c.id,c.asset_class,c.status,c.config_fingerprint,c.no_retune,
      s.passed,s.evidence_complete
    FROM trader_evaluation_cohorts c
    LEFT JOIN trader_cohort_scorecards s ON s.cohort_id=c.id
    ORDER BY c.id`).all()
  let knobs: unknown = null
  try { knobs = db.prepare("SELECT knobs FROM project_settings WHERE project_id='trader'").get() ?? null } catch { /* fresh standalone DB */ }
  // Explicit allowlist: never include credentials in evaluation fingerprints.
  const env = ['TRADER_SIGNAL_SCORE_THRESHOLD', 'TRADER_COMMITTEE_BYPASS', 'TRADER_DAILY_TRADE_CAP',
    'TRADER_STRATEGY_GATE_ENABLED', 'TRADER_BLIND_SIGNAL_SCORE_THRESHOLD'].map(k => [k, process.env[k] ?? null])
  return createHash('sha256').update(JSON.stringify({version: GATE_VERSION, strategies, cohorts, knobs, env})).digest('hex')
}

export interface CohortReadiness {
  passed: boolean
  detail: string
}

/** Require independently passed, still-frozen stock and Bitcoin cohorts. */
export function readCohortReadiness(db: Database.Database): CohortReadiness {
  try {
    const rows = db.prepare(`SELECT c.*,s.passed AS score_passed,s.evidence_complete
      FROM trader_evaluation_cohorts c
      JOIN trader_cohort_scorecards s ON s.cohort_id=c.id
      WHERE c.status='passed' AND s.passed=1 AND s.evidence_complete=1`).all() as
      Array<EvaluationCohortRow & {score_passed: number; evidence_complete: number}>
    const valid = rows.filter(row => row.no_retune === 1 && row.mode === 'paper' && currentFingerprintMatches(db, row))
    const stocks = valid.some(row => row.asset_class === 'stocks')
    const bitcoin = valid.some(row => row.asset_class === 'crypto' && row.universe_json === '["BTC/USD"]')
    return {
      passed: stocks && bitcoin,
      detail: `stocks=${stocks ? 'passed' : 'blocked'} bitcoin=${bitcoin ? 'passed' : 'blocked'}; both frozen prospective cohorts required`,
    }
  } catch {
    return {passed: false, detail: 'cohort evidence unavailable'}
  }
}

export function gateAuthorizesLive(db: Database.Database, nowMs = Date.now()): boolean {
  const gate = readLastGateResult(db)
  return gate?.passed === true && gate.version === GATE_VERSION &&
    gate.configFingerprint === gateConfigFingerprint(db) && Number.isFinite(gate.evaluatedAt) &&
    nowMs >= gate.evaluatedAt && nowMs - gate.evaluatedAt < GATE_RUN_INTERVAL_MS &&
    Array.isArray(gate.criteria) && REQUIRED_GATE_CRITERIA.every(name => gate.criteria.some(c => c.name === name && c.passed === true)) &&
    gate.criteria.every(c => c.passed === true)
}

function readKv(db: Database.Database, key: string): string | null {
  try {
    const row = db.prepare('SELECT value FROM kv_settings WHERE key = ?').get(key) as
      | { value: string }
      | undefined
    return row?.value ?? null
  } catch {
    return null
  }
}

function writeKv(db: Database.Database, key: string, value: string): void {
  db.prepare('CREATE TABLE IF NOT EXISTS kv_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)').run()
  db.prepare('INSERT OR REPLACE INTO kv_settings (key, value) VALUES (?, ?)').run(key, value)
}

/** Record the current SPY Markov state; return the distinct set seen so far. */
async function accumulateRegimes(db: Database.Database, client: EngineClient): Promise<string[]> {
  const seen = new Set<string>(JSON.parse(readKv(db, GATE_REGIMES_KV_KEY) ?? '[]') as string[])
  try {
    const markov = await client.getMarkovRegime('SPY')
    if (markov?.current_state) seen.add(String(markov.current_state))
  } catch {
    // Regime probe failing never blocks the gate run; the set just does not grow.
  }
  const list = [...seen]
  writeKv(db, GATE_REGIMES_KV_KEY, JSON.stringify(list))
  return list
}

export interface StoredGateResult {
  version?: number
  configFingerprint?: string
  /**
   * Snapshot of the backtest that produced backtestSharpe, or null when it was
   * unreachable. Persisted so the weekly report and the pipeline watchdog can
   * show WHY the degradation criterion passed or blocked without re-running a
   * two-minute simulation.
   */
  backtest?: {
    sharpe: number | null
    n_trades: number
    max_drawdown: number | null
    win_rate: number | null
    start: string
    end: string
    min_score: number
    warnings: string[]
  } | null
  passed: boolean
  criteria: GateResult['criteria']
  warnings: string[]
  roundTrips: number
  realizedTotal: number
  openUnrealized: number
  evaluatedAt: number
}

export function readLastGateResult(db: Database.Database): StoredGateResult | null {
  const raw = readKv(db, GATE_KV_KEY)
  if (!raw) return null
  try {
    return JSON.parse(raw) as StoredGateResult
  } catch {
    return null
  }
}

/**
 * Evaluate the pre-live gate against broker truth and persist the result.
 * The tick-level live-mode guard reads the persisted result, so the gate
 * stays enforced even across bot restarts.
 */
export async function runGoLiveGate(
  db: Database.Database,
  client: EngineClient,
  nowMs: number = Date.now(),
): Promise<StoredGateResult> {
  const truth = await computeBrokerTruth(client, db)
  const regimes = await accumulateRegimes(db, client)
  const cohortReadiness = readCohortReadiness(db)

  // Per-trade fractional net returns on cost basis.
  const closedReturns = truth.closedReturns

  // Paper equity curve from engine NAV snapshots (account truth).
  let equityCurve: EquityPoint[] = []
  try {
    const snaps = await client.getNavSnapshots(365)
    equityCurve = snaps
      .map((s) => ({ ts_ms: s.recorded_at, equity: s.nav }))
      .sort((a, b) => a.ts_ms - b.ts_ms)
  } catch {
    logger.warn('Go-live gate: NAV snapshots unavailable; drawdown criterion blocked')
  }

  // Every strategy ever tried counts as a trial, not just the ones still
  // running. deflatedSharpe penalises the observed Sharpe by how many variants
  // we searched over, so filtering to status='active' hid exactly the variants
  // that make the penalty necessary: the ones tested and then paused or retired
  // because they underperformed. Excluding them undercounts trials and inflates
  // the deflated Sharpe, which biases the gate toward passing.
  //
  // Counting all rows still understates the true search: params tuned in place
  // on one strategy row leave no trace here. Under-counting is the direction we
  // can live with; under-counting AND discarding the failures is not.
  const variantsTested = (db.prepare("SELECT count(*) c FROM trader_strategies").get() as { c: number }).c

  // backtestSharpe from the engine's trade-level simulator, which imports the
  // production _momentum_score directly so the backtested rule cannot drift
  // from the traded one.
  //
  // This used to be a hardcoded 0. Because evaluateGate ANDs every criterion
  // and live_vs_backtest_degradation returns false for any non-positive
  // backtest Sharpe, that single constant made the gate incapable of passing
  // no matter how the strategy performed. It was described as an honest
  // blocker, and it was, but it also meant nobody could tell a blocked gate
  // from a failing strategy.
  //
  // On failure we fall back to 0, which restores the old permanent block. That
  // is the correct direction to fail: an unreachable backtest must never be
  // read as a passing one.
  let backtestSharpe = 0
  let backtest: Awaited<ReturnType<typeof client.getMomentumBacktest>> | null = null
  try {
    backtest = await client.getMomentumBacktest()
    // null sharpe means fewer than two closed trades, i.e. no answer. Leaving
    // it at 0 keeps the gate blocked rather than inventing a verdict.
    if (backtest.sharpe != null && Number.isFinite(backtest.sharpe)) {
      backtestSharpe = backtest.sharpe
    } else {
      logger.warn(
        { nTrades: backtest.n_trades, warnings: backtest.warnings },
        'Go-live gate: backtest returned no Sharpe (too few trades), degradation criterion stays blocked',
      )
    }
  } catch (err) {
    logger.warn({ err }, 'Go-live gate: backtest unavailable, degradation criterion stays blocked')
  }

  const result = evaluateGate({
    closedReturns,
    equityCurve,
    regimesObserved: regimes.length,
    variantsTested: Math.max(1, variantsTested),
    outOfSampleNoRetune: cohortReadiness.passed,
    backtestSharpe,
    liveReconReturns: closedReturns,
  })
  result.criteria.push({name: 'evaluation_cohort', passed: cohortReadiness.passed,
    detail: cohortReadiness.detail})
  result.passed = result.criteria.every(c => c.passed)
  result.warnings.push(...truth.warnings, 'Trade-return scores use per-trade observations; they are not annualized daily portfolio Sharpe ratios.')

  const stored: StoredGateResult = {
    version: GATE_VERSION,
    configFingerprint: gateConfigFingerprint(db),
    backtest: backtest && {
      sharpe: backtest.sharpe,
      n_trades: backtest.n_trades,
      max_drawdown: backtest.max_drawdown,
      win_rate: backtest.win_rate,
      start: backtest.start,
      end: backtest.end,
      min_score: backtest.min_score,
      warnings: backtest.warnings,
    },
    passed: result.passed,
    criteria: result.criteria,
    warnings: result.warnings,
    roundTrips: truth.roundTrips,
    realizedTotal: truth.realizedTotal,
    openUnrealized: truth.openUnrealized,
    evaluatedAt: nowMs,
  }
  writeKv(db, GATE_KV_KEY, JSON.stringify(stored))
  writeKv(db, GATE_RUN_KV_KEY, String(nowMs))
  return stored
}

export function gateRunDue(db: Database.Database, nowMs: number): boolean {
  const gate = readLastGateResult(db)
  if (gate?.version !== GATE_VERSION || gate.configFingerprint !== gateConfigFingerprint(db)) return true
  const last = Number(readKv(db, GATE_RUN_KV_KEY) ?? 0)
  return nowMs - last >= GATE_RUN_INTERVAL_MS
}

const money = (n: number): string => `${n < 0 ? '-' : ''}$${Math.abs(n).toFixed(2)}`

/** Plain-English gate + broker-truth P&L summary for the digest. */
export function renderGateSummary(r: StoredGateResult): string {
  const passedCount = r.criteria.filter((c) => c.passed).length
  const blockers = r.criteria.filter((c) => !c.passed).map((c) => c.name)
  const lines = [
    `Go-live gate: ${r.passed ? 'PASSED' : `${passedCount}/${r.criteria.length} criteria`} (${r.roundTrips} closed round-trips)`,
    `P&L (broker truth): realized ${money(r.realizedTotal)}, open ${money(r.openUnrealized)}, net ${money(r.realizedTotal + r.openUnrealized)}`,
  ]
  if (!r.passed) lines.push(`Blockers: ${blockers.join(', ')}`)
  return lines.join('\n')
}
