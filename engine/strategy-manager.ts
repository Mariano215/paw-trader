import type Database from 'better-sqlite3'

export interface Strategy {
  id: string
  name: string
  asset_class: string
  tier: number
  status: string
  params_json: string
  created_at: number
  updated_at: number
}

export function seedMomentumStrategy(db: Database.Database): void {
  const now = Date.now()
  db.prepare(`
    INSERT OR IGNORE INTO trader_strategies
      (id, name, asset_class, tier, status, params_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    'momentum-stocks',
    'Momentum',
    'stocks',
    0,
    'active',
    JSON.stringify({ basket: ['AAPL', 'MSFT', 'SPY', 'QQQ'], lookback_long: 252, lookback_short: 22 }),
    now,
    now,
  )
}

/**
 * Seed the mean-reversion equity strategy row. Phase 2 Task 6 added
 * this generator engine-side; the brain poller routes those candidates
 * through the strategy id 'mean-reversion-stocks'.
 */
export function seedMeanReversionStrategy(db: Database.Database): void {
  const now = Date.now()
  db.prepare(`
    INSERT OR IGNORE INTO trader_strategies
      (id, name, asset_class, tier, status, params_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    'mean-reversion-stocks',
    'Mean Reversion',
    'stocks',
    0,
    'active',
    JSON.stringify({
      basket: ['AAPL', 'MSFT', 'SPY', 'QQQ'],
      bb_window: 20, bb_k: 2.0, rsi_window: 14, rsi_oversold: 30,
    }),
    now,
    now,
  )
}

/**
 * Seed the 24/7 crypto momentum strategy row. Phase 2 Task 7. Stays
 * dormant until the engine has `crypto_enabled=true` and begins
 * emitting 'momentum-crypto' candidates. Tier 0 so the approval card
 * continues to gate on the operator before any live order.
 */
export function seedCryptoMomentumStrategy(db: Database.Database): void {
  const now = Date.now()
  const params = JSON.stringify({
    basket: ['BTC/USD'],
    bar_timeframe: '1d',
    lookback_high: 20,
    breakout_return_days: 7,
    horizon_days: 14,
    min_score: 0.05,
    signal_poll_minutes: 15,
  })
  db.prepare(`
    INSERT INTO trader_strategies
      (id, name, asset_class, tier, status, params_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      name=excluded.name,
      asset_class=excluded.asset_class,
      params_json=excluded.params_json,
      updated_at=excluded.updated_at
  `).run(
    'momentum-crypto',
    'Crypto Momentum',
    'crypto',
    0,
    'paused',
    params,
    now,
    now,
  )
}

/** Frozen BTC/USD hourly pullback strategy used by the v2 paper cohort. */
export function seedCryptoHourlyMeanReversionStrategy(db: Database.Database): void {
  const now = Date.now()
  db.prepare(`
    INSERT OR IGNORE INTO trader_strategies
      (id, name, asset_class, tier, status, params_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    'mean-reversion-hourly-crypto',
    'Bitcoin Hourly Pullback',
    'crypto',
    0,
    'paused',
    JSON.stringify({
      basket: ['BTC/USD'],
      bar_timeframe: '1h',
      rsi_window: 14,
      rsi_oversold: 35,
      ema_trend_window: 200,
      freefall_window_hours: 24,
      freefall_floor: -0.08,
      horizon_days: 1,
      min_score: 0.05,
      signal_poll_minutes: 15,
    }),
    now,
    now,
  )
}

/** Frozen BTC/USD four-hour trend candidate; paused until cohort activation. */
export function seedCryptoFourHourTrendStrategy(db: Database.Database): void {
  const now = Date.now()
  db.prepare(`
    INSERT OR IGNORE INTO trader_strategies
      (id, name, asset_class, tier, status, params_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    'trend-4h-crypto',
    'Bitcoin 4H Trend',
    'crypto',
    0,
    'paused',
    JSON.stringify({
      basket: ['BTC/USD'], bar_timeframe: '4h', fast_ema: 20, slow_ema: 100,
      breakout_bars: 20, return_bars: 6, slow_slope_bars: 6,
      score_bars: 138, min_return: 0.014, min_score: 0.05, horizon_days: 7,
      signal_poll_minutes: 15,
    }),
    now,
    now,
  )
}

/**
 * Predeclared Bitcoin microstructure research family. This is intentionally
 * non-executable: no engine candidate or cohort may exist until its frozen
 * forward-data protocol passes. Seeding it paused makes that boundary visible.
 */
export function seedBitcoinOrderFlowResearchFamily(db: Database.Database): void {
  const now = Date.now()
  db.prepare(`
    INSERT OR IGNORE INTO trader_strategies
      (id, name, asset_class, tier, status, params_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    'order-flow-imbalance-crypto',
    'Bitcoin Order-Flow Imbalance Research',
    'crypto',
    0,
    'paused',
    JSON.stringify({
      basket: ['BTC/USD'],
      family: 'microstructure-order-flow',
      declaration_version: 1,
      research_status: 'predeclared',
      engine_candidate_enabled: false,
      data_mode: 'forward-only',
      decision_bar_minutes: 15,
      forecast_horizon_minutes: 60,
      minimum_forward_days: 180,
      minimum_oos_trades: 100,
      fee_bps_per_side: 25,
      slippage_bps_per_side: 10,
      holdout_uses: 1,
    }),
    now,
    now,
  )
}

/** Seed every known strategy. Idempotent. */
export function seedAllStrategies(db: Database.Database): void {
  seedMomentumStrategy(db)
  seedMeanReversionStrategy(db)
  seedCryptoMomentumStrategy(db)
  seedCryptoHourlyMeanReversionStrategy(db)
  seedCryptoFourHourTrendStrategy(db)
  seedBitcoinOrderFlowResearchFamily(db)
}

export function getStrategy(db: Database.Database, id: string): Strategy | null {
  return db.prepare('SELECT * FROM trader_strategies WHERE id = ?').get(id) as Strategy | null
}

export function updateStrategyTier(db: Database.Database, id: string, tier: number): void {
  db.prepare('UPDATE trader_strategies SET tier = ?, updated_at = ? WHERE id = ?').run(tier, Date.now(), id)
}

export function getActiveStrategies(db: Database.Database): Strategy[] {
  return db.prepare("SELECT * FROM trader_strategies WHERE status = 'active'").all() as Strategy[]
}
