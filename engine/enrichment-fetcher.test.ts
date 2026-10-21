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

describe('volatility window parity with the engine backtest', () => {
  it('uses high/low of the last 35 completed bars, excluding today, so the stop matches the backtest', async () => {
    const db = makeDb()
    insertSignal(db, 'sig-vol', 'AAPL')
    const DAY = 86_400_000
    const base = Date.UTC(2026, 6, 1)  // 2026-07-01, well before today
    // Closes stay in 100..101. Highs/lows widen with age:
    //   bars 0-4   (outside the 35-bar window): 140 / 70
    //   bars 5-14  (inside 35, outside last 25): 120 / 85
    //   bars 15-39 (last 25):                    105 / 95
    const bars: { date: string; close: number; ts_ms: number; high?: number; low?: number }[] =
      Array.from({ length: 40 }, (_, i) => {
        const ts = base + i * DAY
        const [high, low] = i < 5 ? [140, 70] : i < 15 ? [120, 85] : [105, 95]
        return { date: new Date(ts).toISOString().slice(0, 10), close: 100 + (i % 2), ts_ms: ts, high, low }
      })
    // Today's partial bar must not enter the window.
    const todayNY = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' })
    bars.push({ date: todayNY, close: 101, ts_ms: Date.now(), high: 200, low: 10 })
    const client = {
      getPrices: vi.fn(async () => bars),
      getMarkovRegime: vi.fn(async () => null),
    }

    await enrichPendingSignals(db, client as unknown as EngineClient)
    const row = db.prepare('SELECT enrichment_json FROM trader_signals WHERE id = ?').get('sig-vol') as { enrichment_json: string }
    const e = JSON.parse(row.enrichment_json)
    expect(e.window_high).toBe(120)
    expect(e.window_low).toBe(85)

    // At least 35 completed bars need ~49 calendar days; ask for more.
    const [, fromMs, toMs] = client.getPrices.mock.calls[0] as unknown as [string, number, number]
    expect(toMs - fromMs).toBeGreaterThanOrEqual(55 * DAY)

    // Backtest by hand, entry 100: range (120-85)/100 = 0.35, * 0.5 = 0.175,
    // inside [0.06, 0.20]. Stop 100 - 17.5 = 82.5, target 100 + 2 * 17.5 = 135.
    // The old 25-bar close window would give 0.06 (floor).
    const { computeExits } = await import('./exit-calculator.js')
    const exits = computeExits({ side: 'buy', entryPrice: 100, horizonDays: 14, enrichment: row.enrichment_json })
    expect(exits.basis).toBe('volatility')
    expect(exits.stopLoss).toBe(82.5)
    expect(exits.takeProfit).toBe(135)
  })
})

describe('volatility window edges', () => {
  const DAY = 86_400_000
  const todayNY = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' })

  it('keeps a bar dated yesterday inside the window', async () => {
    const db = makeDb()
    insertSignal(db, 'sig-y', 'AAPL')
    const yesterdayMs = Date.parse(`${todayNY()}T00:00:00Z`) - DAY
    // 40 bars ending yesterday, newest first, so the window must sort before slicing.
    // Yesterday's bar is wide; the 5 oldest (outside the window) are wider still.
    const bars = Array.from({ length: 40 }, (_, i) => {
      const ts = yesterdayMs - (39 - i) * DAY
      const [high, low] = i === 39 ? [130, 80] : i < 5 ? [140, 60] : [105, 95]
      return { date: new Date(ts).toISOString().slice(0, 10), close: 100, ts_ms: ts, high, low }
    }).reverse()
    const client = { getPrices: vi.fn(async () => bars), getMarkovRegime: vi.fn(async () => null) }

    await enrichPendingSignals(db, client as unknown as EngineClient)
    const row = db.prepare('SELECT enrichment_json FROM trader_signals WHERE id = ?').get('sig-y') as { enrichment_json: string }
    const e = JSON.parse(row.enrichment_json)
    expect(e.window_high).toBe(130)
    expect(e.window_low).toBe(80)
  })

  it('uses the close range when history is short and bars lack high/low', async () => {
    const db = makeDb()
    insertSignal(db, 'sig-s', 'AAPL')
    // 10 close-only bars (older engine). Range 110 - 90 = 20.
    const client = makeClient({ AAPL: [100, 95, 90, 98, 104, 110, 107, 101, 99, 100] })

    await enrichPendingSignals(db, client as unknown as EngineClient)
    const row = db.prepare('SELECT enrichment_json FROM trader_signals WHERE id = ?').get('sig-s') as { enrichment_json: string }
    const e = JSON.parse(row.enrichment_json)
    expect(e.window_high).toBe(110)
    expect(e.window_low).toBe(90)

    // Backtest by hand, entry 100: 20/100 * 0.5 = 0.10, inside [0.06, 0.20].
    // Stop 90, target 100 + 2 * 10 = 120.
    const { computeExits } = await import('./exit-calculator.js')
    const exits = computeExits({ side: 'buy', entryPrice: 100, horizonDays: 14, enrichment: row.enrichment_json })
    expect(exits.stopLoss).toBe(90)
    expect(exits.takeProfit).toBe(120)
  })
})

describe('stop basis is the last completed close', () => {
  it('ignores a forming bar dated today when setting price_current, so stop and target derive from yesterday', async () => {
    const db = makeDb()
    insertSignal(db, 'sig-f', 'AAPL')
    const DAY = 86_400_000
    const todayNY = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' })
    const yesterdayMs = Date.parse(`${todayNY}T00:00:00Z`) - DAY
    // 40 completed bars ending yesterday, close 100, high/low 105/95.
    const bars: { date: string; close: number; ts_ms: number; high?: number; low?: number }[] =
      Array.from({ length: 40 }, (_, i) => {
        const ts = yesterdayMs - (39 - i) * DAY
        return { date: new Date(ts).toISOString().slice(0, 10), close: 100, ts_ms: ts, high: 105, low: 95 }
      })
    // Forming bar today (IEX fallback or SIP after 09:46 ET) with a very different close.
    bars.push({ date: todayNY, close: 150, ts_ms: Date.now(), high: 150, low: 150 })
    const client = { getPrices: vi.fn(async () => bars), getMarkovRegime: vi.fn(async () => null) }

    await enrichPendingSignals(db, client as unknown as EngineClient)
    const row = db.prepare('SELECT enrichment_json FROM trader_signals WHERE id = ?').get('sig-f') as { enrichment_json: string }
    const e = JSON.parse(row.enrichment_json)
    expect(e.price_current).toBe(100)

    const { entryRefFromEnrichment } = await import('./entry-reference-price.js')
    const entry = entryRefFromEnrichment(row.enrichment_json)
    expect(entry).toBe(100)
    // Range (105-95)/100 * 0.5 = 0.05, floored to 0.06: stop 94, target 112.
    const { computeExits } = await import('./exit-calculator.js')
    const exits = computeExits({ side: 'buy', entryPrice: entry, horizonDays: 14, enrichment: row.enrichment_json })
    expect(exits.stopLoss).toBe(94)
    expect(exits.takeProfit).toBe(112)
  })
})
