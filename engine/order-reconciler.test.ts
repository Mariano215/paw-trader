import { describe, it, expect, beforeEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import { initTraderTables } from './db.js'
import { seedMomentumStrategy } from './strategy-manager.js'
import { reconcileOpenOrders, RECONCILE_ORPHAN_HORIZON_MS } from './order-reconciler.js'
import { DECISION_STATUS } from './order-lifecycle.js'
import { listFillsForDecision } from './audit-log.js'
import type { EngineClient } from './engine-client.js'
import type { EngineOrder } from './types.js'

function makeDb() {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = OFF')
  initTraderTables(db)
  seedMomentumStrategy(db)
  db.prepare(`INSERT INTO trader_signals (id, strategy_id, asset, side, raw_score, horizon_days, generated_at, status)
    VALUES ('s1','momentum-stocks','AAPL','buy',0.7,20,?, 'submitted')`).run(Date.now())
  return db
}

function insertDecision(db: Database.Database, status: string, engineOrderId: string | null) {
  db.prepare(`INSERT INTO trader_decisions
    (id, signal_id, action, asset, size_usd, entry_type, thesis, confidence, decided_at, status, engine_order_id)
    VALUES ('d1','s1','buy','AAPL',150,'market','t',0.7,?, ?, ?)`).run(Date.now(), status, engineOrderId)
}

function order(over: Partial<EngineOrder>): EngineOrder {
  return {
    client_order_id: 'd1', broker_order_id: 'boid-1', asset: 'AAPL', side: 'buy',
    qty: 1, order_type: 'market', limit_price: null, status: 'new',
    filled_qty: 0, filled_avg_price: null, source: 't', created_at: 1, updated_at: 1, ...over,
  }
}

describe('reconcileOpenOrders', () => {
  let db: ReturnType<typeof makeDb>
  beforeEach(() => { db = makeDb() })

  it('promotes submitted -> executed on a confirmed fill and caches fill data', async () => {
    insertDecision(db, DECISION_STATUS.SUBMITTED, 'boid-1')
    const client = { getOrders: vi.fn().mockResolvedValue([order({ status: 'filled', filled_qty: 3, filled_avg_price: 101.5 })]) }
    const s = await reconcileOpenOrders(db, client as unknown as EngineClient)
    expect(s.promotedToFilled).toBe(1)
    const row = db.prepare("SELECT status, filled_qty, filled_avg_price FROM trader_decisions WHERE id='d1'").get() as any
    expect(row.status).toBe('executed')
    expect(row.filled_qty).toBe(3)
    expect(row.filled_avg_price).toBe(101.5)
  })

  it('advances submitted -> pending_fill when live but unfilled', async () => {
    insertDecision(db, DECISION_STATUS.SUBMITTED, 'boid-1')
    const client = { getOrders: vi.fn().mockResolvedValue([order({ status: 'new', filled_qty: 0 })]) }
    const s = await reconcileOpenOrders(db, client as unknown as EngineClient)
    expect(s.promotedToPending).toBe(1)
    expect((db.prepare("SELECT status FROM trader_decisions WHERE id='d1'").get() as any).status).toBe('pending_fill')
  })

  it('marks failed on a canceled order', async () => {
    insertDecision(db, DECISION_STATUS.PENDING_FILL, 'boid-1')
    const client = { getOrders: vi.fn().mockResolvedValue([order({ status: 'canceled' })]) }
    const s = await reconcileOpenOrders(db, client as unknown as EngineClient)
    expect(s.canceledOrRejected).toBe(1)
    expect((db.prepare("SELECT status FROM trader_decisions WHERE id='d1'").get() as any).status).toBe('failed')
  })

  it('does NOT mutate when getOrders throws (engine unreachable)', async () => {
    insertDecision(db, DECISION_STATUS.SUBMITTED, 'boid-1')
    const client = { getOrders: vi.fn().mockRejectedValue(new Error('Engine API error 503 on /orders')) }
    const s = await reconcileOpenOrders(db, client as unknown as EngineClient)
    expect(s.checked).toBe(1)
    expect(s.promotedToFilled + s.promotedToPending + s.canceledOrRejected).toBe(0)
    expect((db.prepare("SELECT status FROM trader_decisions WHERE id='d1'").get() as any).status).toBe('submitted')
  })

  it('reflects the current engine reality: a placed-only order stays submitted (no fabricated fill)', async () => {
    // Mirrors the live engine: status='placed', filled_qty=0, filled_avg_price=null forever.
    insertDecision(db, DECISION_STATUS.SUBMITTED, 'boid-1')
    const client = { getOrders: vi.fn().mockResolvedValue([order({ status: 'placed', filled_qty: 0, filled_avg_price: null })]) }
    const s = await reconcileOpenOrders(db, client as unknown as EngineClient)
    expect(s.promotedToFilled).toBe(0)
    expect((db.prepare("SELECT status FROM trader_decisions WHERE id='d1'").get() as any).status).toBe('pending_fill')
  })

  it('skips a recent submitted order with no broker match (propagation lag, not expired)', async () => {
    // decided_at = now, well within RECONCILE_ORPHAN_HORIZON_MS -- must stay submitted.
    const recentAt = Date.now()
    db.prepare(`INSERT INTO trader_decisions
      (id, signal_id, action, asset, size_usd, entry_type, thesis, confidence, decided_at, status, engine_order_id)
      VALUES ('d-recent','s1','buy','AAPL',150,'market','t',0.7,?, ?, 'boid-recent')`).run(recentAt, DECISION_STATUS.SUBMITTED)
    const client = { getOrders: vi.fn().mockResolvedValue([]) } // empty -- no broker record
    const s = await reconcileOpenOrders(db, client as unknown as EngineClient)
    expect(s.canceledOrRejected).toBe(0)
    expect((db.prepare("SELECT status FROM trader_decisions WHERE id='d-recent'").get() as any).status).toBe('submitted')
  })

  it('expires an old submitted order with no broker match and sends an alert', async () => {
    const oldAt = Date.now() - RECONCILE_ORPHAN_HORIZON_MS - 1000
    db.prepare(`INSERT INTO trader_decisions
      (id, signal_id, action, asset, size_usd, entry_type, thesis, confidence, decided_at, status, engine_order_id)
      VALUES ('d-old','s1','buy','AAPL',150,'market','t',0.7,?, ?, 'boid-old')`).run(oldAt, DECISION_STATUS.SUBMITTED)
    const sendSpy = vi.fn(async () => {})
    const client = { getOrders: vi.fn().mockResolvedValue([]) } // empty -- no broker record
    const s = await reconcileOpenOrders(db, client as unknown as EngineClient, sendSpy)
    expect(s.expiredOrphans).toBe(1)
    expect((db.prepare("SELECT status FROM trader_decisions WHERE id='d-old'").get() as any).status).toBe('failed')
    expect(sendSpy).toHaveBeenCalledTimes(1)
    expect((sendSpy.mock.calls as string[][])[0][0]).toContain('d-old')
  })

  // I1: confirmed fill must write exactly one trader_fills row, idempotent on re-run.
  it('I1: writes a trader_fills row on confirmed fill and is idempotent on re-run', async () => {
    insertDecision(db, DECISION_STATUS.SUBMITTED, 'boid-fill-1')
    const filledOrder = order({
      broker_order_id: 'boid-fill-1',
      status: 'filled',
      filled_qty: 5,
      filled_avg_price: 102.0,
      updated_at: 1_700_000_000_000,
    })
    const client = { getOrders: vi.fn().mockResolvedValue([filledOrder]) }
    // First reconcile -- should write the fill.
    await reconcileOpenOrders(db, client as unknown as EngineClient)
    const fills = listFillsForDecision(db, 'd1')
    expect(fills).toHaveLength(1)
    expect(fills[0].fill_qty).toBe(5)
    expect(fills[0].fill_price).toBe(102.0)
    expect(fills[0].asset).toBe('AAPL')
    expect(fills[0].side).toBe('buy')
    // Second reconcile -- same broker_order_id means INSERT OR IGNORE; still exactly one row.
    await reconcileOpenOrders(db, client as unknown as EngineClient)
    expect(listFillsForDecision(db, 'd1')).toHaveLength(1)
  })
})
