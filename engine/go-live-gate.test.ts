import { describe, it, expect, beforeEach, vi } from 'vitest'
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
        order({ client_order_id: 'c1', broker_order_id: 'b1', side: 'buy', filled_qty: 10, filled_avg_price: 100, updated_at: 1 }),
        // partial snapshot of the SAME buy order: must dedup, not double-count
        order({ client_order_id: 'c1', broker_order_id: 'b1', side: 'buy', filled_qty: 5, filled_avg_price: 100, updated_at: 1, status: 'partially_filled' }),
        order({ client_order_id: 'c2', broker_order_id: 'b2', side: 'sell', filled_qty: 10, filled_avg_price: 110, updated_at: 2 }),
        order({ client_order_id: 'c3', broker_order_id: 'b3', side: 'buy', filled_avg_price: 50, updated_at: 3, status: 'placed', filled_qty: 0 }),
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
      order({ client_order_id: 'g1', broker_order_id: 'b1', side: 'buy', filled_qty: 10, filled_avg_price: 100, updated_at: 1 }),
      order({ client_order_id: 'g2', broker_order_id: 'b2', side: 'sell', filled_qty: 10, filled_avg_price: 110, updated_at: 2 }),
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

  it('keeps the degradation criterion blocked when the backtest is unreachable', async () => {
    // Fail-closed is the whole safety property here: an unreachable backtest
    // must never read as a passing one. Before the simulator existed this
    // criterion was a hardcoded false, so the failure mode is well trodden.
    const client = mockClient([])
    ;(client as any).getMomentumBacktest = vi.fn().mockRejectedValue(new Error('engine down'))

    const r = await runGoLiveGate(db, client, 1_000_000)
    const deg = r.criteria.find(c => c.name === 'live_vs_backtest_degradation')
    expect(deg?.passed).toBe(false)
    expect(r.passed).toBe(false)
    expect(r.backtest ?? null).toBeNull()
  })

  it('keeps the criterion blocked when the backtest returns a null Sharpe', async () => {
    // null means "fewer than two trades closed", i.e. no answer. Coercing it
    // to 0 would be inventing a verdict.
    const client = mockClient([])
    ;(client as any).getMomentumBacktest = vi.fn().mockResolvedValue({
      strategy: 'momentum', n_trades: 1, sharpe: null, max_drawdown: null,
      win_rate: null, start: '2021-01-01', end: '2026-01-01', min_score: 0.7,
      warnings: ['thin'], method: 'm', expectancy: null, total_return: 0,
      slippage_bps: 5, sharpe_convention: 'x', assets: [], computed_at_ms: 1, elapsed_ms: 1,
    })

    const r = await runGoLiveGate(db, client, 1_000_000)
    const deg = r.criteria.find(c => c.name === 'live_vs_backtest_degradation')
    expect(deg?.passed).toBe(false)
  })

  it('persists the backtest snapshot so the report can explain the criterion', async () => {
    const client = mockClient([])
    ;(client as any).getMomentumBacktest = vi.fn().mockResolvedValue({
      strategy: 'momentum', n_trades: 89, sharpe: 2.71, max_drawdown: 0.298,
      win_rate: 0.607, start: '2021-05-17', end: '2026-07-31', min_score: 0.7,
      warnings: [], method: 'm', expectancy: 0.0096, total_return: 1.04,
      slippage_bps: 5, sharpe_convention: 'x', assets: ['SPY'], computed_at_ms: 1, elapsed_ms: 1,
    })

    const r = await runGoLiveGate(db, client, 1_000_000)
    expect(r.backtest?.sharpe).toBe(2.71)
    expect(r.backtest?.n_trades).toBe(89)
    expect(readLastGateResult(db)?.backtest?.max_drawdown).toBeCloseTo(0.298)
  })

  it('accumulates regimes across runs', async () => {
    const client = mockClient([])
    await runGoLiveGate(db, client, 1)
    const seen = db.prepare("SELECT value FROM kv_settings WHERE key='trader.gate.regimes_seen'").get() as { value: string }
    expect(JSON.parse(seen.value)).toEqual(['sideways'])
  })
})
