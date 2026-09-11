import { describe, it, expect, beforeEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import { initTraderTables } from './db.js'
import { seedMomentumStrategy } from './strategy-manager.js'
import type { EngineClient } from './engine-client.js'
import { computeBrokerTruth, runGoLiveGate, readLastGateResult, gateRunDue, renderGateSummary, gateAuthorizesLive, gateConfigFingerprint, GATE_VERSION, GATE_RUN_INTERVAL_MS, refreshAccountingSnapshot, REQUIRED_GATE_CRITERIA } from './go-live-gate.js'

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
  it('counts split exits once and includes canceled partial fills', async () => {
    const truth = await computeBrokerTruth(mockClient([
      order({broker_order_id: 'buy', client_order_id: 'buy', filled_qty: 10}),
      order({broker_order_id: 'sell1', client_order_id: 'sell1', side: 'sell', filled_qty: 4, filled_avg_price: 110, status: 'canceled', updated_at: 2}),
      order({broker_order_id: 'sell2', client_order_id: 'sell2', side: 'sell', filled_qty: 6, filled_avg_price: 120, updated_at: 3}),
    ]))
    expect(truth.realizedLots).toHaveLength(2)
    expect(truth.roundTrips).toBe(1)
    expect(truth.closedReturns).toEqual([0.16])
  })

  it('bridges decision/client ID mismatch using broker ID and preserves recorded fees', async () => {
    const db = makeDb()
    db.prepare(`INSERT INTO trader_fills
      (id, decision_id, client_order_id, broker_order_id, asset, side, fill_qty, fill_price, fill_ts_ms, fee_usd, slippage_usd, recorded_at)
      VALUES ('f', 'decision', 'decision', 'b1', 'SPY', 'buy', 10, 100, 1, 2, 0, 1)`).run()
    const truth = await computeBrokerTruth(mockClient([
      order({updated_at: 10}),
      order({broker_order_id: 'b2', client_order_id: 'c2', side: 'sell', filled_qty: 10, filled_avg_price: 110, updated_at: 2}),
    ]), db)
    expect(truth.realizedTotal).toBe(98)
    expect(truth.roundTrips).toBe(1)
    expect(truth.closedReturns[0]).toBeCloseTo(0.098)
  })

  it('keeps the last snapshot timestamp when a refresh fails', async () => {
    const db = makeDb()
    const client = mockClient([])
    await refreshAccountingSnapshot(db, client, 1000)
    client.getOrders = vi.fn().mockRejectedValue(new Error('offline'))
    await expect(refreshAccountingSnapshot(db, client, 2000)).rejects.toThrow('offline')
    const row = db.prepare("SELECT value FROM kv_settings WHERE key='trader.accounting.last'").get() as {value: string}
    expect(JSON.parse(row.value)).toMatchObject({evaluated_at: 1000, costs_complete: false})
  })
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

  it('excludes autonomous short-cover repairs from strategy P&L', async () => {
    const db = makeDb()
    db.prepare(`INSERT INTO trader_fills
      (id, decision_id, client_order_id, broker_order_id, asset, side, fill_qty, fill_price, fill_ts_ms, fee_usd, slippage_usd, recorded_at)
      VALUES ('repair-fill', 'repair-cover-old', 'repair-cover-old', 'repair-broker-old', 'IWM', 'buy', 3, 200, 1, 0, 0, 1)`).run()
    const t = await computeBrokerTruth(mockClient([
      order({
        asset: 'IWM', source: 'auto-repair', decision_id: 'repair-cover-new',
        client_order_id: 'repair-cover-new', broker_order_id: 'repair-broker-new',
        filled_qty: 3, filled_avg_price: 201,
      }),
    ]), db)
    expect(t.roundTrips).toBe(0)
    expect(t.realizedTotal).toBe(0)
    expect(t.perAsset).toEqual([])
  })

  it('adds fills from trader_fills that the engine order window no longer carries, without double counting', async () => {
    const db = makeDb()
    const ins = db.prepare(`INSERT INTO trader_fills
      (id, decision_id, client_order_id, broker_order_id, asset, side, fill_qty, fill_price, intended_price, intended_ts_ms, fill_ts_ms, fee_usd, slippage_usd, entry_thesis, exit_reason, recorded_at)
      VALUES (?, ?, ?, ?, 'SPY', ?, ?, ?, NULL, NULL, ?, 0, 0, NULL, NULL, ?)`)
    // Old buy + sell, only in the local record (engine window rolled past them).
    ins.run('f1', 'd1', 'old-buy', 'b-old-buy', 'buy', 10, 100, 1, 1)
    ins.run('f2', 'd2', 'old-sell', 'b-old-sell', 'sell', 10, 120, 2, 2)
    // Recent buy present in BOTH the engine window and the local record.
    ins.run('f3', 'd3', 'c1', 'b1', 'buy', 10, 100, 3, 3)
    const client = mockClient([
      order({ client_order_id: 'c1', broker_order_id: 'b1', side: 'buy', filled_qty: 10, filled_avg_price: 100, updated_at: 3 }),
      order({ client_order_id: 'c2', broker_order_id: 'b2', side: 'sell', filled_qty: 10, filled_avg_price: 110, updated_at: 4 }),
    ])
    const t = await computeBrokerTruth(client, db)
    expect(t.roundTrips).toBe(2)
    expect(t.realizedTotal).toBeCloseTo(200 + 100)
  })

  it('uses full paginated history and repairs an older cumulative fill snapshot', async () => {
    const db = makeDb()
    db.prepare(`INSERT INTO trader_signals
      (id,strategy_id,asset,side,raw_score,horizon_days,generated_at,status)
      VALUES ('s-old','momentum-stocks','SPY','buy',0.8,20,1,'executed')`).run()
    db.prepare(`INSERT INTO trader_decisions
      (id,signal_id,action,asset,size_usd,entry_type,thesis,confidence,decided_at,status,engine_order_id)
      VALUES ('d-old','s-old','buy','SPY',1000,'limit','old',0.8,1,'closed','b-old')`).run()
    db.prepare(`INSERT INTO trader_fills
      (id,decision_id,client_order_id,broker_order_id,asset,side,fill_qty,fill_price,fill_ts_ms,fee_usd,slippage_usd,recorded_at)
      VALUES ('b-old:3','d-old','c-old','b-old','SPY','buy',3,100,1,0,0,1)`).run()
    const full = [order({
      client_order_id: 'c-old', broker_order_id: 'b-old', decision_id: 'd-old',
      filled_qty: 6, filled_avg_price: 101, updated_at: 2,
    })]
    const client = mockClient([])
    client.getAllOrders = vi.fn().mockResolvedValue(full)

    await computeBrokerTruth(client, db)

    expect(client.getAllOrders).toHaveBeenCalledTimes(1)
    expect(db.prepare("SELECT count(*) AS n,max(fill_qty) AS qty FROM trader_fills WHERE broker_order_id='b-old'").get())
      .toEqual({n: 1, qty: 6})
  })
})

describe('runGoLiveGate', () => {
  let db: ReturnType<typeof makeDb>
  beforeEach(() => { db = makeDb() })

  it('invalidates legacy, expired and changed-config approval', () => {
    const now = 1000000000
    const gate = {passed: true, version: GATE_VERSION, configFingerprint: gateConfigFingerprint(db), evaluatedAt: now, criteria: REQUIRED_GATE_CRITERIA.map(name => ({name, passed: true}))}
    db.exec('CREATE TABLE IF NOT EXISTS kv_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
    const save = (value: unknown) => db.prepare('INSERT OR REPLACE INTO kv_settings VALUES (?,?)').run('trader.gate.last', JSON.stringify(value))
    save(gate)
    expect(gateAuthorizesLive(db, now)).toBe(true)
    expect(gateAuthorizesLive(db, now + GATE_RUN_INTERVAL_MS)).toBe(false)
    expect(gateAuthorizesLive(db, now - 1)).toBe(false)
    save({...gate, version: 1})
    expect(gateAuthorizesLive(db, now)).toBe(false)
    save(gate)
    db.prepare("UPDATE trader_strategies SET status='paused'").run()
    expect(gateAuthorizesLive(db, now)).toBe(false)
    expect(gateRunDue(db, now)).toBe(true)
  })

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

describe('gateConfigFingerprint', () => {
  it('ignores scorecard computed_at so a per-tick refresh does not re-run the gate', () => {
    const db = makeDb()
    db.exec(`INSERT INTO trader_evaluation_cohorts (id,strategy_id,asset_class,status,config_json,config_fingerprint,universe_json,
      data_venue,execution_venue,mode,fee_bps_per_side,slippage_bps_per_side,benchmark_asset,max_position_usd,daily_trade_cap,
      claudepaw_revision,engine_revision,created_at)
      VALUES ('c1','s1','stocks','running','{}','fp','[]','v','v','paper',0,0,'SPY',100,1,'r','r',1)`)
    db.exec(`INSERT INTO trader_cohort_scorecards (cohort_id,trade_count,win_count,net_pnl_usd,expectancy,sharpe,deflated_sharpe,
      max_drawdown_pct,benchmark_return,excess_return,failure_rate,regimes_json,evidence_complete,passed,criteria_json,computed_at)
      VALUES ('c1',0,0,0,0,0,0,0,0,0,0,'[]',0,0,'[]',1000)`)
    const before = gateConfigFingerprint(db)
    db.exec('UPDATE trader_cohort_scorecards SET computed_at=2000')
    expect(gateConfigFingerprint(db)).toBe(before)
    db.exec('UPDATE trader_cohort_scorecards SET passed=1')
    expect(gateConfigFingerprint(db)).not.toBe(before)
  })
})
