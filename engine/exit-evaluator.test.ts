import { describe, it, expect, vi } from 'vitest'
import Database from 'better-sqlite3'
import { initTraderTables } from './db.js'
import { evaluateExit, runExitSweep, currentMomentum, strategySignalExit, wilderRsi, type OpenExitRow } from './exit-evaluator.js'
import type { EngineClient } from './engine-client.js'
import type { EnginePosition } from './types.js'

const DAY = 24 * 60 * 60 * 1000

function row(over: Partial<OpenExitRow> = {}): OpenExitRow {
  return {
    id: 'd1', signal_id: 's1', asset: 'AAPL', action: 'buy',
    entry_price: 100, stop_loss: 92, take_profit: 116,
    horizon_days: 20, decided_at: Date.now(),
    enrichment_json: null, cohort_id: null,
    ...over,
  }
}

// Tuesday 2026-04-21 10:00 ET = 14:00 UTC, inside NYSE hours. The exit sweep
// is now market-hours gated per asset class, so equity tests must pin a clock
// or they pass or fail depending on when the suite runs.
const MARKET_OPEN_MS = new Date('2026-04-21T14:00:00Z').getTime()

describe('evaluateExit', () => {
  it('ignores historical entry enrichment without current momentum', () => {
    expect(evaluateExit(row({enrichment_json: JSON.stringify({price_change_20d_pct: -30})}),
      {lastPrice: 100, nowMs: Date.now()}).exit).toBe(false)
  })

  it('time exits still work without a usable mark', () => {
    expect(evaluateExit(row({decided_at: Date.now() - 30 * DAY}),
      {lastPrice: null, nowMs: Date.now()}).reason).toBe('time')
  })

  it('calculates momentum from current distinct bars, rejecting stale history', () => {
    const now = Date.now()
    const bars = Array.from({length: 21}, (_, i) => ({ts_ms: now - (20 - i) * DAY, close: 100 - i}))
    expect(currentMomentum(bars, now, false)).toBeCloseTo(-20)
    expect(currentMomentum(bars, now + 5 * DAY, false)).toBeNull()
    expect(currentMomentum([bars[20]], now, false)).toBeNull()
  })
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
    const r = evaluateExit(row({ enrichment_json: enrich }), { lastPrice: 105, nowMs: Date.now(), momentumPct: -5.01 })
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

describe('strategy signal exits', () => {
  // Session of Tue 2026-04-21; completed bars run through Mon 04-20.
  const bar = (date: string, close: number, high = close, low = close) =>
    ({date, close, high, low, ts_ms: Date.parse(`${date}T04:00:00Z`)})
  const falling = ['04-08', '04-09', '04-10', '04-13', '04-14', '04-15', '04-16', '04-17']
    .map((d, i) => bar(`2026-${d}`, 100 - i))
  const entryMs = Date.parse('2026-04-17T13:31:00Z') // filled at the 04-17 open

  it('computes Wilder RSI', () => {
    expect(wilderRsi([1, 2, 3], 2)).toBe(100)
    expect(wilderRsi([3, 2, 1], 2)).toBe(0)
    expect(wilderRsi([1, 2], 2)).toBeNull()
    // 2-period Wilder: avg gain 0.5, loss 0.5 seed, then up 2 -> gain 1.25, loss 0.25 -> RSI 83.33
    expect(wilderRsi([10, 11, 10, 12], 2)).toBeCloseTo(83.333, 2)
  })

  it('rsi2 exits when the last completed close is above SMA5, ignoring today\'s partial bar', () => {
    const up = [...falling, bar('2026-04-20', 99)]
    expect(strategySignalExit('rsi2-stocks', up, entryMs, MARKET_OPEN_MS)).toBe(true)
    expect(strategySignalExit('rsi2-stocks', falling.concat(bar('2026-04-20', 92)), entryMs, MARKET_OPEN_MS)).toBe(false)
    // A strong partial bar for today does not count until it completes.
    expect(strategySignalExit('rsi2-stocks', [...falling, bar('2026-04-20', 92), bar('2026-04-21', 120)], entryMs, MARKET_OPEN_MS)).toBe(false)
  })

  it('rsi2 does not exit on the bar that produced the entry', () => {
    const lateEntry = Date.parse('2026-04-21T13:31:00Z')
    expect(strategySignalExit('rsi2-stocks', [...falling, bar('2026-04-20', 99)], lateEntry, MARKET_OPEN_MS)).toBe(false)
  })

  it('anchors to the fill day: no exit on the signal bar, exit on the fill-day bar next session', () => {
    // Signal from bar 04-20 (decided late on 04-20), filled at the 04-21 open.
    const decidedMs = Date.parse('2026-04-20T19:55:00Z')
    const filledMs = Date.parse('2026-04-21T13:31:00Z')
    const signalBarUp = [...falling, bar('2026-04-20', 99)]
    expect(strategySignalExit('rsi2-stocks', signalBarUp, filledMs, MARKET_OPEN_MS)).toBe(false)
    const nextSession = Date.parse('2026-04-22T14:00:00Z')
    expect(strategySignalExit('rsi2-stocks', [...signalBarUp, bar('2026-04-21', 99.5)], filledMs, nextSession)).toBe(true)
    expect(decidedMs).toBeLessThan(filledMs)
  })

  it('ibs exits when the last completed bar closes in its top fifth', () => {
    expect(strategySignalExit('ibs-stocks', [...falling, bar('2026-04-20', 95, 96, 90)], entryMs, MARKET_OPEN_MS)).toBe(true)
    expect(strategySignalExit('ibs-stocks', [...falling, bar('2026-04-20', 93, 96, 90)], entryMs, MARKET_OPEN_MS)).toBe(false)
  })

  it('ibs holds without high/low; the horizon backstop applies', () => {
    const closesOnly = [...falling, {date: '2026-04-20', close: 99, ts_ms: Date.parse('2026-04-20T04:00:00Z')}]
    expect(strategySignalExit('ibs-stocks', closesOnly, entryMs, MARKET_OPEN_MS)).toBe(false)
  })

  it('other strategies never take a signal exit', () => {
    expect(strategySignalExit('mean-reversion-stocks', [...falling, bar('2026-04-20', 99)], entryMs, MARKET_OPEN_MS)).toBe(false)
  })

  it('evaluateExit ranks a signal exit after stop and target, before time', () => {
    expect(evaluateExit(row(), {lastPrice: 105, nowMs: Date.now(), signalExit: true}).reason).toBe('signal')
    expect(evaluateExit(row(), {lastPrice: 91, nowMs: Date.now(), signalExit: true}).reason).toBe('stop')
  })
})

describe('runExitSweep', () => {
  function makeDb() {
    const db = new Database(':memory:')
    // Production runs with foreign_keys = ON (src/db.ts). Tests must match:
    // the May-Jun 2026 exit outage shipped because every trader test ran with
    // FKs OFF while prod rejected the exit-row INSERT on the signal_id FK.
    db.pragma('foreign_keys = ON')
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

  it('uses the entry fill time, not decided_at, as the signal-exit anchor', async () => {
    const db = makeDb()
    db.prepare(`INSERT INTO trader_strategies (id,name,asset_class,tier,status,params_json,created_at,updated_at)
      VALUES ('rsi2-stocks','R','stocks',0,'active','{}',1,1)`).run()
    db.prepare("UPDATE trader_signals SET strategy_id='rsi2-stocks'").run()
    // Decided on the signal bar's day (04-20), filled on 04-21.
    db.prepare('UPDATE trader_decisions SET decided_at=?').run(Date.parse('2026-04-20T19:55:00Z'))
    db.prepare(`INSERT INTO trader_fills (id,decision_id,client_order_id,broker_order_id,asset,side,fill_qty,fill_price,
      intended_price,intended_ts_ms,fill_ts_ms,fee_usd,slippage_usd,entry_thesis,exit_reason,recorded_at)
      VALUES ('f1','d1','c1','b1','AAPL','buy',1,100,NULL,NULL,?,0,0,NULL,NULL,?)`).run(Date.parse('2026-04-21T13:31:00Z'), 1)
    const bars = ['04-08', '04-09', '04-10', '04-13', '04-14', '04-15', '04-16', '04-17']
      .map((d, i) => ({date: `2026-${d}`, close: 100 - i, ts_ms: Date.parse(`2026-${d}T04:00:00Z`)}))
      .concat({date: '2026-04-20', close: 99, ts_ms: Date.parse('2026-04-20T04:00:00Z')})
    const submitDecision = vi.fn()
    const client = {
      getPositions: vi.fn().mockResolvedValue([{ asset: 'AAPL', qty: 1, avg_entry_price: 100, market_value: 99, unrealized_pnl: -1, source: 'broker', updated_at: MARKET_OPEN_MS }]),
      getPrices: vi.fn().mockResolvedValue(bars),
      submitDecision,
    } as unknown as EngineClient
    const out = await runExitSweep(db, client, vi.fn().mockResolvedValue(undefined), { nowMs: MARKET_OPEN_MS, isMarketOpen: () => true })
    expect(out.exited).toBe(0)
    expect(submitDecision).not.toHaveBeenCalled()
  })

  it('exits an rsi2 position on its signal rule from daily bars', async () => {
    const db = makeDb()
    db.prepare(`INSERT INTO trader_strategies (id,name,asset_class,tier,status,params_json,created_at,updated_at)
      VALUES ('rsi2-stocks','R','stocks',0,'active','{}',1,1)`).run()
    db.prepare("UPDATE trader_signals SET strategy_id='rsi2-stocks'").run()
    db.prepare('UPDATE trader_decisions SET decided_at=?').run(Date.parse('2026-04-17T13:31:00Z'))
    const bars = ['04-08', '04-09', '04-10', '04-13', '04-14', '04-15', '04-16', '04-17']
      .map((d, i) => ({date: `2026-${d}`, close: 100 - i, ts_ms: Date.parse(`2026-${d}T04:00:00Z`)}))
      .concat({date: '2026-04-20', close: 99, ts_ms: Date.parse('2026-04-20T04:00:00Z')})
    const submitDecision = vi.fn().mockResolvedValue({ client_order_id: 'x', broker_order_id: 'y', status: 'placed', approved_size_usd: 0 })
    const client = {
      getPositions: vi.fn().mockResolvedValue([{ asset: 'AAPL', qty: 1, avg_entry_price: 100, market_value: 99, unrealized_pnl: -1, source: 'broker', updated_at: MARKET_OPEN_MS }]),
      getPrices: vi.fn().mockResolvedValue(bars),
      submitDecision,
    } as unknown as EngineClient
    const out = await runExitSweep(db, client, vi.fn().mockResolvedValue(undefined), { nowMs: MARKET_OPEN_MS, isMarketOpen: () => true })
    expect(out.exited).toBe(1)
    expect((db.prepare("SELECT thesis FROM trader_decisions WHERE parent_decision_id='d1'").get() as {thesis: string}).thesis).toContain('Auto-exit (signal)')
  })
  it('submits a sell with size_usd=0 (full-close sentinel) and writes a closing decision row on stop breach', async () => {
    const db = makeDb()
    const pos: EnginePosition[] = [{ asset: 'AAPL', qty: 1.5, avg_entry_price: 100, market_value: 136.5, unrealized_pnl: -13.5, source: 'broker', updated_at: MARKET_OPEN_MS }]
    const submitDecision = vi.fn().mockResolvedValue({ client_order_id: 'x', broker_order_id: 'y', status: 'placed', approved_size_usd: 0 })
    const client = {
      getPositions: vi.fn().mockResolvedValue(pos),
      getPrices: vi.fn().mockResolvedValue([{ date: '2026-06-06', close: 105, ts_ms: 1 }, { date: '2026-06-07', close: 91, ts_ms: 2 }]),
      submitDecision,
    } as unknown as EngineClient
    const send = vi.fn().mockResolvedValue(undefined)

    const out = await runExitSweep(db, client, send, { nowMs: MARKET_OPEN_MS })
    expect(out.exited).toBe(1)
    expect(submitDecision).toHaveBeenCalledTimes(1)
    // I2: size_usd must be 0 (full-close sentinel per E3 contract), NOT market_value
    expect(submitDecision.mock.calls[0][0].size_usd).toBe(0)
    expect(submitDecision.mock.calls[0][0].side).toBe('sell')
    expect(submitDecision.mock.calls[0][0].asset).toBe('AAPL')
    const closing = db.prepare("SELECT * FROM trader_decisions WHERE action='sell' AND asset='AAPL'").get() as any
    expect(closing).toBeTruthy()
    expect(closing.status).toBe('exit_submitted')
    // Regression (Jun 2026 outage): the exit row must satisfy the
    // trader_decisions.signal_id -> trader_signals(id) FK. signal_id carries
    // the ENTRY's signal; the entry-decision linkage lives in
    // parent_decision_id. With foreign_keys = ON the old convention
    // (signal_id = entry decision id) threw SQLITE_CONSTRAINT_FOREIGNKEY on
    // every exit, forever.
    expect(closing.signal_id).toBe('s1')
    expect(closing.parent_decision_id).toBe('d1')
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('never sends another sell when the broker position is unexpectedly short', async () => {
    const db = makeDb()
    const submitDecision = vi.fn()
    const send = vi.fn().mockResolvedValue(undefined)
    const client = {
      getPositions: vi.fn().mockResolvedValue([
        { asset: 'AAPL', qty: -3, avg_entry_price: 100, market_value: -270, unrealized_pnl: 30, source: 'broker', updated_at: MARKET_OPEN_MS },
      ]),
      getPrices: vi.fn().mockResolvedValue([]),
      submitDecision,
    } as unknown as EngineClient

    const out = await runExitSweep(db, client, send, { nowMs: MARKET_OPEN_MS })

    expect(out.unsafeShorts).toBe(1)
    expect(submitDecision).not.toHaveBeenCalled()
    expect(send).toHaveBeenCalledWith(expect.stringContaining('UNEXPECTED SHORT POSITION'))
    expect(db.prepare("SELECT COUNT(*) AS n FROM trader_decisions WHERE parent_decision_id='d1'").get()).toEqual({n: 0})
  })

  it('does nothing when the asset has no live position', async () => {
    const db = makeDb()
    const client = {
      getPositions: vi.fn().mockResolvedValue([]),
      getPrices: vi.fn(),
      submitDecision: vi.fn(),
    } as unknown as EngineClient
    const out = await runExitSweep(db, client, vi.fn(), { nowMs: MARKET_OPEN_MS })
    expect(out.exited).toBe(0)
    expect(client.submitDecision).not.toHaveBeenCalled()
  })

  it('does not trigger a stop from stale position marks or old daily closes', async () => {
    const db = makeDb()
    const client = {getPositions: vi.fn().mockResolvedValue([{asset: 'AAPL', qty: 1,
      market_value: 80, updated_at: MARKET_OPEN_MS - 3600000}]),
      getPrices: vi.fn().mockResolvedValue([{close: 80, ts_ms: 1}]), submitDecision: vi.fn()} as unknown as EngineClient
    await runExitSweep(db, client, vi.fn(), {nowMs: MARKET_OPEN_MS})
    expect(client.submitDecision).not.toHaveBeenCalled()
  })

  it('does not double-submit when a prior exit row exists for the same DECISION (I3: guard on parent_decision_id)', async () => {
    const db = makeDb()
    // Exit row: signal_id stays the real signal ('s1', FK-valid); the entry
    // decision linkage lives in parent_decision_id ('d1').
    db.prepare(`INSERT INTO trader_decisions
      (id,signal_id,parent_decision_id,action,asset,size_usd,entry_type,thesis,confidence,decided_at,status)
      VALUES ('d1-exit','s1','d1','sell','AAPL',0,'market','exit',1,?,'exit_submitted')`).run(Date.now())
    const pos: EnginePosition[] = [{ asset: 'AAPL', qty: 1.5, avg_entry_price: 100, market_value: 136.5, unrealized_pnl: -13.5, source: 'broker', updated_at: MARKET_OPEN_MS }]
    const client = {
      getPositions: vi.fn().mockResolvedValue(pos),
      getPrices: vi.fn().mockResolvedValue([{ date: '2026-06-07', close: 91, ts_ms: 2 }]),
      submitDecision: vi.fn(),
    } as unknown as EngineClient
    const out = await runExitSweep(db, client, vi.fn(), { nowMs: MARKET_OPEN_MS })
    expect(out.exited).toBe(0)
    expect(client.submitDecision).not.toHaveBeenCalled()
  })

  it('I3: a second executed decision for the same signal is NOT suppressed by the first decision\'s exit', async () => {
    const db = makeDb()
    // Seed a second executed decision for the same signal (simulates partial-fill scenario).
    db.prepare(`INSERT INTO trader_decisions
      (id,signal_id,action,asset,size_usd,entry_type,entry_price,stop_loss,take_profit,thesis,confidence,decided_at,status)
      VALUES ('d2','s1','buy','AAPL',100,'market',100,92,116,'t',0.7,?,'executed')`).run(Date.now())
    // Exit row keyed on entry decision d1 via parent_decision_id -- only d1
    // is guarded, d2 is free.
    db.prepare(`INSERT INTO trader_decisions
      (id,signal_id,parent_decision_id,action,asset,size_usd,entry_type,thesis,confidence,decided_at,status)
      VALUES ('d1-exit','s1','d1','sell','AAPL',0,'market','exit',1,?,'exit_submitted')`).run(Date.now())
    const pos: EnginePosition[] = [{ asset: 'AAPL', qty: 2.5, avg_entry_price: 100, market_value: 227.5, unrealized_pnl: -22.5, source: 'broker', updated_at: MARKET_OPEN_MS }]
    const submitDecision = vi.fn().mockResolvedValue({ client_order_id: 'x2', broker_order_id: 'y2', status: 'placed', approved_size_usd: 0 })
    const client = {
      getPositions: vi.fn().mockResolvedValue(pos),
      getPrices: vi.fn().mockResolvedValue([{ date: '2026-06-07', close: 91, ts_ms: 2 }]),
      submitDecision,
    } as unknown as EngineClient
    const out = await runExitSweep(db, client, vi.fn(), { nowMs: MARKET_OPEN_MS })
    // d2 should fire an exit (price 91 <= stop 92); d1 is already guarded
    expect(out.exited).toBe(1)
    expect(submitDecision).toHaveBeenCalledTimes(1)
  })

  it('C1/C2: a 422 no_position error cleans up the orphaned exit_submitted row and does not block future exits', async () => {
    const db = makeDb()
    const pos: EnginePosition[] = [{ asset: 'AAPL', qty: 1.5, avg_entry_price: 100, market_value: 136.5, unrealized_pnl: -13.5, source: 'broker', updated_at: MARKET_OPEN_MS }]
    const submitDecision = vi.fn().mockRejectedValue(
      new Error('Engine API error 422 on /decisions/submit :: no_position'),
    )
    const client = {
      getPositions: vi.fn().mockResolvedValue(pos),
      getPrices: vi.fn().mockResolvedValue([{ date: '2026-06-07', close: 91, ts_ms: 2 }]),
      submitDecision,
    } as unknown as EngineClient

    const out = await runExitSweep(db, client, vi.fn(), { nowMs: MARKET_OPEN_MS })
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
    const out2 = await runExitSweep(db, client2, vi.fn(), { nowMs: MARKET_OPEN_MS })
    expect(out2.exited).toBe(1)
    expect(submitDecision2).toHaveBeenCalledTimes(1)
  })

  it('a transient submit failure preserves the same intent ID for recovery', async () => {
    // Live regression 2026-06-11 09:02 ET: pre-market exit submit got
    // "Engine API error 503 :: broker_unavailable"; the orphaned
    // exit_submitted row then blocked the exit forever via the guard.
    const db = makeDb()
    const pos: EnginePosition[] = [{ asset: 'AAPL', qty: 1.5, avg_entry_price: 100, market_value: 136.5, unrealized_pnl: -13.5, source: 'broker', updated_at: MARKET_OPEN_MS }]
    const failing = {
      getPositions: vi.fn().mockResolvedValue(pos),
      getPrices: vi.fn().mockResolvedValue([{ date: '2026-06-07', close: 91, ts_ms: 2 }]),
      submitDecision: vi.fn().mockRejectedValue(new Error('Engine API error 503 on /decisions/submit :: broker_unavailable')),
    } as unknown as EngineClient

    const out = await runExitSweep(db, failing, vi.fn(), { nowMs: MARKET_OPEN_MS })
    expect(out.errors).toBe(1)
    expect(out.exited).toBe(0)
    const intent = db.prepare("SELECT id FROM trader_decisions WHERE status='exit_unknown'").get() as {id: string}
    expect(intent.id).toBeTruthy()

    // Next sweep retries and succeeds.
    const ok = {
      getPositions: vi.fn().mockResolvedValue(pos),
      getPrices: vi.fn().mockResolvedValue([{ date: '2026-06-07', close: 91, ts_ms: 2 }]),
      submitDecision: vi.fn().mockResolvedValue({ client_order_id: 'x3', broker_order_id: 'y3', status: 'placed', approved_size_usd: 0 }),
    } as unknown as EngineClient
    const out2 = await runExitSweep(db, ok, vi.fn(), { nowMs: MARKET_OPEN_MS })
    expect(out2.exited).toBe(1)
    expect(ok.submitDecision).toHaveBeenCalledWith(expect.objectContaining({decision_id: intent.id}))
  })
})

describe('runExitSweep market-hours gate', () => {
  // Saturday 2026-04-18 14:00 UTC: NYSE shut.
  const MARKET_CLOSED_MS = new Date('2026-04-18T14:00:00Z').getTime()

  function makeDbFor(asset: string) {
    const db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    initTraderTables(db)
    db.prepare(`INSERT INTO trader_strategies (id,name,asset_class,tier,status,params_json,created_at,updated_at)
      VALUES ('momentum-stocks','M','equity',1,'active','{}',?,?)`).run(Date.now(), Date.now())
    db.prepare(`INSERT INTO trader_signals (id,strategy_id,asset,side,raw_score,horizon_days,generated_at,status)
      VALUES ('s1','momentum-stocks',?,'buy',0.8,20,?,'executed')`).run(asset, Date.now())
    db.prepare(`INSERT INTO trader_decisions
      (id,signal_id,action,asset,size_usd,entry_type,entry_price,stop_loss,take_profit,thesis,confidence,decided_at,status)
      VALUES ('d1','s1','buy',?,150,'market',100,92,116,'t',0.7,?,'executed')`).run(asset, Date.now())
    return db
  }

  function clientFor(asset: string, positions: EnginePosition[]) {
    return {
      getPositions: vi.fn().mockResolvedValue(positions),
      // Last close 91 is below the 92 stop, so a stop exit WOULD fire.
      getPrices: vi.fn().mockResolvedValue([{ date: '2026-04-17', close: 91, ts_ms: 1 }]),
      submitDecision: vi.fn().mockResolvedValue({ client_order_id: 'x', broker_order_id: 'y', status: 'placed', approved_size_usd: 0 }),
    } as unknown as EngineClient & { submitDecision: ReturnType<typeof vi.fn> }
  }

  const posFor = (asset: string): EnginePosition =>
    ({ asset, qty: 1.5, avg_entry_price: 100, market_value: 136.5, unrealized_pnl: -13.5, source: 'broker', updated_at: MARKET_CLOSED_MS })

  it('does not touch equities while NYSE is shut, and writes no intent row', async () => {
    // Before this gate the sweep ran every 5 minutes around the clock: insert
    // exit_submitted, get 422 blocked_by:["market_closed"], delete the row,
    // rethrow. 4,119 insert-delete cycles by 2026-08-02, 3,547 of them purely
    // market_closed, against 11 exits that actually submitted.
    const db = makeDbFor('AAPL')
    const client = clientFor('AAPL', [posFor('AAPL')])

    const out = await runExitSweep(db, client, vi.fn(), { nowMs: MARKET_CLOSED_MS })

    expect(out.exited).toBe(0)
    expect(out.errors).toBe(0)
    expect(out.skippedClosed).toBe(1)
    expect(client.submitDecision).not.toHaveBeenCalled()
    const rows = db.prepare("SELECT COUNT(*) n FROM trader_decisions WHERE status='exit_submitted'").get() as any
    expect(rows.n).toBe(0)
  })

  it('still exits crypto while NYSE is shut, because crypto trades 24/7', async () => {
    const db = makeDbFor('BTC/USD')
    const client = clientFor('BTC/USD', [posFor('BTC/USD')])

    const out = await runExitSweep(db, client, vi.fn(), { nowMs: MARKET_CLOSED_MS })

    expect(out.exited).toBe(1)
    expect(out.skippedClosed).toBe(0)
    expect(client.submitDecision).toHaveBeenCalledTimes(1)
  })

  it('counts broker drift instead of skipping it silently', async () => {
    // Six QQQ lots drifted for 52 days behind a bare `continue` with no log and
    // no counter, so the sweep reported a clean {exited:0, errors:0}.
    const db = makeDbFor('QQQ')
    const client = clientFor('QQQ', [])  // broker holds nothing

    const out = await runExitSweep(db, client, vi.fn(), { nowMs: MARKET_OPEN_MS })

    expect(out.drifted).toBe(1)
    expect(out.checked).toBe(0)
    expect(client.submitDecision).not.toHaveBeenCalled()
  })

  it('honours the scheduler isMarketOpen dep over the wall clock', async () => {
    const db = makeDbFor('AAPL')
    const client = clientFor('AAPL', [posFor('AAPL')])

    const out = await runExitSweep(db, client, vi.fn(), {
      nowMs: MARKET_CLOSED_MS,
      isMarketOpen: () => true,
    })

    expect(out.exited).toBe(1)
  })
})
