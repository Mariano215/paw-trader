import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { initTraderTables } from './db.js'
import { seedMomentumStrategy, getStrategy, updateStrategyTier, getActiveStrategies } from './strategy-manager.js'

function makeDb() {
  const db = new Database(':memory:')
  initTraderTables(db)
  return db
}

describe('strategy-manager', () => {
  let db: ReturnType<typeof makeDb>

  beforeEach(() => { db = makeDb() })

  it('seedMomentumStrategy inserts the strategy', () => {
    seedMomentumStrategy(db)
    const row = getStrategy(db, 'momentum-stocks')
    expect(row).not.toBeNull()
    expect(row!.name).toBe('Momentum')
    expect(row!.tier).toBe(0)
    expect(row!.status).toBe('active')
  })

  it('seedMomentumStrategy is idempotent', () => {
    seedMomentumStrategy(db)
    seedMomentumStrategy(db)
    const strategies = getActiveStrategies(db)
    expect(strategies.filter(s => s.id === 'momentum-stocks')).toHaveLength(1)
  })

  it('updateStrategyTier updates the tier', () => {
    seedMomentumStrategy(db)
    updateStrategyTier(db, 'momentum-stocks', 1)
    const row = getStrategy(db, 'momentum-stocks')
    expect(row!.tier).toBe(1)
  })

  it('getActiveStrategies returns only active strategies', () => {
    seedMomentumStrategy(db)
    db.prepare("UPDATE trader_strategies SET status='paused' WHERE id='momentum-stocks'").run()
    const active = getActiveStrategies(db)
    expect(active).toHaveLength(0)
  })

  it('seedMeanReversionStrategy inserts the mean-reversion-stocks row', async () => {
    const { seedMeanReversionStrategy } = await import('./strategy-manager.js')
    seedMeanReversionStrategy(db)
    const row = getStrategy(db, 'mean-reversion-stocks')
    expect(row).not.toBeNull()
    expect(row!.asset_class).toBe('stocks')
    expect(row!.name).toBe('Mean Reversion')
  })

  it('seedCryptoMomentumStrategy inserts the momentum-crypto row', async () => {
    const { seedCryptoMomentumStrategy } = await import('./strategy-manager.js')
    seedCryptoMomentumStrategy(db)
    const row = getStrategy(db, 'momentum-crypto')
    expect(row).not.toBeNull()
    expect(row!.asset_class).toBe('crypto')
    expect(row!.tier).toBe(0)
    expect(row!.status).toBe('paused')
    expect(JSON.parse(row!.params_json)).toEqual({
      basket: ['BTC/USD'], bar_timeframe: '1d', lookback_high: 20,
      breakout_return_days: 7, horizon_days: 14, min_score: 0.05,
      signal_poll_minutes: 15,
    })
  })

  it('repairs stale crypto momentum metadata without changing operational state', async () => {
    const { seedCryptoMomentumStrategy } = await import('./strategy-manager.js')
    seedCryptoMomentumStrategy(db)
    db.prepare("UPDATE trader_strategies SET status='paused',tier=2,params_json='{}' WHERE id='momentum-crypto'").run()
    seedCryptoMomentumStrategy(db)
    const row = getStrategy(db, 'momentum-crypto')!
    expect(row.status).toBe('paused')
    expect(row.tier).toBe(2)
    expect(JSON.parse(row.params_json).lookback_high).toBe(20)
    expect(JSON.parse(row.params_json).basket).toEqual(['BTC/USD'])
  })

  it('seeds the exact BTC hourly pullback metadata paused until cohort activation', async () => {
    const { seedCryptoHourlyMeanReversionStrategy } = await import('./strategy-manager.js')
    seedCryptoHourlyMeanReversionStrategy(db)
    const row = getStrategy(db, 'mean-reversion-hourly-crypto')
    expect(row).not.toBeNull()
    expect(row!.asset_class).toBe('crypto')
    expect(row!.status).toBe('paused')
    expect(JSON.parse(row!.params_json)).toEqual({
      basket: ['BTC/USD'], bar_timeframe: '1h', rsi_window: 14, rsi_oversold: 35,
      ema_trend_window: 200, freefall_window_hours: 24, freefall_floor: -0.08,
      horizon_days: 1, min_score: 0.05, signal_poll_minutes: 15,
    })
  })

  it('seedAllStrategies is idempotent and covers all known rows', async () => {
    const { seedAllStrategies } = await import('./strategy-manager.js')
    seedAllStrategies(db)
    seedAllStrategies(db)
    const active = getActiveStrategies(db)
    const ids = active.map(s => s.id).sort()
    expect(ids).toEqual(['mean-reversion-stocks', 'momentum-stocks'])
    expect(getStrategy(db, 'momentum-crypto')!.status).toBe('paused')
    expect(getStrategy(db, 'mean-reversion-hourly-crypto')!.status).toBe('paused')
    expect(getStrategy(db, 'trend-4h-crypto')!.status).toBe('paused')
    expect(getStrategy(db, 'order-flow-imbalance-crypto')!.status).toBe('paused')
  })

  it('seeds the exact BTC four-hour trend metadata paused', async () => {
    const { seedCryptoFourHourTrendStrategy } = await import('./strategy-manager.js')
    seedCryptoFourHourTrendStrategy(db)
    const row = getStrategy(db, 'trend-4h-crypto')!
    expect(row.status).toBe('paused')
    expect(JSON.parse(row.params_json)).toMatchObject({
      basket: ['BTC/USD'], bar_timeframe: '4h', fast_ema: 20, slow_ema: 100,
      breakout_bars: 20, score_bars: 138, min_return: 0.014, horizon_days: 7,
    })
  })

  it('predeclares the BTC order-flow family without enabling execution', async () => {
    const { seedBitcoinOrderFlowResearchFamily } = await import('./strategy-manager.js')
    seedBitcoinOrderFlowResearchFamily(db)
    const row = getStrategy(db, 'order-flow-imbalance-crypto')!
    const params = JSON.parse(row.params_json)
    expect(row.status).toBe('paused')
    expect(params).toMatchObject({
      family: 'microstructure-order-flow',
      research_status: 'predeclared',
      engine_candidate_enabled: false,
      data_mode: 'forward-only',
      minimum_oos_trades: 100,
      holdout_uses: 1,
    })
  })
})
