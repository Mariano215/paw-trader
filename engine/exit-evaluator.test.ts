import { describe, it, expect, vi } from 'vitest'
import Database from 'better-sqlite3'
import { initTraderTables } from './db.js'
import { evaluateExit, runExitSweep, type OpenExitRow } from './exit-evaluator.js'
import type { EngineClient } from './engine-client.js'
import type { EnginePosition } from './types.js'

const DAY = 24 * 60 * 60 * 1000

function row(over: Partial<OpenExitRow> = {}): OpenExitRow {
  return {
    id: 'd1', signal_id: 's1', asset: 'AAPL', action: 'buy',
    entry_price: 100, stop_loss: 92, take_profit: 116,
    horizon_days: 20, decided_at: Date.now(),
    enrichment_json: null,
    ...over,
  }
}

describe('evaluateExit', () => {
  it('exits a long when the last price is at/below the stop', () => {
    const r = evaluateExit(row(), { lastPrice: 91, nowMs: Date.now() })
    expect(r.exit).toBe(true)
    expect(r.reason).toBe('stop')
    expect(r.side).toBe('sell')
  })

  it('exits a long when the last price is at/above the target', () => {
    const r = evaluateExit(row(), { lastPrice: 117, nowMs: Date.now() })
    expect(r.exit).toBe(true)
    expect(r.reason).toBe('target')
    expect(r.side).toBe('sell')
  })

  it('exits on time-stop when now exceeds decided_at + horizon', () => {
    const decided = Date.now() - 21 * DAY
    const r = evaluateExit(row({ decided_at: decided }), { lastPrice: 105, nowMs: Date.now() })
    expect(r.exit).toBe(true)
    expect(r.reason).toBe('time')
  })

  it('exits on momentum decay when 20d change exceeds the deadband for a long', () => {
    const enrich = JSON.stringify({ price_change_20d_pct: -5.01 })
    const r = evaluateExit(row({ enrichment_json: enrich }), { lastPrice: 105, nowMs: Date.now() })
    expect(r.exit).toBe(true)
    expect(r.reason).toBe('momentum')
  })

  it('holds when momentum is negative but within the deadband (-4.99)', () => {
    const enrich = JSON.stringify({ price_change_20d_pct: -4.99 })
    const r = evaluateExit(row({ enrichment_json: enrich }), { lastPrice: 105, nowMs: Date.now() })
    expect(r.exit).toBe(false)
    expect(r.reason).toBe('hold')
  })

  it('holds when inside the band, within horizon, momentum intact', () => {
    const enrich = JSON.stringify({ price_change_20d_pct: 4.0 })
    const r = evaluateExit(row({ enrichment_json: enrich }), { lastPrice: 105, nowMs: Date.now() })
    expect(r.exit).toBe(false)
    expect(r.reason).toBe('hold')
  })

  it('mirrors stop/target for a short position', () => {
    const short = row({ action: 'sell', stop_loss: 108, take_profit: 84 })
    expect(evaluateExit(short, { lastPrice: 109, nowMs: Date.now() }).reason).toBe('stop')
    expect(evaluateExit(short, { lastPrice: 83, nowMs: Date.now() }).reason).toBe('target')
  })

  it('does not breach-exit when stop/target are null (still time-stops)', () => {
    const r = evaluateExit(row({ stop_loss: null, take_profit: null }), { lastPrice: 50, nowMs: Date.now() })
    expect(r.exit).toBe(false)
    const decided = Date.now() - 21 * DAY
    const t = evaluateExit(row({ stop_loss: null, take_profit: null, decided_at: decided }), { lastPrice: 50, nowMs: Date.now() })
    expect(t.reason).toBe('time')
  })
})

describe('runExitSweep', () => {
  function makeDb() {
    const db = new Database(':memory:')
    db.pragma('foreign_keys = OFF')
    initTraderTables(db)
    db.prepare(`INSERT INTO trader_strategies (id,name,asset_class,tier,status,params_json,created_at,updated_at)
      VALUES ('momentum-stocks','M','equity',1,'active','{}',?,?)`).run(Date.now(), Date.now())
    db.prepare(`INSERT INTO trader_signals (id,strategy_id,asset,side,raw_score,horizon_days,generated_at,status)
      VALUES ('s1','momentum-stocks','AAPL','buy',0.8,20,?,'executed')`).run(Date.now())
    db.prepare(`INSERT INTO trader_decisions
      (id,signal_id,action,asset,size_usd,entry_type,entry_price,stop_loss,take_profit,thesis,confidence,decided_at,status)
      VALUES ('d1','s1','buy','AAPL',150,'market',100,92,116,'t',0.7,?,'executed')`).run(Date.now())
    return db
  }

  it('submits a sell with size_usd=0 (full-close sentinel) and writes a closing decision row on stop breach', async () => {
    const db = makeDb()
    const pos: EnginePosition[] = [{ asset: 'AAPL', qty: 1.5, avg_entry_price: 100, market_value: 136.5, unrealized_pnl: -13.5, source: 'broker', updated_at: Date.now() }]
    const submitDecision = vi.fn().mockResolvedValue({ client_order_id: 'x', broker_order_id: 'y', status: 'placed', approved_size_usd: 0 })
    const client = {
      getPositions: vi.fn().mockResolvedValue(pos),
      getPrices: vi.fn().mockResolvedValue([{ date: '2026-06-06', close: 105, ts_ms: 1 }, { date: '2026-06-07', close: 91, ts_ms: 2 }]),
      submitDecision,
    } as unknown as EngineClient
    const send = vi.fn().mockResolvedValue(undefined)

    const out = await runExitSweep(db, client, send)
    expect(out.exited).toBe(1)
    expect(submitDecision).toHaveBeenCalledTimes(1)
    // I2: size_usd must be 0 (full-close sentinel per E3 contract), NOT market_value
    expect(submitDecision.mock.calls[0][0].size_usd).toBe(0)
    expect(submitDecision.mock.calls[0][0].side).toBe('sell')
    expect(submitDecision.mock.calls[0][0].asset).toBe('AAPL')
    const closing = db.prepare("SELECT * FROM trader_decisions WHERE action='sell' AND asset='AAPL'").get() as any
    expect(closing).toBeTruthy()
    expect(closing.status).toBe('exit_submitted')
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('does nothing when the asset has no live position', async () => {
    const db = makeDb()
    const client = {
      getPositions: vi.fn().mockResolvedValue([]),
      getPrices: vi.fn(),
      submitDecision: vi.fn(),
    } as unknown as EngineClient
    const out = await runExitSweep(db, client, vi.fn())
    expect(out.exited).toBe(0)
    expect(client.submitDecision).not.toHaveBeenCalled()
  })

  it('does not double-submit when a prior exit row exists for the same DECISION (I3: guard on decision id)', async () => {
    const db = makeDb()
    // Exit row's signal_id = entry decision's id ('d1'), NOT the signal id ('s1').
    db.prepare(`INSERT INTO trader_decisions
      (id,signal_id,action,asset,size_usd,entry_type,thesis,confidence,decided_at,status)
      VALUES ('d1-exit','d1','sell','AAPL',0,'market','exit',1,?,'exit_submitted')`).run(Date.now())
    const pos: EnginePosition[] = [{ asset: 'AAPL', qty: 1.5, avg_entry_price: 100, market_value: 136.5, unrealized_pnl: -13.5, source: 'broker', updated_at: Date.now() }]
    const client = {
      getPositions: vi.fn().mockResolvedValue(pos),
      getPrices: vi.fn().mockResolvedValue([{ date: '2026-06-07', close: 91, ts_ms: 2 }]),
      submitDecision: vi.fn(),
    } as unknown as EngineClient
    const out = await runExitSweep(db, client, vi.fn())
    expect(out.exited).toBe(0)
    expect(client.submitDecision).not.toHaveBeenCalled()
  })

  it('I3: a second executed decision for the same signal is NOT suppressed by the first decision\'s exit', async () => {
    const db = makeDb()
    // Seed a second executed decision for the same signal (simulates partial-fill scenario).
    db.prepare(`INSERT INTO trader_decisions
      (id,signal_id,action,asset,size_usd,entry_type,entry_price,stop_loss,take_profit,thesis,confidence,decided_at,status)
      VALUES ('d2','s1','buy','AAPL',100,'market',100,92,116,'t',0.7,?,'executed')`).run(Date.now())
    // Exit row keyed on entry decision d1's id -- only d1 is guarded, d2 is free.
    db.prepare(`INSERT INTO trader_decisions
      (id,signal_id,action,asset,size_usd,entry_type,thesis,confidence,decided_at,status)
      VALUES ('d1-exit','d1','sell','AAPL',0,'market','exit',1,?,'exit_submitted')`).run(Date.now())
    const pos: EnginePosition[] = [{ asset: 'AAPL', qty: 2.5, avg_entry_price: 100, market_value: 227.5, unrealized_pnl: -22.5, source: 'broker', updated_at: Date.now() }]
    const submitDecision = vi.fn().mockResolvedValue({ client_order_id: 'x2', broker_order_id: 'y2', status: 'placed', approved_size_usd: 0 })
    const client = {
      getPositions: vi.fn().mockResolvedValue(pos),
      getPrices: vi.fn().mockResolvedValue([{ date: '2026-06-07', close: 91, ts_ms: 2 }]),
      submitDecision,
    } as unknown as EngineClient
    const out = await runExitSweep(db, client, vi.fn())
    // d2 should fire an exit (price 91 <= stop 92); d1 is already guarded
    expect(out.exited).toBe(1)
    expect(submitDecision).toHaveBeenCalledTimes(1)
  })

  it('C1/C2: a 422 no_position error cleans up the orphaned exit_submitted row and does not block future exits', async () => {
    const db = makeDb()
    const pos: EnginePosition[] = [{ asset: 'AAPL', qty: 1.5, avg_entry_price: 100, market_value: 136.5, unrealized_pnl: -13.5, source: 'broker', updated_at: Date.now() }]
    const submitDecision = vi.fn().mockRejectedValue(
      new Error('Engine API error 422 on /decisions/submit :: no_position'),
    )
    const client = {
      getPositions: vi.fn().mockResolvedValue(pos),
      getPrices: vi.fn().mockResolvedValue([{ date: '2026-06-07', close: 91, ts_ms: 2 }]),
      submitDecision,
    } as unknown as EngineClient

    const out = await runExitSweep(db, client, vi.fn())
    // no_position is not a real error -- the bracket already closed it
    expect(out.errors).toBe(0)
    expect(out.exited).toBe(0)
    // The orphaned exit_submitted row must have been removed
    const orphan = db.prepare("SELECT id FROM trader_decisions WHERE status='exit_submitted'").get()
    expect(orphan).toBeUndefined()
    // A second sweep must NOT be blocked (the guard finds no exit_submitted row)
    const submitDecision2 = vi.fn().mockResolvedValue({ client_order_id: 'x2', broker_order_id: 'y2', status: 'placed', approved_size_usd: 0 })
    const client2 = {
      getPositions: vi.fn().mockResolvedValue(pos),
      getPrices: vi.fn().mockResolvedValue([{ date: '2026-06-07', close: 91, ts_ms: 2 }]),
      submitDecision: submitDecision2,
    } as unknown as EngineClient
    const out2 = await runExitSweep(db, client2, vi.fn())
    expect(out2.exited).toBe(1)
    expect(submitDecision2).toHaveBeenCalledTimes(1)
  })
})
