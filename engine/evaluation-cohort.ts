import { createHash, randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import {
  TRADER_BLIND_SIGNAL_SCORE_THRESHOLD,
  TRADER_COMMITTEE_BYPASS,
  TRADER_SIGNAL_SCORE_THRESHOLD,
  TRADER_STRATEGY_GATE_ENABLED,
} from '../config.js'
import { startOfNyDayMs } from './bypass-counter.js'
import { recordTraderOperationalEvent, type TraderOperationalState } from './operational-events.js'

export const COHORT_ENFORCEMENT_KV_KEY = 'trader.cohorts.enforced'
export const COHORT_CONFIG_VERSION = 1
export const STOCK_PAPER_MAX_POSITION_USD = 500
export const CRYPTO_PAPER_MAX_POSITION_USD = 200
export const PAPER_MAX_DAILY_TRADES = 5

export type CohortAssetClass = 'stocks' | 'crypto'
export type CohortStatus = 'draft' | 'running' | 'closed' | 'invalidated' | 'passed'

export interface CohortConfig {
  version: number
  strategy: { id: string; assetClass: CohortAssetClass; params: unknown }
  universe: string[]
  venues: { data: string; execution: string; mode: 'paper' }
  costs: { feeBpsPerSide: number; slippageBpsPerSide: number }
  limits: { maxPositionUsd: number; dailyTradeCap: number }
  evidence: {
    benchmarkAsset: string
    minClosedTrades: number
    minRegimes: number
    maxDrawdownPct: number
    minDeflatedSharpe: number
    minBacktestRatio: number
  }
  revisions: { claudepaw: string; engine: string }
  runtime: {
    committeeBypass: boolean
    signalScoreThreshold: number
    blindSignalScoreThreshold: number
    strategyGateEnabled: boolean
  }
}

export interface EvaluationCohortRow {
  id: string
  strategy_id: string
  asset_class: CohortAssetClass
  status: CohortStatus
  config_json: string
  config_fingerprint: string
  universe_json: string
  data_venue: string
  execution_venue: string
  mode: 'paper' | 'live'
  fee_bps_per_side: number
  slippage_bps_per_side: number
  benchmark_asset: string
  max_position_usd: number
  daily_trade_cap: number
  min_closed_trades: number
  min_regimes: number
  max_drawdown_pct: number
  min_deflated_sharpe: number
  min_backtest_ratio: number
  claudepaw_revision: string
  engine_revision: string
  backtest_sharpe: number | null
  backtest_trade_count: number | null
  backtest_max_drawdown_pct: number | null
  backtest_fingerprint: string | null
  backtest_evaluated_at: number | null
  backtest_report_json: string | null
  no_retune: number
  legacy_quarantined_at: number | null
  created_at: number
  started_at: number | null
  ended_at: number | null
  invalidated_at: number | null
  invalidation_reason: string | null
}

export interface CreateCohortInput {
  id: string
  strategyId: string
  assetClass: CohortAssetClass
  universe: string[]
  dataVenue: string
  executionVenue: string
  feeBpsPerSide: number
  slippageBpsPerSide: number
  benchmarkAsset: string
  maxPositionUsd: number
  dailyTradeCap?: number
  claudepawRevision: string
  engineRevision: string
}

export interface CohortPreflight {
  engineMode: string | null
  brokerConnected: boolean | null
  dataVenueConnected: boolean | null
  assetClassEnabled: boolean | null
  reconcilerHalted: boolean | null
  reconcileDriftDetected: boolean | null
  reconcileFresh: boolean
  ordersAvailable: boolean
  positionsAvailable: boolean
  openOrderCount: number
  conflictingPositionCount: number
  unknownOrderCount: number
  unexpectedShortCount: number
  quarantineLegacyPositions: boolean
}

export interface CohortGuardResult {
  ok: boolean
  cohort: EvaluationCohortRow | null
  reason: string | null
  /** Ledger label for a block. 'outside_cohort_universe' means a cohort IS running; the engine scored an asset it does not cover. */
  suppression: 'no_running_cohort' | 'outside_cohort_universe' | null
}

const ID_PATTERN = /^[a-z0-9][a-z0-9._:-]{0,127}$/
const VENUE_PATTERN = /^[a-z][a-z0-9_-]{1,31}$/
const SYMBOL_PATTERN = /^[A-Z0-9.\-]+(?:\/[A-Z0-9]+)?$/

function finiteInRange(value: number, min: number, max: number, name: string): number {
  if (!Number.isFinite(value) || value < min || value > max) throw new Error(`${name} out of range`)
  return value
}

/** Deterministic JSON, including nested objects, for stable fingerprints. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  const row = value as Record<string, unknown>
  return `{${Object.keys(row).sort().map(k => `${JSON.stringify(k)}:${canonicalJson(row[k])}`).join(',')}}`
}

export function cohortFingerprint(config: CohortConfig): string {
  return createHash('sha256').update(canonicalJson(config)).digest('hex')
}

function parseStrategyParams(raw: string): unknown {
  try { return JSON.parse(raw) as unknown } catch { throw new Error('strategy params_json is invalid') }
}

function runtimePolicy(): CohortConfig['runtime'] {
  return {
    committeeBypass: TRADER_COMMITTEE_BYPASS,
    signalScoreThreshold: TRADER_SIGNAL_SCORE_THRESHOLD,
    blindSignalScoreThreshold: TRADER_BLIND_SIGNAL_SCORE_THRESHOLD,
    strategyGateEnabled: TRADER_STRATEGY_GATE_ENABLED,
  }
}

function validateInput(input: CreateCohortInput): void {
  if (!ID_PATTERN.test(input.id) || !ID_PATTERN.test(input.strategyId)) throw new Error('invalid cohort or strategy id')
  if (!VENUE_PATTERN.test(input.dataVenue) || !VENUE_PATTERN.test(input.executionVenue)) throw new Error('invalid venue')
  if (!Array.isArray(input.universe) || input.universe.length < 1 || input.universe.length > 50 ||
      input.universe.some(s => !SYMBOL_PATTERN.test(s))) throw new Error('invalid universe')
  if (!SYMBOL_PATTERN.test(input.benchmarkAsset)) throw new Error('invalid benchmark asset')
  finiteInRange(input.feeBpsPerSide, 0, 100, 'feeBpsPerSide')
  finiteInRange(input.slippageBpsPerSide, 0, 100, 'slippageBpsPerSide')
  const maxAllowed = input.assetClass === 'stocks' ? STOCK_PAPER_MAX_POSITION_USD : CRYPTO_PAPER_MAX_POSITION_USD
  finiteInRange(input.maxPositionUsd, 1, maxAllowed, 'maxPositionUsd')
  finiteInRange(input.dailyTradeCap ?? PAPER_MAX_DAILY_TRADES, 1, PAPER_MAX_DAILY_TRADES, 'dailyTradeCap')
  if (!/^[0-9a-f]{7,40}$/i.test(input.claudepawRevision) || !/^[0-9a-f]{7,40}$/i.test(input.engineRevision)) {
    throw new Error('invalid code revision')
  }
  if (input.assetClass === 'crypto' && (input.universe.length !== 1 || input.universe[0] !== 'BTC/USD')) {
    throw new Error('Bitcoin cohort universe must be exactly BTC/USD')
  }
}

function readStrategy(db: Database.Database, strategyId: string): {id: string; asset_class: string; params_json: string; max_size_usd: number | null} {
  const row = db.prepare('SELECT id,asset_class,params_json,max_size_usd FROM trader_strategies WHERE id=?').get(strategyId) as
    {id: string; asset_class: string; params_json: string; max_size_usd: number | null} | undefined
  if (!row) throw new Error('strategy not found')
  return row
}

function buildConfig(strategy: ReturnType<typeof readStrategy>, input: CreateCohortInput): CohortConfig {
  if (strategy.asset_class !== input.assetClass) throw new Error('strategy asset class mismatch')
  const dailyTradeCap = input.dailyTradeCap ?? PAPER_MAX_DAILY_TRADES
  return {
    version: COHORT_CONFIG_VERSION,
    strategy: {id: strategy.id, assetClass: input.assetClass, params: parseStrategyParams(strategy.params_json)},
    universe: [...input.universe],
    venues: {data: input.dataVenue, execution: input.executionVenue, mode: 'paper'},
    costs: {feeBpsPerSide: input.feeBpsPerSide, slippageBpsPerSide: input.slippageBpsPerSide},
    limits: {maxPositionUsd: input.maxPositionUsd, dailyTradeCap},
    evidence: {
      benchmarkAsset: input.benchmarkAsset,
      minClosedTrades: 100,
      minRegimes: 2,
      maxDrawdownPct: 0.20,
      minDeflatedSharpe: 0.95,
      minBacktestRatio: 0.50,
    },
    revisions: {claudepaw: input.claudepawRevision, engine: input.engineRevision},
    runtime: runtimePolicy(),
  }
}

function event(db: Database.Database, cohortId: string, eventType: string, actor: string, detail: unknown, nowMs: number): void {
  const cohortEventId = randomUUID()
  db.prepare(`INSERT INTO trader_cohort_events (id,cohort_id,event_type,detail_json,actor,created_at)
    VALUES (?,?,?,?,?,?)`).run(cohortEventId, cohortId, eventType, canonicalJson(detail), actor, nowMs)
  const state: TraderOperationalState = eventType === 'invalidated'
    ? 'blocked'
    : eventType === 'activated' ? 'started' : 'completed'
  recordTraderOperationalEvent(db, {
    eventId: `cohort:${cohortEventId}`,
    sourceTs: nowMs,
    source: 'brain.cohort-manager',
    stage: 'cohort',
    eventType: `cohort.lifecycle.${eventType}`,
    state,
    cohortId,
  })
}

export function createDraftCohort(db: Database.Database, input: CreateCohortInput, actor = 'system', nowMs = Date.now()): EvaluationCohortRow {
  validateInput(input)
  const strategy = readStrategy(db, input.strategyId)
  const config = buildConfig(strategy, input)
  const fingerprint = cohortFingerprint(config)
  const insert = db.transaction(() => {
    db.prepare(`INSERT INTO trader_evaluation_cohorts
      (id,strategy_id,asset_class,status,config_json,config_fingerprint,universe_json,data_venue,execution_venue,mode,
       fee_bps_per_side,slippage_bps_per_side,benchmark_asset,max_position_usd,daily_trade_cap,min_closed_trades,
       min_regimes,max_drawdown_pct,min_deflated_sharpe,min_backtest_ratio,claudepaw_revision,engine_revision,no_retune,created_at)
      VALUES (?,?,?,'draft',?,?,?,?,?,'paper',?,?,?,?,?,100,2,0.20,0.95,0.50,?,?,1,?)`)
      .run(input.id, input.strategyId, input.assetClass, canonicalJson(config), fingerprint,
        canonicalJson(input.universe), input.dataVenue, input.executionVenue, input.feeBpsPerSide,
        input.slippageBpsPerSide, input.benchmarkAsset, input.maxPositionUsd,
        input.dailyTradeCap ?? PAPER_MAX_DAILY_TRADES, input.claudepawRevision, input.engineRevision, nowMs)
    event(db, input.id, 'created', actor, {fingerprint}, nowMs)
  })
  insert()
  return getCohort(db, input.id)!
}

export function getCohort(db: Database.Database, cohortId: string): EvaluationCohortRow | null {
  return (db.prepare('SELECT * FROM trader_evaluation_cohorts WHERE id=?').get(cohortId) as EvaluationCohortRow | undefined) ?? null
}

export function listCohorts(db: Database.Database): EvaluationCohortRow[] {
  return db.prepare('SELECT * FROM trader_evaluation_cohorts ORDER BY created_at DESC,id').all() as EvaluationCohortRow[]
}

export interface CohortBacktestEvidence {
  configFingerprint: string
  sharpe: number
  tradeCount: number
  maxDrawdownPct: number
  report: unknown
}

export function recordCohortBacktest(
  db: Database.Database,
  cohortId: string,
  evidence: CohortBacktestEvidence,
  actor = 'local-operator',
  nowMs = Date.now(),
): void {
  const cohort = getCohort(db, cohortId)
  if (!cohort) throw new Error('cohort not found')
  if (!['draft', 'running'].includes(cohort.status)) throw new Error('backtest evidence can only attach to draft or running cohorts')
  if (evidence.configFingerprint !== cohort.config_fingerprint) throw new Error('backtest fingerprint does not match cohort')
  finiteInRange(evidence.sharpe, -100, 100, 'backtest sharpe')
  if (!Number.isInteger(evidence.tradeCount) || evidence.tradeCount < 0 || evidence.tradeCount > 10_000_000) throw new Error('backtest trade count out of range')
  finiteInRange(evidence.maxDrawdownPct, 0, 1, 'backtest max drawdown')
  const reportJson = canonicalJson(evidence.report)
  if (Buffer.byteLength(reportJson, 'utf8') > 1_000_000) throw new Error('backtest report is too large')
  const save = db.transaction(() => {
    db.prepare(`UPDATE trader_evaluation_cohorts SET backtest_sharpe=?,backtest_trade_count=?,
      backtest_max_drawdown_pct=?,backtest_fingerprint=?,backtest_evaluated_at=?,backtest_report_json=? WHERE id=?`)
      .run(evidence.sharpe,evidence.tradeCount,evidence.maxDrawdownPct,evidence.configFingerprint,nowMs,reportJson,cohortId)
    event(db,cohortId,'backtest_recorded',actor,{sharpe:evidence.sharpe,tradeCount:evidence.tradeCount,maxDrawdownPct:evidence.maxDrawdownPct},nowMs)
  })
  save()
}

export function cohortEnforcementEnabled(db: Database.Database): boolean {
  try {
    return (db.prepare('SELECT value FROM kv_settings WHERE key=?').get(COHORT_ENFORCEMENT_KV_KEY) as {value: string} | undefined)?.value === '1'
  } catch { return false }
}

export function currentFingerprintMatches(db: Database.Database, cohort: EvaluationCohortRow): boolean {
  try {
    const stored = JSON.parse(cohort.config_json) as CohortConfig
    const strategy = readStrategy(db, cohort.strategy_id)
    const current: CohortConfig = {
      ...stored,
      strategy: {...stored.strategy, assetClass: strategy.asset_class as CohortAssetClass, params: parseStrategyParams(strategy.params_json)},
      runtime: runtimePolicy(),
    }
    return cohortFingerprint(current) === cohort.config_fingerprint && strategy.max_size_usd === cohort.max_position_usd
  } catch { return false }
}

export function activateCohort(
  db: Database.Database,
  cohortId: string,
  preflight: CohortPreflight,
  actor: string,
  nowMs = Date.now(),
): EvaluationCohortRow {
  const cohort = getCohort(db, cohortId)
  if (!cohort) throw new Error('cohort not found')
  if (cohort.status === 'running') {
    if (!currentFingerprintMatches(db, cohort)) throw new Error('running cohort configuration mismatch')
    return cohort
  }
  if (cohort.status !== 'draft') throw new Error('only a draft cohort can start')
  const runningSleeve = db.prepare(`SELECT id FROM trader_evaluation_cohorts
    WHERE asset_class=? AND status='running' AND id<>? LIMIT 1`).get(cohort.asset_class, cohort.id) as {id: string} | undefined
  if (runningSleeve) throw new Error(`asset-class sleeve already has running cohort ${runningSleeve.id}`)
  if (cohort.mode !== 'paper' || preflight.engineMode !== 'paper') throw new Error('paper engine mode required')
  if (preflight.brokerConnected !== true) throw new Error('broker connection required')
  if (preflight.dataVenueConnected !== true) throw new Error('strategy data venue connection required')
  if (preflight.assetClassEnabled !== true) throw new Error('strategy asset class is disabled')
  if (preflight.reconcilerHalted !== false) throw new Error('clean reconciliation required')
  if (preflight.reconcileDriftDetected !== false) throw new Error('latest reconciliation must be drift-free')
  if (!preflight.reconcileFresh) throw new Error('latest reconciliation is stale')
  if (!preflight.ordersAvailable || !preflight.positionsAvailable) throw new Error('complete broker state required')
  if (preflight.openOrderCount !== 0) throw new Error('open broker orders must be zero at cohort start')
  if (preflight.conflictingPositionCount !== 0) throw new Error('cohort-universe positions must be flat at cohort start')
  if (preflight.unknownOrderCount !== 0) throw new Error('unresolved orders must be zero')
  if (preflight.unexpectedShortCount !== 0) throw new Error('unexpected shorts must be zero')
  if (!preflight.quarantineLegacyPositions) throw new Error('legacy positions must be explicitly quarantined')

  const strategy = readStrategy(db, cohort.strategy_id)
  const stored = JSON.parse(cohort.config_json) as CohortConfig
  const currentWithoutSize: CohortConfig = {
    ...stored,
    strategy: {...stored.strategy, assetClass: strategy.asset_class as CohortAssetClass, params: parseStrategyParams(strategy.params_json)},
    runtime: runtimePolicy(),
  }
  if (cohortFingerprint(currentWithoutSize) !== cohort.config_fingerprint) throw new Error('cohort configuration mismatch')

  const start = db.transaction(() => {
    // One candidate per sleeve. Starting Bitcoin must not pause the stock
    // cohort, and starting stocks must not stop 24/7 Bitcoin collection.
    db.prepare("UPDATE trader_strategies SET status='paused',updated_at=? WHERE asset_class=? AND id<>?")
      .run(nowMs, cohort.asset_class, cohort.strategy_id)
    db.prepare("UPDATE trader_strategies SET status='active',max_size_usd=?,updated_at=? WHERE id=?")
      .run(cohort.max_position_usd, nowMs, cohort.strategy_id)
    db.prepare(`UPDATE trader_evaluation_cohorts SET status='running',started_at=?,legacy_quarantined_at=?
      WHERE id=? AND status='draft'`).run(nowMs, nowMs, cohort.id)
    db.prepare('CREATE TABLE IF NOT EXISTS kv_settings (key TEXT PRIMARY KEY,value TEXT NOT NULL)').run()
    db.prepare('INSERT OR REPLACE INTO kv_settings (key,value) VALUES (?,?)').run(COHORT_ENFORCEMENT_KV_KEY, '1')
    event(db, cohort.id, 'started', actor, {preflight: 'passed'}, nowMs)
  })
  start()
  return getCohort(db, cohort.id)!
}

export function invalidateCohort(db: Database.Database, cohortId: string, reason: string, actor = 'system', nowMs = Date.now()): void {
  if (!reason.trim()) throw new Error('invalidation reason required')
  const cohort = getCohort(db, cohortId)
  if (!cohort) throw new Error('cohort not found')
  if (cohort.status === 'invalidated') return
  const invalidate = db.transaction(() => {
    db.prepare(`UPDATE trader_evaluation_cohorts SET status='invalidated',invalidated_at=?,ended_at=?,invalidation_reason=?
      WHERE id=?`).run(nowMs, nowMs, reason.slice(0, 500), cohortId)
    db.prepare("UPDATE trader_strategies SET status='paused',updated_at=? WHERE id=?").run(nowMs, cohort.strategy_id)
    event(db, cohortId, 'invalidated', actor, {reason: reason.slice(0, 500)}, nowMs)
  })
  invalidate()
}

export function guardRunningCohort(db: Database.Database, strategyId: string, asset: string): CohortGuardResult {
  if (!cohortEnforcementEnabled(db)) return {ok: true, cohort: null, reason: null, suppression: null}
  const cohort = db.prepare("SELECT * FROM trader_evaluation_cohorts WHERE strategy_id=? AND status='running'")
    .get(strategyId) as EvaluationCohortRow | undefined
  if (!cohort) return {ok: false, cohort: null, reason: 'no running evaluation cohort', suppression: 'no_running_cohort'}
  if (cohort.mode !== 'paper') return {ok: false, cohort, reason: 'evaluation cohort is not paper mode', suppression: 'no_running_cohort'}
  let universe: unknown
  try { universe = JSON.parse(cohort.universe_json) } catch { universe = null }
  if (!Array.isArray(universe) || !universe.includes(asset)) {
    return {ok: false, cohort, reason: `asset ${asset} is outside the frozen cohort universe`, suppression: 'outside_cohort_universe'}
  }
  if (!currentFingerprintMatches(db, cohort)) {
    invalidateCohort(db, cohort.id, 'runtime configuration fingerprint changed')
    return {ok: false, cohort: null, reason: 'cohort invalidated by configuration drift', suppression: 'no_running_cohort'}
  }
  return {ok: true, cohort, reason: null, suppression: null}
}

export function countCohortEntriesToday(db: Database.Database, cohortId: string, nowMs = Date.now()): number {
  const start = startOfNyDayMs(nowMs)
  return (db.prepare(`SELECT count(*) AS n FROM trader_decisions
    WHERE cohort_id=? AND decided_at>=? AND action='buy' AND status NOT IN ('committee_abstain','failed')`)
    .get(cohortId, start) as {n: number}).n
}
