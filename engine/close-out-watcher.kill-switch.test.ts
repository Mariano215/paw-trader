/**
 * close-out-watcher.kill-switch.test.ts -- Phase 4 Task A
 *
 * CRITICAL CORRECTNESS PROPERTY:
 * The close-out sweep is RECONCILIATION, not spend. It reads engine
 * state (positions + orders), writes verdicts, updates track records,
 * and inserts ReasoningBank cases. None of those involve LLM calls or
 * cost-incurring work. It MUST continue to run even when the kill
 * switch is tripped -- otherwise we lose audit data for trades that
 * closed while the system was paused, and the autonomy ladder's track
 * record falls out of sync with reality.
 *
 * The kill switch lives upstream of runAgent (src/agent.ts),
 * ChannelManager.send (src/channels/manager.ts), and the scheduler
 * tick (src/scheduler.ts). runCloseOutSweep deliberately bypasses
 * those gates because it takes no spending action.
 *
 * Note on the checkKillSwitch spy: runCloseOutSweep does not call
 * checkKillSwitch today, so the mock is a no-op against the current
 * code path. It is pre-wired so that IF a future change erroneously
 * adds a gate here, these tests will immediately prove that gate
 * should be removed (the verdict + track record + ReasoningBank
 * assertions already pin the required behavior). Belt and suspenders.
 *
 * These tests verify that design:
 *  - With the switch tripped, a closed position still produces a
 *    verdict row AND the strategy's track record is recomputed.
 *  - Control: same fixture with the switch clear produces identical
 *    DB writes.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import Database from 'better-sqlite3'

import { initTraderTables } from './db.js'
import { seedAllStrategies } from './strategy-manager.js'
import { runCloseOutSweep } from './close-out-watcher.js'
import type { EngineClient } from './engine-client.js'
import type { EngineOrder } from './types.js'
import * as killSwitch from '../cost/kill-switch-client.js'

function makeDb() {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = OFF')
  initTraderTables(db)
  seedAllStrategies(db)
  return db
}

function insertSignal(db: Database.Database, id: string) {
  db.prepare(`
    INSERT INTO trader_signals (id, strategy_id, asset, side, raw_score, horizon_days, generated_at, status)
    VALUES (?, 'momentum-stocks', 'AAPL', 'buy', 0.7, 20, ?, 'decided')
  `).run(id, Date.now())
}

function insertExecutedDecision(
  db: Database.Database,
  decisionId: string,
  signalId: string,
) {
  db.prepare(`
    INSERT INTO trader_decisions
      (id, signal_id, action, asset, size_usd, entry_type, thesis, confidence,
       committee_transcript_id, decided_at, status)
    VALUES (?, ?, 'buy', 'AAPL', 1000, 'limit', 'momentum continuation', 0.7, NULL, 1000, 'executed')
  `).run(decisionId, signalId)
}

function fillOrder(overrides: Partial<EngineOrder> = {}): EngineOrder {
  return {
    client_order_id: 'co-' + Math.random().toString(36).slice(2, 8),
    broker_order_id: null,
    asset: 'AAPL',
    side: 'buy',
    qty: 10,
    order_type: 'limit',
    limit_price: null,
    status: 'filled',
    filled_qty: 10,
    filled_avg_price: 100,
    source: 'test',
    created_at: 1100,
    updated_at: 1100,
    ...overrides,
  }
}

function makeEngine(orders: EngineOrder[]): EngineClient {
  return {
    getPositions: vi.fn().mockResolvedValue([]),
    getOrders: vi.fn().mockResolvedValue(orders),
    // Phase 4 Task B adds a /prices call on the close-out path. These
    // tests are about the kill-switch not blocking reconciliation, not
    // about bench-return math, so we stub prices with an empty series
    // to short-circuit to "no bars -> placeholder 0" quickly.
    getPrices: vi.fn().mockResolvedValue([]),
  } as unknown as EngineClient
}

const winningFills: EngineOrder[] = [
  fillOrder({ side: 'buy',  filled_qty: 10, filled_avg_price: 100, created_at: 1100, updated_at: 1100 }),
  fillOrder({ side: 'sell', filled_qty: 10, filled_avg_price: 110, created_at: 5000, updated_at: 5000 }),
]

describe('close-out watcher kill-switch behavior (reconciliation path must not be blocked)', () => {
  let db: ReturnType<typeof makeDb>

  beforeEach(() => {
    db = makeDb()
    vi.restoreAllMocks()
  })

  it('switch TRIPPED: verdict row IS still written for a closed position', async () => {
    vi.spyOn(killSwitch, 'checkKillSwitch').mockResolvedValue({
      set_at: Date.now(),
      reason: 'over budget',
    })

    insertSignal(db, 'sig-ks-closed')
    insertExecutedDecision(db, 'dec-ks-closed', 'sig-ks-closed')

    const result = await runCloseOutSweep(db, makeEngine(winningFills))

    // Reconciliation must complete even with the switch tripped --
    // this is the critical correctness property. Losing this writes
    // loses audit data.
    expect(result.processed).toBe(1)

    const verdict = db.prepare('SELECT * FROM trader_verdicts WHERE decision_id = ?').get('dec-ks-closed') as any
    expect(verdict).toBeDefined()
    expect(verdict.pnl_gross).toBe(100)
    expect(verdict.thesis_grade).toBe('A')
  })

  it('switch TRIPPED: strategy track record IS still recomputed after verdict write', async () => {
    vi.spyOn(killSwitch, 'checkKillSwitch').mockResolvedValue({
      set_at: Date.now(),
      reason: 'over budget',
    })

    insertSignal(db, 'sig-ks-tr')
    insertExecutedDecision(db, 'dec-ks-tr', 'sig-ks-tr')

    await runCloseOutSweep(db, makeEngine(winningFills))

    const tr = db.prepare(
      "SELECT * FROM trader_strategy_track_record WHERE strategy_id = 'momentum-stocks'",
    ).get() as any
    expect(tr).toBeDefined()
    expect(tr.trade_count).toBe(1)
    expect(tr.win_count).toBe(1)
    expect(tr.net_pnl_usd).toBe(100)
  })

  it('switch TRIPPED: ReasoningBank case IS still inserted', async () => {
    vi.spyOn(killSwitch, 'checkKillSwitch').mockResolvedValue({
      set_at: Date.now(),
      reason: 'over budget',
    })

    insertSignal(db, 'sig-ks-rb')
    insertExecutedDecision(db, 'dec-ks-rb', 'sig-ks-rb')

    await runCloseOutSweep(db, makeEngine(winningFills))

    const bankRow = db.prepare(
      'SELECT * FROM trader_reasoning_bank WHERE decision_id = ?',
    ).get('dec-ks-rb') as any
    expect(bankRow).toBeDefined()
    expect(bankRow.outcome).toBe('win')
    expect(bankRow.thesis_grade).toBe('A')
  })

  it('switch CLEAR: same fixture produces identical verdict + track record (control)', async () => {
    vi.spyOn(killSwitch, 'checkKillSwitch').mockResolvedValue(null)

    insertSignal(db, 'sig-ctrl')
    insertExecutedDecision(db, 'dec-ctrl', 'sig-ctrl')

    const result = await runCloseOutSweep(db, makeEngine(winningFills))
    expect(result.processed).toBe(1)

    const verdict = db.prepare('SELECT * FROM trader_verdicts WHERE decision_id = ?').get('dec-ctrl') as any
    expect(verdict.pnl_gross).toBe(100)
    expect(verdict.thesis_grade).toBe('A')

    const tr = db.prepare(
      "SELECT * FROM trader_strategy_track_record WHERE strategy_id = 'momentum-stocks'",
    ).get() as any
    expect(tr.trade_count).toBe(1)
    expect(tr.win_count).toBe(1)
    expect(tr.net_pnl_usd).toBe(100)
  })

  it('switch TRIPPED + no engine fetch call regression: still calls getPositions+getOrders once', async () => {
    vi.spyOn(killSwitch, 'checkKillSwitch').mockResolvedValue({
      set_at: Date.now(),
      reason: 'maintenance',
    })

    insertSignal(db, 'sig-engine-call')
    insertExecutedDecision(db, 'dec-engine-call', 'sig-engine-call')

    const engine = makeEngine(winningFills)
    await runCloseOutSweep(db, engine)

    // The sweep must fetch engine state even with the switch tripped;
    // a call here is reconciliation, not spend.
    expect(engine.getPositions).toHaveBeenCalledTimes(1)
    expect(engine.getOrders).toHaveBeenCalledTimes(1)
  })
})
