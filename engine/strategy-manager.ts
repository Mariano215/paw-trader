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
  db.prepare(`
    INSERT OR IGNORE INTO trader_strategies
      (id, name, asset_class, tier, status, params_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    'momentum-crypto',
    'Crypto Momentum',
    'crypto',
    0,
    'active',
    JSON.stringify({
      basket: ['BTC/USD', 'ETH/USD'],
      lookback_high: 30, breakout_return_days: 7, horizon_days: 14,
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
