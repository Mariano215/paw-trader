import {createHash, randomUUID} from 'node:crypto'
import type Database from 'better-sqlite3'
import {maxDrawdown, sharpe, tradeStats} from './metrics.js'
import {getBitcoinOrderFlowResearchProgress} from './bitcoin-order-flow-progress.js'
import {recordTraderOperationalEvent} from './operational-events.js'

const HOLD_MS = 60 * 60 * 1000
const STOP_FRACTION = 0.015
const VOLATILITY_LOOKBACK_BARS = 28 * 24 * 4
const MIN_VOLATILITY_HISTORY_BARS = 7 * 24 * 4
const BOOTSTRAP_SAMPLES = 10_000
const BOOTSTRAP_BLOCK_TRADES = 8

export interface BitcoinOrderFlowEvaluationBar {
  bucketStartMs: number
  bucketEndMs: number
  tradeImbalance15m: number | null
  tradeImbalance60m: number | null
  depthImbalance15m: number | null
  realizedVolatility60m: number | null
  priceOpen: number | null
  priceHigh: number | null
  priceLow: number | null
  priceClose: number | null
  eligible: boolean
  qualityReason: string | null
}

export interface BitcoinOrderFlowVariant {
  id: string
  tradeImbalanceThreshold: number
  depthImbalanceThreshold: number
  confirmationBars: 1 | 2
  volatilityPercentile: 0.75 | 0.90
}

export interface BitcoinOrderFlowSimulatedTrade {
  entryAt: number
  exitAt: number
  entryPrice: number
  exitPrice: number
  exitReason: 'stop' | 'sign_reversal' | 'time'
  volatilityRegime: 'low' | 'high'
  netReturn: number
}

export interface BitcoinOrderFlowPhaseResult {
  tradeCount: number
  winCount: number
  totalReturn: number
  expectancy: number
  sharpe: number
  maxDrawdown: number
  regimes: string[]
}

interface PhaseSimulation {
  summary: BitcoinOrderFlowPhaseResult
  trades: BitcoinOrderFlowSimulatedTrade[]
}

export interface BitcoinOrderFlowEvaluationCriterion {
  name: string
  passed: boolean
  detail: string
}

export interface BitcoinOrderFlowResearchEvaluation {
  contractHash: string
  inputHash: string
  status: 'rejected_pre_holdout' | 'rejected' | 'passed'
  holdoutUses: 0 | 1
  selectedVariant: BitcoinOrderFlowVariant | null
  development: BitcoinOrderFlowPhaseResult | null
  validation: BitcoinOrderFlowPhaseResult | null
  holdout: BitcoinOrderFlowPhaseResult | null
  sensitivity: Record<string, BitcoinOrderFlowPhaseResult> | null
  bootstrap: {probabilityPositiveMean: number; fifthPercentileCompoundedReturn: number} | null
  criteria: BitcoinOrderFlowEvaluationCriterion[]
  passed: boolean
}

export interface BitcoinOrderFlowEvaluationRunRow {
  id: string
  declaration_version: number
  declaration_at: number
  data_cutoff_at: number
  contract_hash: string
  input_hash: string
  status: BitcoinOrderFlowResearchEvaluation['status']
  holdout_uses: 0 | 1
  selected_variant_id: string | null
  selected_variant_json: string | null
  development_json: string
  validation_json: string
  holdout_json: string | null
  sensitivity_json: string | null
  bootstrap_json: string | null
  criteria_json: string
  passed: 0 | 1
  created_at: number
}

export type MaybeBitcoinOrderFlowEvaluationResult =
  | {state: 'awaiting_collection'; run: null}
  | {state: 'completed' | 'already_completed'; run: BitcoinOrderFlowEvaluationRunRow}

interface EvaluationContract {
  volatilityLookbackBars: number
  minimumVolatilityHistoryBars: number
  bootstrapSamples: number
  bootstrapBlockTrades: number
  minimumHoldoutTrades: number
  baseCostBpsPerSide: number
}

const PRODUCTION_CONTRACT: EvaluationContract = {
  volatilityLookbackBars: VOLATILITY_LOOKBACK_BARS,
  minimumVolatilityHistoryBars: MIN_VOLATILITY_HISTORY_BARS,
  bootstrapSamples: BOOTSTRAP_SAMPLES,
  bootstrapBlockTrades: BOOTSTRAP_BLOCK_TRADES,
  minimumHoldoutTrades: 100,
  baseCostBpsPerSide: 35,
}

const CONTRACT_DECLARATION = {
  version: 1,
  split: [0.60, 0.20, 0.20],
  predictorInputs: ['trade_imbalance_15m', 'trade_imbalance_60m', 'depth_imbalance_15m', 'realized_volatility_60m'],
  tradeImbalanceThresholds: [0.15, 0.25, 0.35],
  depthImbalanceThresholds: [0.10, 0.20],
  confirmationBars: [1, 2],
  volatilityPercentiles: [0.75, 0.90],
  volatilityLookbackBars: VOLATILITY_LOOKBACK_BARS,
  minimumVolatilityHistoryBars: MIN_VOLATILITY_HISTORY_BARS,
  entry: 'next_contiguous_eligible_bar_open',
  exits: {maximumHoldMinutes: 60, signReversal: 'either_15m_trade_or_depth_negative', stopFraction: STOP_FRACTION},
  costsBpsPerSide: {base: 35, stress: [50, 75]},
  criteria: {
    minimumHoldoutTrades: 100,
    positiveReturn: true,
    positiveExpectancy: true,
    positiveSharpe: true,
    maximumDrawdown: 0.20,
    minimumVolatilityRegimes: 2,
    minimumBootstrapProbabilityPositiveMean: 0.95,
    minimumBootstrapFifthPercentileCompoundedReturn: 0,
    adjacentThresholdReturnFloor: 0,
    stressReturnFloor: 0,
  },
  bootstrap: {samples: BOOTSTRAP_SAMPLES, circularBlockTrades: BOOTSTRAP_BLOCK_TRADES},
  promotion: 'research_review_only',
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => [key, stableValue(child)]))
  }
  return value
}

function stableJson(value: unknown): string {
  return JSON.stringify(stableValue(value))
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function percentile(values: number[], probability: number): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(probability * sorted.length) - 1))
  return sorted[index]
}

export function bitcoinOrderFlowEvaluationVariants(): BitcoinOrderFlowVariant[] {
  const variants: BitcoinOrderFlowVariant[] = []
  for (const trade of [0.15, 0.25, 0.35]) {
    for (const depth of [0.10, 0.20]) {
      for (const confirmation of [1, 2] as const) {
        for (const volatility of [0.75, 0.90] as const) {
          variants.push({
            id: `t${Math.round(trade * 100)}-d${Math.round(depth * 100)}-c${confirmation}-v${Math.round(volatility * 100)}`,
            tradeImbalanceThreshold: trade,
            depthImbalanceThreshold: depth,
            confirmationBars: confirmation,
            volatilityPercentile: volatility,
          })
        }
      }
    }
  }
  return variants
}

function finitePrice(value: number | null): value is number {
  return value !== null && Number.isFinite(value) && value > 0
}

function usableBar(bar: BitcoinOrderFlowEvaluationBar): boolean {
  return bar.eligible && bar.qualityReason === null &&
    finitePrice(bar.priceOpen) && finitePrice(bar.priceHigh) &&
    finitePrice(bar.priceLow) && finitePrice(bar.priceClose)
}

function signalPasses(
  bars: BitcoinOrderFlowEvaluationBar[],
  index: number,
  variant: BitcoinOrderFlowVariant,
  contract: EvaluationContract,
): boolean {
  const bar = bars[index]
  if (!usableBar(bar) || bar.tradeImbalance15m === null || bar.tradeImbalance60m === null ||
      bar.depthImbalance15m === null || bar.realizedVolatility60m === null) return false
  const history = bars.slice(Math.max(0, index - contract.volatilityLookbackBars), index)
    .filter(candidate => candidate.eligible && candidate.realizedVolatility60m !== null)
    .map(candidate => candidate.realizedVolatility60m as number)
  if (history.length < contract.minimumVolatilityHistoryBars) return false
  const ceiling = percentile(history, variant.volatilityPercentile)
  return ceiling !== null && bar.realizedVolatility60m <= ceiling &&
    bar.tradeImbalance15m >= variant.tradeImbalanceThreshold &&
    bar.tradeImbalance60m >= variant.tradeImbalanceThreshold &&
    bar.depthImbalance15m >= variant.depthImbalanceThreshold
}

function summarizeTrades(trades: BitcoinOrderFlowSimulatedTrade[], phaseStart: number): BitcoinOrderFlowPhaseResult {
  const returns = trades.map(trade => trade.netReturn)
  const stats = tradeStats(returns)
  let equity = 1
  const curve = [{ts_ms: phaseStart, equity}]
  for (const trade of trades) {
    equity *= Math.max(0.000001, 1 + trade.netReturn)
    curve.push({ts_ms: trade.exitAt, equity})
  }
  return {
    tradeCount: trades.length,
    winCount: trades.filter(trade => trade.netReturn > 0).length,
    totalReturn: equity - 1,
    expectancy: stats.expectancy,
    sharpe: sharpe(returns),
    maxDrawdown: maxDrawdown(curve).maxDrawdown,
    regimes: [...new Set(trades.map(trade => trade.volatilityRegime))].sort(),
  }
}

function simulateVariant(
  bars: BitcoinOrderFlowEvaluationBar[],
  phaseStart: number,
  phaseEnd: number,
  variant: BitcoinOrderFlowVariant,
  costBpsPerSide: number,
  contract: EvaluationContract,
  regimeBoundary: number,
): PhaseSimulation {
  const trades: BitcoinOrderFlowSimulatedTrade[] = []
  let streak = 0
  for (let index = 0; index < bars.length - 1; index += 1) {
    const signalBar = bars[index]
    if (signalBar.bucketStartMs < phaseStart || signalBar.bucketEndMs > phaseEnd) continue
    if (index > 0 && bars[index - 1].bucketEndMs !== signalBar.bucketStartMs) streak = 0
    if (signalPasses(bars, index, variant, contract)) streak += 1
    else streak = 0
    if (streak < variant.confirmationBars) continue
    const entryBar = bars[index + 1]
    if (entryBar.bucketStartMs !== signalBar.bucketEndMs || entryBar.bucketStartMs < phaseStart ||
        entryBar.bucketEndMs > phaseEnd || !usableBar(entryBar)) continue
    const entryPrice = entryBar.priceOpen as number
    const stopPrice = entryPrice * (1 - STOP_FRACTION)
    let completed: BitcoinOrderFlowSimulatedTrade | null = null
    let exitIndex = index + 1
    for (; exitIndex < bars.length; exitIndex += 1) {
      const exitBar = bars[exitIndex]
      if (exitBar.bucketStartMs < entryBar.bucketStartMs) continue
      if (exitBar.bucketEndMs > phaseEnd || !usableBar(exitBar)) break
      let exitPrice: number | null = null
      let exitReason: BitcoinOrderFlowSimulatedTrade['exitReason'] = 'time'
      if ((exitBar.priceLow as number) <= stopPrice) {
        // A bar opening through the stop cannot receive the better stop price.
        exitPrice = Math.min(exitBar.priceOpen as number, stopPrice)
        exitReason = 'stop'
      } else if ((exitBar.tradeImbalance15m ?? 0) < 0 || (exitBar.depthImbalance15m ?? 0) < 0) {
        exitPrice = exitBar.priceClose
        exitReason = 'sign_reversal'
      } else if (exitBar.bucketEndMs >= entryBar.bucketStartMs + HOLD_MS) {
        exitPrice = exitBar.priceClose
      }
      if (exitPrice !== null) {
        const roundTripCost = 2 * costBpsPerSide / 10_000
        completed = {
          entryAt: entryBar.bucketStartMs,
          exitAt: exitBar.bucketEndMs,
          entryPrice,
          exitPrice,
          exitReason,
          volatilityRegime: (signalBar.realizedVolatility60m ?? 0) <= regimeBoundary ? 'low' : 'high',
          netReturn: exitPrice / entryPrice - 1 - roundTripCost,
        }
        break
      }
    }
    if (completed) trades.push(completed)
    index = Math.max(index, exitIndex)
    streak = 0
  }
  return {summary: summarizeTrades(trades, phaseStart), trades}
}

function xorshift32(seed: number): () => number {
  let state = seed >>> 0 || 0x9e3779b9
  return () => {
    state ^= state << 13
    state ^= state >>> 17
    state ^= state << 5
    return (state >>> 0) / 0x1_0000_0000
  }
}

function bootstrap(
  returns: number[],
  samples: number,
  blockSize: number,
  seedText: string,
): {probabilityPositiveMean: number; fifthPercentileCompoundedReturn: number} {
  if (returns.length === 0) return {probabilityPositiveMean: 0, fifthPercentileCompoundedReturn: -1}
  const seed = Number.parseInt(sha256(seedText).slice(0, 8), 16)
  const random = xorshift32(seed)
  let positive = 0
  const compounded: number[] = []
  for (let sample = 0; sample < samples; sample += 1) {
    const selected: number[] = []
    while (selected.length < returns.length) {
      const start = Math.floor(random() * returns.length)
      for (let offset = 0; offset < blockSize && selected.length < returns.length; offset += 1) {
        selected.push(returns[(start + offset) % returns.length])
      }
    }
    const average = selected.reduce((sum, value) => sum + value, 0) / selected.length
    if (average > 0) positive += 1
    compounded.push(selected.reduce((growth, value) => growth * Math.max(0.000001, 1 + value), 1) - 1)
  }
  compounded.sort((a, b) => a - b)
  return {
    probabilityPositiveMean: positive / samples,
    fifthPercentileCompoundedReturn: compounded[Math.max(0, Math.ceil(0.05 * samples) - 1)],
  }
}

function developmentQualified(result: BitcoinOrderFlowPhaseResult): boolean {
  return result.tradeCount > 0 && result.totalReturn > 0 && result.expectancy > 0 &&
    result.sharpe > 0 && result.maxDrawdown <= 0.20
}

function inputHash(bars: BitcoinOrderFlowEvaluationBar[]): string {
  return sha256(stableJson(bars.map(bar => [
    bar.bucketStartMs, bar.bucketEndMs, bar.tradeImbalance15m, bar.tradeImbalance60m,
    bar.depthImbalance15m, bar.realizedVolatility60m, bar.priceOpen, bar.priceHigh,
    bar.priceLow, bar.priceClose, bar.eligible, bar.qualityReason,
  ])))
}

export function evaluateBitcoinOrderFlowResearch(
  bars: BitcoinOrderFlowEvaluationBar[],
  declarationAt: number,
  dataCutoffAt: number,
  overrides: Partial<EvaluationContract> = {},
): BitcoinOrderFlowResearchEvaluation {
  const contract = {...PRODUCTION_CONTRACT, ...overrides}
  const contractHash = sha256(stableJson(CONTRACT_DECLARATION))
  const sorted = [...bars].filter(bar => bar.bucketStartMs >= declarationAt && bar.bucketEndMs <= dataCutoffAt)
    .sort((a, b) => a.bucketStartMs - b.bucketStartMs)
  const span = dataCutoffAt - declarationAt
  const developmentEnd = declarationAt + Math.floor(span * 0.60)
  const validationEnd = declarationAt + Math.floor(span * 0.80)
  const developmentVolatility = sorted.filter(bar => bar.bucketEndMs <= developmentEnd &&
      bar.eligible && bar.realizedVolatility60m !== null)
    .map(bar => bar.realizedVolatility60m as number)
  const regimeBoundary = percentile(developmentVolatility, 0.50) ?? 0
  const candidates = bitcoinOrderFlowEvaluationVariants().map(variant => {
    const development = simulateVariant(sorted, declarationAt, developmentEnd, variant,
      contract.baseCostBpsPerSide, contract, regimeBoundary)
    const validation = simulateVariant(sorted, developmentEnd, validationEnd, variant,
      contract.baseCostBpsPerSide, contract, regimeBoundary)
    return {variant, development, validation}
  }).filter(candidate => developmentQualified(candidate.development.summary) &&
    developmentQualified(candidate.validation.summary))
    .sort((a, b) => b.validation.summary.expectancy - a.validation.summary.expectancy ||
      b.validation.summary.totalReturn - a.validation.summary.totalReturn ||
      a.variant.id.localeCompare(b.variant.id))

  if (candidates.length === 0) {
    return {
      contractHash, inputHash: inputHash(sorted), status: 'rejected_pre_holdout',
      holdoutUses: 0, selectedVariant: null, development: null, validation: null,
      holdout: null, sensitivity: null, bootstrap: null,
      criteria: [{name: 'development_validation_selection', passed: false,
        detail: 'no frozen variant was positive in both development and validation'}],
      passed: false,
    }
  }

  const selected = candidates[0]
  const holdout = simulateVariant(sorted, validationEnd, dataCutoffAt, selected.variant,
    contract.baseCostBpsPerSide, contract, regimeBoundary)
  const stress50 = simulateVariant(sorted, validationEnd, dataCutoffAt, selected.variant, 50, contract, regimeBoundary)
  const stress75 = simulateVariant(sorted, validationEnd, dataCutoffAt, selected.variant, 75, contract, regimeBoundary)
  const adjacent = bitcoinOrderFlowEvaluationVariants().filter(variant =>
    variant.confirmationBars === selected.variant.confirmationBars &&
    variant.volatilityPercentile === selected.variant.volatilityPercentile &&
    ((variant.depthImbalanceThreshold === selected.variant.depthImbalanceThreshold &&
      Math.abs(Math.abs(variant.tradeImbalanceThreshold - selected.variant.tradeImbalanceThreshold) - 0.10) < 1e-9) ||
     (variant.tradeImbalanceThreshold === selected.variant.tradeImbalanceThreshold &&
      Math.abs(Math.abs(variant.depthImbalanceThreshold - selected.variant.depthImbalanceThreshold) - 0.10) < 1e-9)))
  const sensitivity: Record<string, BitcoinOrderFlowPhaseResult> = {
    cost_50_bps_per_side: stress50.summary,
    cost_75_bps_per_side: stress75.summary,
  }
  for (const variant of adjacent) {
    sensitivity[`adjacent_${variant.id}`] = simulateVariant(sorted, validationEnd, dataCutoffAt,
      variant, contract.baseCostBpsPerSide, contract, regimeBoundary).summary
  }
  const boot = bootstrap(holdout.trades.map(trade => trade.netReturn), contract.bootstrapSamples,
    contract.bootstrapBlockTrades, `${contractHash}:${inputHash(sorted)}:${selected.variant.id}`)
  const adjacentStable = Object.entries(sensitivity)
    .filter(([name]) => name.startsWith('adjacent_'))
    .every(([, result]) => result.totalReturn >= 0)
  const criteria: BitcoinOrderFlowEvaluationCriterion[] = [
    {name: 'development_validation_selection', passed: true, detail: selected.variant.id},
    {name: 'minimum_holdout_trades', passed: holdout.summary.tradeCount >= contract.minimumHoldoutTrades,
      detail: `${holdout.summary.tradeCount}/${contract.minimumHoldoutTrades}`},
    {name: 'positive_holdout_return', passed: holdout.summary.totalReturn > 0,
      detail: holdout.summary.totalReturn.toFixed(6)},
    {name: 'positive_holdout_expectancy', passed: holdout.summary.expectancy > 0,
      detail: holdout.summary.expectancy.toFixed(6)},
    {name: 'positive_holdout_sharpe', passed: holdout.summary.sharpe > 0,
      detail: holdout.summary.sharpe.toFixed(6)},
    {name: 'maximum_drawdown', passed: holdout.summary.maxDrawdown <= 0.20,
      detail: holdout.summary.maxDrawdown.toFixed(6)},
    {name: 'volatility_regimes', passed: holdout.summary.regimes.length >= 2,
      detail: holdout.summary.regimes.join(',') || 'none'},
    {name: 'adjacent_threshold_stability', passed: adjacentStable,
      detail: `${adjacent.length} adjacent variants checked`},
    {name: 'cost_stress_50_bps', passed: stress50.summary.totalReturn >= 0,
      detail: stress50.summary.totalReturn.toFixed(6)},
    {name: 'cost_stress_75_bps', passed: stress75.summary.totalReturn >= 0,
      detail: stress75.summary.totalReturn.toFixed(6)},
    {name: 'bootstrap_positive_mean', passed: boot.probabilityPositiveMean >= 0.95,
      detail: boot.probabilityPositiveMean.toFixed(6)},
    {name: 'bootstrap_fifth_percentile', passed: boot.fifthPercentileCompoundedReturn >= 0,
      detail: boot.fifthPercentileCompoundedReturn.toFixed(6)},
  ]
  const passed = criteria.every(criterion => criterion.passed)
  return {
    contractHash, inputHash: inputHash(sorted), status: passed ? 'passed' : 'rejected',
    holdoutUses: 1, selectedVariant: selected.variant,
    development: selected.development.summary, validation: selected.validation.summary,
    holdout: holdout.summary, sensitivity, bootstrap: boot, criteria, passed,
  }
}

function readBars(db: Database.Database, declarationAt: number, cutoffAt: number): BitcoinOrderFlowEvaluationBar[] {
  return db.prepare(`SELECT bucket_start_ms AS bucketStartMs,bucket_end_ms AS bucketEndMs,
      trade_imbalance_15m AS tradeImbalance15m,trade_imbalance_60m AS tradeImbalance60m,
      depth_imbalance_15m AS depthImbalance15m,realized_volatility_60m AS realizedVolatility60m,
      price_open AS priceOpen,price_high AS priceHigh,price_low AS priceLow,price_close AS priceClose,
      eligible=1 AS eligible,quality_reason AS qualityReason
    FROM bitcoin_order_flow_15m_bars
    WHERE bucket_start_ms>=? AND bucket_end_ms<=? ORDER BY bucket_start_ms`)
    .all(declarationAt, cutoffAt) as BitcoinOrderFlowEvaluationBar[]
}

function readRun(db: Database.Database, declarationVersion: number): BitcoinOrderFlowEvaluationRunRow | null {
  return (db.prepare('SELECT * FROM bitcoin_order_flow_evaluation_runs WHERE declaration_version=?')
    .get(declarationVersion) as BitcoinOrderFlowEvaluationRunRow | undefined) ?? null
}

function assertExecutionLocked(mainDb: Database.Database, params: Record<string, unknown>): void {
  if (params.family !== 'microstructure-order-flow' || params.research_status !== 'predeclared' ||
      params.engine_candidate_enabled !== false || params.holdout_uses !== 1) {
    throw new Error('Bitcoin order-flow declaration does not match the frozen non-executable contract')
  }
  const active = mainDb.prepare("SELECT COUNT(*) AS n FROM trader_strategies WHERE asset_class='crypto' AND status!='paused'")
    .get() as {n: number}
  if (active.n !== 0) throw new Error('Bitcoin evaluation blocked while any crypto strategy is not paused')
  const cohort = mainDb.prepare("SELECT COUNT(*) AS n FROM trader_evaluation_cohorts WHERE strategy_id='order-flow-imbalance-crypto'")
    .get() as {n: number}
  const signal = mainDb.prepare("SELECT COUNT(*) AS n FROM trader_signals WHERE strategy_id='order-flow-imbalance-crypto'")
    .get() as {n: number}
  if (cohort.n !== 0 || signal.n !== 0) throw new Error('Bitcoin evaluation blocked by executable family state')
}

export function maybeRunBitcoinOrderFlowEvaluation(
  mainDb: Database.Database,
  researchDb: Database.Database,
  nowMs = Date.now(),
): MaybeBitcoinOrderFlowEvaluationResult {
  const strategy = mainDb.prepare(`SELECT status,params_json,created_at FROM trader_strategies
    WHERE id='order-flow-imbalance-crypto'`).get() as
    {status: string; params_json: string; created_at: number} | undefined
  if (!strategy) return {state: 'awaiting_collection', run: null}
  const params = JSON.parse(strategy.params_json) as Record<string, unknown>
  const declarationVersion = Number(params.declaration_version)
  const minimumForwardDays = Number(params.minimum_forward_days)
  if (!Number.isSafeInteger(declarationVersion) || declarationVersion <= 0 ||
      !Number.isSafeInteger(minimumForwardDays) || minimumForwardDays <= 0) {
    throw new Error('invalid Bitcoin order-flow declaration')
  }
  const existing = readRun(researchDb, declarationVersion)
  if (existing) return {state: 'already_completed', run: existing}
  const progress = getBitcoinOrderFlowResearchProgress(researchDb, strategy.created_at, minimumForwardDays)
  if (!progress.collectionMature || nowMs < progress.earliestEvaluationAt) {
    return {state: 'awaiting_collection', run: null}
  }
  assertExecutionLocked(mainDb, params)
  const configuredMinimumTrades = Number(params.minimum_oos_trades)
  const configuredFee = Number(params.fee_bps_per_side)
  const configuredSlippage = Number(params.slippage_bps_per_side)
  if (!Number.isSafeInteger(configuredMinimumTrades) || configuredMinimumTrades <= 0 ||
      configuredFee !== 25 || configuredSlippage !== 10) {
    throw new Error('invalid Bitcoin order-flow evaluation thresholds')
  }
  const evaluation = evaluateBitcoinOrderFlowResearch(
    readBars(researchDb, strategy.created_at, progress.earliestEvaluationAt),
    strategy.created_at,
    progress.earliestEvaluationAt,
    {minimumHoldoutTrades: configuredMinimumTrades, baseCostBpsPerSide: configuredFee + configuredSlippage},
  )
  const run: BitcoinOrderFlowEvaluationRunRow = {
    id: randomUUID(), declaration_version: declarationVersion,
    declaration_at: strategy.created_at, data_cutoff_at: progress.earliestEvaluationAt,
    contract_hash: evaluation.contractHash, input_hash: evaluation.inputHash,
    status: evaluation.status, holdout_uses: evaluation.holdoutUses,
    selected_variant_id: evaluation.selectedVariant?.id ?? null,
    selected_variant_json: evaluation.selectedVariant ? stableJson(evaluation.selectedVariant) : null,
    development_json: stableJson(evaluation.development), validation_json: stableJson(evaluation.validation),
    holdout_json: evaluation.holdout ? stableJson(evaluation.holdout) : null,
    sensitivity_json: evaluation.sensitivity ? stableJson(evaluation.sensitivity) : null,
    bootstrap_json: evaluation.bootstrap ? stableJson(evaluation.bootstrap) : null,
    criteria_json: stableJson(evaluation.criteria), passed: evaluation.passed ? 1 : 0,
    created_at: nowMs,
  }
  researchDb.prepare(`INSERT INTO bitcoin_order_flow_evaluation_runs
    (id,declaration_version,declaration_at,data_cutoff_at,contract_hash,input_hash,status,holdout_uses,
     selected_variant_id,selected_variant_json,development_json,validation_json,holdout_json,
     sensitivity_json,bootstrap_json,criteria_json,passed,created_at)
    VALUES (@id,@declaration_version,@declaration_at,@data_cutoff_at,@contract_hash,@input_hash,@status,
     @holdout_uses,@selected_variant_id,@selected_variant_json,@development_json,@validation_json,
     @holdout_json,@sensitivity_json,@bootstrap_json,@criteria_json,@passed,@created_at)`).run(run)
  recordTraderOperationalEvent(mainDb, {
    eventId: `research-evaluation:${run.id}`, sourceTs: nowMs,
    source: 'brain.bitcoin-order-flow-evaluator', stage: 'research',
    eventType: 'research.evaluation.completed', state: evaluation.passed ? 'succeeded' : 'completed',
    asset: 'BTC-USD', strategyId: 'order-flow-imbalance-crypto',
    metadata: {
      passed: evaluation.passed, status: evaluation.status,
      trade_count: evaluation.holdout?.tradeCount ?? 0,
      reason: evaluation.status,
    },
  })
  return {state: 'completed', run}
}
