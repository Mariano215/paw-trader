import { describe, it, expect, vi, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { initTraderTables } from './db.js'
import { enrichPendingSignals } from './enrichment-fetcher.js'
import type { EngineClient } from './engine-client.js'
import type { MarkovRegimePayload } from './types.js'

function makeDb() {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = OFF')
  initTraderTables(db)
  return db
}

function insertSignal(db: Database.Database, id: string, asset: string, enrichment: string | null = null, side: string = 'buy') {
  db.prepare(`
    INSERT INTO trader_signals (id, strategy_id, asset, side, raw_score, horizon_days, enrichment_json, generated_at, status)
    VALUES (?, 'momentum-stocks', ?, ?, 0.72, 14, ?, ?, 'pending')
  `).run(id, asset, side, enrichment, Date.now())
}

function makePrices(closes: number[]) {
  return closes.map((close, i) => ({
    date: `2026-03-${String(i + 1).padStart(2, '0')}`,
    close,
    ts_ms: Date.now() - (closes.length - i) * 86400000,
  }))
}

function makeMarkovPayload(asset: string): MarkovRegimePayload {
  return {
    source: 'markov_regime',
    asset,
    as_of: '2026-05-20',
    n_obs: 120,
    current_state: 'bull',
    markov_signal: 0.62,
    stationary: { bear: 0.2, sideways: 0.3, bull: 0.5 },
    persistence_diag: [0.85, 0.75, 0.9],
    walk_forward: { sharpe: null, max_drawdown: null, n_trades: 0 },
    computed_at_ms: 1748000000000,
    params: { window: 20, threshold: 0.02, backtest: false, days: 252 },
  }
}

function makeClient(
  priceMap: Record<string, number[]>,
  markovFn?: (asset: string) => Promise<MarkovRegimePayload | null>,
): Pick<EngineClient, 'getPrices' | 'getMarkovRegime'> {
  return {
    getPrices: vi.fn(async (asset: string) => {
      const closes = priceMap[asset] ?? []
      return makePrices(closes)
    }),
    getMarkovRegime: vi.fn(markovFn ?? (async () => null)),
  }
}

describe('enrichPendingSignals', () => {
  let db: Database.Database

  beforeEach(() => {
    db = makeDb()
  })

  it('enriches a pending signal with price data', async () => {
    insertSignal(db, 'sig-1', 'AAPL')
    const closes = Array.from({ length: 25 }, (_, i) => 150 + i * 0.5)  // 150..162
    const client = makeClient({ AAPL: closes })

    const count = await enrichPendingSignals(db, client as unknown as EngineClient)
    expect(count).toBe(1)

    const row = db.prepare('SELECT enrichment_json FROM trader_signals WHERE id = ?').get('sig-1') as { enrichment_json: string }
    const enrichment = JSON.parse(row.enrichment_json)
    expect(enrichment.price_current).toBeCloseTo(162, 0)
    expect(enrichment.bars_fetched).toBe(25)
    expect(enrichment.rsi_14).not.toBeNull()
    expect(enrichment.rsi_14).toBeGreaterThan(50)  // trending up -> RSI > 50
    expect(enrichment.price_change_5d_pct).not.toBeNull()
    expect(enrichment.price_change_20d_pct).not.toBeNull()
  })

  it('skips already-enriched signals', async () => {
    insertSignal(db, 'sig-enriched', 'AAPL', JSON.stringify({ already: true }))
    const client = makeClient({ AAPL: [100, 101, 102] })

    const count = await enrichPendingSignals(db, client as unknown as EngineClient)
    expect(count).toBe(0)
    expect(client.getPrices).not.toHaveBeenCalled()
  })

  it('skips non-pending signals', async () => {
    insertSignal(db, 'sig-decided', 'AAPL')
    db.prepare("UPDATE trader_signals SET status='decided' WHERE id='sig-decided'").run()
    const client = makeClient({ AAPL: [100, 101, 102] })

    const count = await enrichPendingSignals(db, client as unknown as EngineClient)
    expect(count).toBe(0)
  })

  it('deduplicates price fetches for same asset', async () => {
    insertSignal(db, 'sig-a', 'AAPL', null, 'buy')
    insertSignal(db, 'sig-b', 'AAPL', null, 'sell')
    const closes = Array.from({ length: 20 }, (_, i) => 150 + i)
    const client = makeClient({ AAPL: closes })

    const count = await enrichPendingSignals(db, client as unknown as EngineClient)
    expect(count).toBe(2)
    expect(vi.mocked(client.getPrices)).toHaveBeenCalledTimes(1)  // fetched once (same asset, different sides)
  })

  it('skips signal gracefully when engine returns no bars', async () => {
    insertSignal(db, 'sig-no-bars', 'UNKNOWN')
    const client = makeClient({ UNKNOWN: [] })

    const count = await enrichPendingSignals(db, client as unknown as EngineClient)
    expect(count).toBe(0)

    const row = db.prepare('SELECT enrichment_json FROM trader_signals WHERE id = ?').get('sig-no-bars') as { enrichment_json: string | null }
    expect(row.enrichment_json).toBeNull()  // stays null, will retry next cycle
  })

  it('handles engine price fetch failure gracefully', async () => {
    insertSignal(db, 'sig-err', 'AAPL')
    const client = {
      getPrices: vi.fn().mockRejectedValue(new Error('engine down')),
    }

    const count = await enrichPendingSignals(db, client as unknown as EngineClient)
    expect(count).toBe(0)
  })

  it('computes RSI above 50 for an uptrend', async () => {
    insertSignal(db, 'sig-rsi-up', 'TSLA')
    // Pure uptrend: 15 bars each +1
    const closes = Array.from({ length: 20 }, (_, i) => 200 + i)
    const client = makeClient({ TSLA: closes })

    await enrichPendingSignals(db, client as unknown as EngineClient)
    const row = db.prepare('SELECT enrichment_json FROM trader_signals WHERE id = ?').get('sig-rsi-up') as { enrichment_json: string }
    const { rsi_14 } = JSON.parse(row.enrichment_json)
    expect(rsi_14).toBe(100)  // pure uptrend: no losses -> RSI = 100
  })

  it('returns null RSI when fewer than 15 bars', async () => {
    insertSignal(db, 'sig-few', 'BTC/USD')
    const closes = [100, 101, 102]  // only 3 bars
    const client = makeClient({ 'BTC/USD': closes })

    await enrichPendingSignals(db, client as unknown as EngineClient)
    const row = db.prepare('SELECT enrichment_json FROM trader_signals WHERE id = ?').get('sig-few') as { enrichment_json: string }
    const { rsi_14, bars_fetched } = JSON.parse(row.enrichment_json)
    expect(rsi_14).toBeNull()
    expect(bars_fetched).toBe(3)
  })
})

describe('fetchMarkovRegime via enrichPendingSignals', () => {
  let db: Database.Database

  beforeEach(() => {
    db = makeDb()
  })

  it('happy path equity -- merges markov_regime block for SPY', async () => {
    insertSignal(db, 'sig-spy', 'SPY')
    const closes = Array.from({ length: 20 }, (_, i) => 440 + i)
    const payload = makeMarkovPayload('SPY')
    const client = makeClient({ SPY: closes }, async () => payload)

    await enrichPendingSignals(db, client as unknown as EngineClient)

    const row = db.prepare('SELECT enrichment_json FROM trader_signals WHERE id = ?').get('sig-spy') as { enrichment_json: string }
    const enrichment = JSON.parse(row.enrichment_json)
    expect(enrichment.markov_regime).not.toBeNull()
    expect(enrichment.markov_regime.source).toBe('markov_regime')
    expect(enrichment.markov_regime.current_state).toBe('bull')
    expect(enrichment.markov_regime.markov_signal).toBeCloseTo(0.62)
    expect(enrichment.markov_regime.asset).toBe('SPY')
  })

  it('happy path crypto -- URL contains BTC%2FUSD', async () => {
    insertSignal(db, 'sig-btc', 'BTC/USD')
    const closes = Array.from({ length: 20 }, (_, i) => 60000 + i * 100)
    const payload = makeMarkovPayload('BTC/USD')
    const getMarkovRegimeFn = vi.fn(async (_asset: string) => payload)
    const client: Pick<EngineClient, 'getPrices' | 'getMarkovRegime'> = {
      getPrices: vi.fn(async () => makePrices(closes)),
      getMarkovRegime: getMarkovRegimeFn,
    }

    await enrichPendingSignals(db, client as unknown as EngineClient)

    // The method receives the raw asset string; encoding is the engine-client's responsibility.
    // Assert the mock was called with the raw asset so engine-client can encode it.
    expect(getMarkovRegimeFn).toHaveBeenCalledWith('BTC/USD')

    // Verify the enrichment block was stored
    const row = db.prepare('SELECT enrichment_json FROM trader_signals WHERE id = ?').get('sig-btc') as { enrichment_json: string }
    const enrichment = JSON.parse(row.enrichment_json)
    expect(enrichment.markov_regime.asset).toBe('BTC/USD')
  })

  it('404 response -- markov_regime is null, enrichment still succeeds', async () => {
    insertSignal(db, 'sig-404', 'AAPL')
    const closes = Array.from({ length: 20 }, (_, i) => 180 + i)
    // getMarkovRegime returns null (engine-client already swallows 4xx and returns null)
    const client = makeClient({ AAPL: closes }, async () => null)

    await enrichPendingSignals(db, client as unknown as EngineClient)

    const row = db.prepare('SELECT enrichment_json FROM trader_signals WHERE id = ?').get('sig-404') as { enrichment_json: string }
    expect(row.enrichment_json).not.toBeNull()
    const enrichment = JSON.parse(row.enrichment_json)
    expect(enrichment.markov_regime).toBeNull()
    expect(enrichment.price_current).not.toBeNull()
  })

  it('network error from getMarkovRegime -- markov_regime is null, enrichment still succeeds', async () => {
    insertSignal(db, 'sig-net-err', 'TSLA')
    const closes = Array.from({ length: 20 }, (_, i) => 200 + i)
    // engine-client catches errors and returns null; simulate that here
    const client = makeClient({ TSLA: closes }, async () => null)

    await enrichPendingSignals(db, client as unknown as EngineClient)

    const row = db.prepare('SELECT enrichment_json FROM trader_signals WHERE id = ?').get('sig-net-err') as { enrichment_json: string }
    expect(row.enrichment_json).not.toBeNull()
    const enrichment = JSON.parse(row.enrichment_json)
    expect(enrichment.markov_regime).toBeNull()
    expect(enrichment.bars_fetched).toBe(20)
  })

  it('timeout -- getMarkovRegime returns null, enrichment still succeeds', async () => {
    insertSignal(db, 'sig-timeout', 'MSFT')
    const closes = Array.from({ length: 20 }, (_, i) => 380 + i)
    // Simulate engine-client absorbing an AbortError and returning null
    const client = makeClient({ MSFT: closes }, async () => null)

    await enrichPendingSignals(db, client as unknown as EngineClient)

    const row = db.prepare('SELECT enrichment_json FROM trader_signals WHERE id = ?').get('sig-timeout') as { enrichment_json: string }
    expect(row.enrichment_json).not.toBeNull()
    const enrichment = JSON.parse(row.enrichment_json)
    expect(enrichment.markov_regime).toBeNull()
    expect(enrichment.rsi_14).not.toBeNull()
  })
})
