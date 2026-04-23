import { describe, it, expect, beforeEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import { initTraderTables } from './db.js'
import { seedAllStrategies, seedMomentumStrategy } from './strategy-manager.js'
import {
  pollAndStoreSignals,
  getPendingSignals,
  resolveStrategyId,
  isEquityMarketHours,
} from './signal-poller.js'
import type { EngineClient } from './engine-client.js'

function makeDb() {
  const db = new Database(':memory:')
  initTraderTables(db)
  seedAllStrategies(db)
  return db
}

const makeCandidate = (
  asset: string,
  score: number,
  strategy = 'momentum',
  horizon = 20,
) => ({
  id: `sig-${asset}-${strategy}`,
  strategy,
  asset,
  side: 'buy' as const,
  raw_score: score,
  horizon_days: horizon,
  generated_at: Date.now(),
})

describe('signal-poller', () => {
  let db: ReturnType<typeof makeDb>
  let mockClient: Partial<EngineClient>

  beforeEach(() => {
    db = makeDb()
    mockClient = { getSignals: vi.fn() }
  })

  it('stores signals above threshold', async () => {
    vi.mocked(mockClient.getSignals!).mockResolvedValue([makeCandidate('AAPL', 0.72)])
    await pollAndStoreSignals(db, mockClient as EngineClient)
    const pending = getPendingSignals(db)
    expect(pending).toHaveLength(1)
    expect(pending[0].asset).toBe('AAPL')
  })

  it('filters signals below threshold (abs < 0.05)', async () => {
    vi.mocked(mockClient.getSignals!).mockResolvedValue([makeCandidate('MSFT', 0.03)])
    await pollAndStoreSignals(db, mockClient as EngineClient)
    expect(getPendingSignals(db)).toHaveLength(0)
  })

  it('stores mild momentum signals that clear the engine-aligned floor', async () => {
    vi.mocked(mockClient.getSignals!).mockResolvedValue([makeCandidate('MSFT', 0.3)])
    await pollAndStoreSignals(db, mockClient as EngineClient)
    const pending = getPendingSignals(db)
    expect(pending).toHaveLength(1)
    expect(pending[0].asset).toBe('MSFT')
  })

  it('does not duplicate already-stored signal ids', async () => {
    const candidate = makeCandidate('AAPL', 0.72)
    vi.mocked(mockClient.getSignals!).mockResolvedValue([candidate])
    await pollAndStoreSignals(db, mockClient as EngineClient)
    await pollAndStoreSignals(db, mockClient as EngineClient)
    expect(getPendingSignals(db)).toHaveLength(1)
  })

  it('handles engine client errors gracefully', async () => {
    vi.mocked(mockClient.getSignals!).mockRejectedValue(new Error('network'))
    await expect(pollAndStoreSignals(db, mockClient as EngineClient)).resolves.not.toThrow()
  })

  it('routes crypto pair candidates to the momentum-crypto strategy', async () => {
    vi.mocked(mockClient.getSignals!).mockResolvedValue([
      makeCandidate('BTC/USD', 0.7, 'momentum-crypto', 14),
    ])
    await pollAndStoreSignals(db, mockClient as EngineClient)
    const pending = getPendingSignals(db)
    expect(pending).toHaveLength(1)
    expect(pending[0].asset).toBe('BTC/USD')
    expect(pending[0].strategy_id).toBe('momentum-crypto')
  })

  it('routes mean-reversion equity candidates to mean-reversion-stocks', async () => {
    vi.mocked(mockClient.getSignals!).mockResolvedValue([
      makeCandidate('AAPL', 0.8, 'mean-reversion', 10),
    ])
    await pollAndStoreSignals(db, mockClient as EngineClient)
    const pending = getPendingSignals(db)
    expect(pending).toHaveLength(1)
    expect(pending[0].strategy_id).toBe('mean-reversion-stocks')
  })

  it('stores equity momentum candidates as momentum-stocks (back-compat)', async () => {
    vi.mocked(mockClient.getSignals!).mockResolvedValue([
      makeCandidate('MSFT', 0.9, 'momentum', 20),
    ])
    await pollAndStoreSignals(db, mockClient as EngineClient)
    const pending = getPendingSignals(db)
    expect(pending).toHaveLength(1)
    expect(pending[0].strategy_id).toBe('momentum-stocks')
  })

  it('deduplicates same asset+side across different strategy names in one batch', async () => {
    const candidates = [
      { id: 'a1', strategy: 'momentum-stocks',    asset: 'AAPL', side: 'buy' as const, raw_score: 0.8, horizon_days: 3, generated_at: Date.now() },
      { id: 'a2', strategy: 'mean-reversion',     asset: 'AAPL', side: 'buy' as const, raw_score: 0.8, horizon_days: 3, generated_at: Date.now() },
      { id: 'a3', strategy: 'momentum-crypto',    asset: 'AAPL', side: 'buy' as const, raw_score: 0.8, horizon_days: 3, generated_at: Date.now() },
    ]
    vi.mocked(mockClient.getSignals!).mockResolvedValue(candidates)
    await pollAndStoreSignals(db, mockClient as EngineClient)
    const rows = db.prepare("SELECT * FROM trader_signals WHERE asset='AAPL' AND side='buy'").all()
    expect(rows).toHaveLength(1)
  })

  it('deduplicates same asset+side across sequential poll cycles (different strategy IDs)', async () => {
    vi.mocked(mockClient.getSignals!).mockResolvedValueOnce([
      { id: 'b1', strategy: 'momentum', asset: 'AAPL', side: 'buy' as const, raw_score: 0.8, horizon_days: 3, generated_at: Date.now() },
    ])
    await pollAndStoreSignals(db, mockClient as EngineClient)

    vi.mocked(mockClient.getSignals!).mockResolvedValueOnce([
      { id: 'b2', strategy: 'mean-reversion', asset: 'AAPL', side: 'buy' as const, raw_score: 0.9, horizon_days: 3, generated_at: Date.now() },
    ])
    await pollAndStoreSignals(db, mockClient as EngineClient)

    const rows = db.prepare("SELECT * FROM trader_signals WHERE asset='AAPL' AND side='buy'").all()
    expect(rows).toHaveLength(1)
  })

  it('drops equity signals outside market hours but passes crypto', async () => {
    const saturdayMs = new Date('2026-04-18T15:00:00Z').getTime()
    const candidates: Parameters<typeof pollAndStoreSignals>[1]['getSignals'] extends (...args: any[]) => Promise<infer T> ? T : never = [
      { id: 'eq1', strategy: 'momentum', asset: 'NVDA', side: 'buy' as const, raw_score: 0.8, horizon_days: 3, generated_at: saturdayMs },
      { id: 'cr1', strategy: 'momentum', asset: 'BTC/USD', side: 'buy' as const, raw_score: 0.8, horizon_days: 1, generated_at: saturdayMs },
    ]
    vi.mocked(mockClient.getSignals!).mockResolvedValue(candidates)
    await pollAndStoreSignals(db, mockClient as EngineClient)
    const equity = db.prepare("SELECT * FROM trader_signals WHERE asset='NVDA'").all()
    const crypto = db.prepare("SELECT * FROM trader_signals WHERE asset='BTC/USD'").all()
    expect(equity).toHaveLength(0)
    expect(crypto).toHaveLength(1)
  })
})

describe('isEquityMarketHours', () => {
  it('returns true for 10:00 ET on a Tuesday', () => {
    // 2026-04-21 (Tuesday) 10:00 ET = 14:00 UTC
    const ts = new Date('2026-04-21T14:00:00Z').getTime()
    expect(isEquityMarketHours(ts)).toBe(true)
  })
  it('returns false for 08:00 ET before open', () => {
    const ts = new Date('2026-04-21T12:00:00Z').getTime()
    expect(isEquityMarketHours(ts)).toBe(false)
  })
  it('returns false for Saturday', () => {
    const ts = new Date('2026-04-18T15:00:00Z').getTime()
    expect(isEquityMarketHours(ts)).toBe(false)
  })
  it('returns true for exactly 09:30 ET (inclusive open)', () => {
    // 2026-04-21 09:30 ET = 13:30 UTC
    const ts = new Date('2026-04-21T13:30:00Z').getTime()
    expect(isEquityMarketHours(ts)).toBe(true)
  })
  it('returns false for exactly 16:00 ET (exclusive close)', () => {
    // 2026-04-21 16:00 ET = 20:00 UTC
    const ts = new Date('2026-04-21T20:00:00Z').getTime()
    expect(isEquityMarketHours(ts)).toBe(false)
  })
})

describe('resolveStrategyId', () => {
  it('appends -stocks for bare equity strategies', () => {
    expect(resolveStrategyId('momentum', 'AAPL')).toBe('momentum-stocks')
    expect(resolveStrategyId('mean-reversion', 'SPY')).toBe('mean-reversion-stocks')
  })

  it('appends -crypto for bare strategies with a pair asset', () => {
    expect(resolveStrategyId('momentum', 'BTC/USD')).toBe('momentum-crypto')
  })

  it('passes through strategies that already encode an asset class', () => {
    expect(resolveStrategyId('momentum-crypto', 'BTC/USD')).toBe('momentum-crypto')
    expect(resolveStrategyId('mean-reversion-stocks', 'AAPL')).toBe('mean-reversion-stocks')
  })
})
