import {describe, expect, it} from 'vitest'
import Database from 'better-sqlite3'
import {initTraderTables} from './db.js'
import {
  bitcoinOrderFlowEvaluationVariants,
  evaluateBitcoinOrderFlowResearch,
  maybeRunBitcoinOrderFlowEvaluation,
  type BitcoinOrderFlowEvaluationBar,
} from './bitcoin-order-flow-evaluation.js'
import {appendBitcoinOrderFlowBar, initBitcoinOrderFlowStore} from './bitcoin-order-flow-store.js'

const BAR_MS = 15 * 60 * 1000
const DAY_MS = 24 * 60 * 60 * 1000
const DECLARATION = 1_800_000_000_000 - (1_800_000_000_000 % BAR_MS)

function syntheticBars(count = 150, withSignals = true): BitcoinOrderFlowEvaluationBar[] {
  return Array.from({length: count}, (_, index) => {
    const signal = withSignals && index % 5 === 0
    const entry = withSignals && index % 5 === 1
    const close = entry ? (index % 10 === 1 ? 103 : 102) : 100
    return {
      bucketStartMs: DECLARATION + index * BAR_MS,
      bucketEndMs: DECLARATION + (index + 1) * BAR_MS,
      tradeImbalance15m: signal ? 0.50 : (entry ? -0.20 : 0),
      tradeImbalance60m: signal ? 0.50 : 0,
      depthImbalance15m: signal ? 0.30 : (entry ? -0.10 : 0),
      realizedVolatility60m: signal && index % 10 === 0 ? 0.005 :
        (signal ? 0.025 : (index % 2 === 0 ? 0.01 : 0.03)),
      priceOpen: 100,
      priceHigh: Math.max(100, close),
      priceLow: 99,
      priceClose: close,
      eligible: true,
      qualityReason: null,
    }
  })
}

function databases(): {main: Database.Database; research: Database.Database} {
  const main = new Database(':memory:')
  const research = new Database(':memory:')
  initTraderTables(main)
  initBitcoinOrderFlowStore(research)
  return {main, research}
}

function seedDeclaration(main: Database.Database, createdAt: number, minimumForwardDays = 1): void {
  main.prepare(`INSERT INTO trader_strategies
    (id,name,asset_class,tier,status,params_json,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?)`).run(
      'order-flow-imbalance-crypto', 'Bitcoin Order-Flow Imbalance Research',
      'crypto', 0, 'paused', JSON.stringify({
        family: 'microstructure-order-flow', research_status: 'predeclared',
        engine_candidate_enabled: false, holdout_uses: 1, declaration_version: 1,
        minimum_forward_days: minimumForwardDays, minimum_oos_trades: 100,
        fee_bps_per_side: 25, slippage_bps_per_side: 10,
      }), createdAt, createdAt,
    )
}

function appendTerminalBar(research: Database.Database, start: number): void {
  appendBitcoinOrderFlowBar(research, {
    bucketStartMs: start, bucketEndMs: start + BAR_MS,
    tradeCount: 1, buyVolume: 1, sellVolume: 0,
    tradeImbalance15m: 1, tradeImbalance60m: 1, depthImbalance15m: 1,
    bidDepletionPerSecond: 0, askDepletionPerSecond: 0,
    bidReplenishmentPerSecond: 0, askReplenishmentPerSecond: 0,
    spreadMedian: 1, spreadP95: 1, realizedVolatility60m: 0.01,
    priceOpen: 100, priceHigh: 101, priceLow: 99, priceClose: 100,
    messageCount: 1, sequenceGapCount: 0, reconnectCount: 0, downtimeMs: 0,
    eligible: true, qualityReason: null, createdAt: start + BAR_MS,
  })
}

describe('Bitcoin order-flow frozen evaluator', () => {
  it('enumerates exactly the 24 predeclared variants', () => {
    const variants = bitcoinOrderFlowEvaluationVariants()
    expect(variants).toHaveLength(24)
    expect(new Set(variants.map(variant => variant.id))).toHaveLength(24)
  })

  it('selects on development/validation and produces a deterministic one-use holdout verdict', () => {
    const bars = syntheticBars()
    const cutoff = DECLARATION + bars.length * BAR_MS
    const first = evaluateBitcoinOrderFlowResearch(bars, DECLARATION, cutoff, {
      volatilityLookbackBars: 8,
      minimumVolatilityHistoryBars: 2,
      bootstrapSamples: 200,
      bootstrapBlockTrades: 2,
      minimumHoldoutTrades: 2,
    })
    const second = evaluateBitcoinOrderFlowResearch(bars, DECLARATION, cutoff, {
      volatilityLookbackBars: 8,
      minimumVolatilityHistoryBars: 2,
      bootstrapSamples: 200,
      bootstrapBlockTrades: 2,
      minimumHoldoutTrades: 2,
    })
    expect(first).toEqual(second)
    expect(first.holdoutUses).toBe(1)
    expect(first.selectedVariant?.id).toBe('t15-d10-c1-v75')
    expect(first.holdout?.tradeCount).toBeGreaterThanOrEqual(2)
    expect(first.passed).toBe(true)
    expect(first.status).toBe('passed')
  })

  it('rejects before opening holdout when no variant qualifies', () => {
    const bars = syntheticBars(150, false)
    const result = evaluateBitcoinOrderFlowResearch(
      bars, DECLARATION, DECLARATION + bars.length * BAR_MS,
      {volatilityLookbackBars: 8, minimumVolatilityHistoryBars: 2, bootstrapSamples: 20},
    )
    expect(result).toMatchObject({status: 'rejected_pre_holdout', holdoutUses: 0,
      selectedVariant: null, holdout: null, passed: false})
  })

  it('does not persist before maturity and persists exactly one immutable terminal run after maturity', () => {
    const {main, research} = databases()
    seedDeclaration(main, DECLARATION)
    appendTerminalBar(research, DECLARATION + DAY_MS - BAR_MS)
    expect(maybeRunBitcoinOrderFlowEvaluation(main, research, DECLARATION + DAY_MS - 1))
      .toEqual({state: 'awaiting_collection', run: null})
    expect(research.prepare('SELECT COUNT(*) AS n FROM bitcoin_order_flow_evaluation_runs').get())
      .toEqual({n: 0})
    const first = maybeRunBitcoinOrderFlowEvaluation(main, research, DECLARATION + DAY_MS)
    const second = maybeRunBitcoinOrderFlowEvaluation(main, research, DECLARATION + DAY_MS + 1)
    expect(first.state).toBe('completed')
    expect(first.run?.status).toBe('rejected_pre_holdout')
    expect(second).toMatchObject({state: 'already_completed', run: {id: first.run?.id}})
    expect(research.prepare('SELECT COUNT(*) AS n FROM bitcoin_order_flow_evaluation_runs').get())
      .toEqual({n: 1})
    expect(main.prepare("SELECT event_type FROM trader_operational_events WHERE event_type='research.evaluation.completed'").get())
      .toEqual({event_type: 'research.evaluation.completed'})
    expect(main.prepare("SELECT status FROM trader_strategies WHERE id='order-flow-imbalance-crypto'").get())
      .toEqual({status: 'paused'})
    expect(main.prepare("SELECT COUNT(*) AS n FROM trader_evaluation_cohorts WHERE strategy_id='order-flow-imbalance-crypto'").get())
      .toEqual({n: 0})
    expect(main.prepare("SELECT COUNT(*) AS n FROM trader_signals WHERE strategy_id='order-flow-imbalance-crypto'").get())
      .toEqual({n: 0})
    main.close()
    research.close()
  })

  it('fails closed at maturity if a crypto execution path is enabled', () => {
    const {main, research} = databases()
    seedDeclaration(main, DECLARATION)
    main.prepare("UPDATE trader_strategies SET status='active' WHERE id='order-flow-imbalance-crypto'").run()
    appendTerminalBar(research, DECLARATION + DAY_MS - BAR_MS)
    expect(() => maybeRunBitcoinOrderFlowEvaluation(main, research, DECLARATION + DAY_MS))
      .toThrow(/not paused/)
    expect(research.prepare('SELECT COUNT(*) AS n FROM bitcoin_order_flow_evaluation_runs').get())
      .toEqual({n: 0})
    main.close()
    research.close()
  })
})
