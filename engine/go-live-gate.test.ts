import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { initTraderTables } from './db.js'
import { seedMomentumStrategy } from './strategy-manager.js'
import type { EngineClient } from './engine-client.js'
import { computeBrokerTruth, runGoLiveGate, readLastGateResult, gateRunDue, renderGateSummary } from './go-live-gate.js'

function makeDb() {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = OFF')
  initTraderTables(db)
  seedMomentumStrategy(db)
  return db
}

const order = (over: Record<string, unknown>) => ({
  client_order_id: 'c1',
  broker_order_id: 'b1',
  decision_id: null,
  asset: 'SPY',
  side: 'buy',
  qty: 10,
  order_type: 'market',
  limit_price: null,
  status: 'filled',
  filled_qty: 10,
  filled_avg_price: 100,
  source: 'test',
  created_at: 1,
  updated_at: 1,
  ...over,
})

function mockClient(orders: unknown[], positions: unknown[] = []): EngineClient {
  return {
    getOrders: async () => orders,
    getPositions: async () => positions,
    getNavSnapshots: async () => [
      { date: '2026-06-01', period: 'day_close', nav: 100000, recorded_at: 1 },
      { date: '2026-06-02', period: 'day_close', nav: 100100, recorded_at: 2 },
    ],
    getMarkovRegime: async () => ({ current_state: 'sideways' }),
  } as unknown as EngineClient
}

describe('computeBrokerTruth', () => {
  it('FIFO-matches engine filled orders into realized round-trips', async () => {
    const client = mockClient(
      [
        order({ broker_order_id: 'b1', side: 'buy', filled_qty: 10, filled_avg_price: 100, updated_at: 1 }),
        order({ broker_order_id: 'b2', side: 'sell', filled_qty: 10, filled_avg_price: 110, updated_at: 2 }),
        order({ broker_order_id: 'b3', side: 'buy', filled_avg_price: 50, updated_at: 3, status: 'placed', filled_qty: 0 }),
      ],
      [{ asset: 'QQQ', qty: 2, unrealized_pnl: -7.5, market_value: 1000 }],
    )
    const t = await computeBrokerTruth(client)
    expect(t.roundTrips).toBe(1)
    expect(t.realizedTotal).toBeCloseTo(100) // (110-100)*10
    expect(t.openUnrealized).toBeCloseTo(-7.5)
    expect(t.perAsset[0]).toEqual({ asset: 'SPY', roundTrips: 1, realized: 100 })
  })

  it('ignores unfilled orders entirely', async () => {
    const t = await computeBrokerTruth(mockClient([order({ status: 'placed', filled_qty: 0 })]))
    expect(t.roundTrips).toBe(0)
    expect(t.realizedTotal).toBe(0)
  })
})

describe('runGoLiveGate', () => {
  let db: ReturnType<typeof makeDb>
  beforeEach(() => { db = makeDb() })

  it('fails the gate on a thin record and persists the result', async () => {
    const client = mockClient([
      order({ broker_order_id: 'b1', side: 'buy', filled_qty: 10, filled_avg_price: 100, updated_at: 1 }),
      order({ broker_order_id: 'b2', side: 'sell', filled_qty: 10, filled_avg_price: 110, updated_at: 2 }),
    ])
    const r = await runGoLiveGate(db, client, 1_000_000)
    expect(r.passed).toBe(false) // 1 trade vs 100 floor, 1 regime, no backtest
    expect(r.roundTrips).toBe(1)
    const stored = readLastGateResult(db)
    expect(stored?.passed).toBe(false)
    expect(stored?.evaluatedAt).toBe(1_000_000)
    // run is stamped: not due again immediately
    expect(gateRunDue(db, 1_000_001)).toBe(false)
    expect(gateRunDue(db, 1_000_000 + 8 * 24 * 3600 * 1000)).toBe(true)
    // summary renders blockers, plain text, no dashes
    const summary = renderGateSummary(r)
    expect(summary).toContain('Go-live gate')
    expect(summary).toContain('Blockers:')
    expect(summary).not.toMatch(/—/)
  })

  it('accumulates regimes across runs', async () => {
    const client = mockClient([])
    await runGoLiveGate(db, client, 1)
    const seen = db.prepare("SELECT value FROM kv_settings WHERE key='trader.gate.regimes_seen'").get() as { value: string }
    expect(JSON.parse(seen.value)).toEqual(['sideways'])
  })
})
