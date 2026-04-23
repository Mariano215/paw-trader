import { describe, it, expect, vi, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { initTraderTables } from './db.js'
import { enrichPendingSignals } from './enrichment-fetcher.js'
import type { EngineClient } from './engine-client.js'

function makeDb() {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = OFF')
  initTraderTables(db)
  return db
}

function insertSignal(db: Database.Database, id: string, asset: string, enrichment: string | null = null) {
  db.prepare(`
    INSERT INTO trader_signals (id, strategy_id, asset, side, raw_score, horizon_days, enrichment_json, generated_at, status)
    VALUES (?, 'momentum-stocks', ?, 'buy', 0.72, 14, ?, ?, 'pending')
  `).run(id, asset, enrichment, Date.now())
}

function makePrices(closes: number[]) {
  return closes.map((close, i) => ({
    date: `2026-03-${String(i + 1).padStart(2, '0')}`,
    close,
    ts_ms: Date.now() - (closes.length - i) * 86400000,
  }))
}

function makeClient(priceMap: Record<string, number[]>): Pick<EngineClient, 'getPrices'> {
  return {
    getPrices: vi.fn(async (asset: string) => {
      const closes = priceMap[asset] ?? []
      return makePrices(closes)
    }),
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
    insertSignal(db, 'sig-a', 'AAPL')
    insertSignal(db, 'sig-b', 'AAPL')
    const closes = Array.from({ length: 20 }, (_, i) => 150 + i)
    const client = makeClient({ AAPL: closes })

    const count = await enrichPendingSignals(db, client as unknown as EngineClient)
    expect(count).toBe(2)
    expect(vi.mocked(client.getPrices)).toHaveBeenCalledTimes(1)  // fetched once
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
