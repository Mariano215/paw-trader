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
  })

  it('seedAllStrategies is idempotent and covers all three rows', async () => {
    const { seedAllStrategies } = await import('./strategy-manager.js')
    seedAllStrategies(db)
    seedAllStrategies(db)
    const active = getActiveStrategies(db)
    const ids = active.map(s => s.id).sort()
    expect(ids).toEqual(['mean-reversion-stocks', 'momentum-crypto', 'momentum-stocks'])
  })
})
