import { describe, it, expect, beforeEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import { initTraderTables } from './db.js'
import { seedMomentumStrategy } from './strategy-manager.js'
import { runRetrySweep } from './order-retry.js'
import { DECISION_STATUS } from './order-lifecycle.js'
import type { EngineClient } from './engine-client.js'

function makeDb() {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = OFF')
  initTraderTables(db)
  seedMomentumStrategy(db)
  db.prepare(`INSERT INTO trader_signals (id, strategy_id, asset, side, raw_score, horizon_days, generated_at, status)
    VALUES ('s1','momentum-stocks','AAPL','buy',0.7,20,?, 'dispatching')`).run(Date.now())
  return db
}

function parkRetry(db: Database.Database, id: string, attempts: number, nextRetryAt: number) {
  db.prepare(`INSERT INTO trader_decisions
    (id, signal_id, action, asset, size_usd, entry_type, thesis, confidence, decided_at, status, submit_attempts, next_retry_at)
    VALUES (?, 's1','buy','AAPL',150,'market','t',0.7,?, ?, ?, ?)`)
    .run(id, Date.now(), DECISION_STATUS.RETRY_PENDING, attempts, nextRetryAt)
}

describe('runRetrySweep', () => {
  let db: ReturnType<typeof makeDb>
  beforeEach(() => { db = makeDb() })

  it('resubmits a due retry_pending decision when no broker order exists', async () => {
    parkRetry(db, 'd1', 1, 1000)
    const client = {
      getOrders: vi.fn().mockResolvedValue([]),
      submitDecision: vi.fn().mockResolvedValue({ client_order_id: 'd1', broker_order_id: 'boid-2', status: 'placed', approved_size_usd: 150 }),
    }
    const s = await runRetrySweep(db, client as unknown as EngineClient, 5000, true)
    expect(s.resubmitted).toBe(1)
    const row = db.prepare("SELECT status, engine_order_id, submit_attempts FROM trader_decisions WHERE id='d1'").get() as any
    expect(row.status).toBe('submitted')
    expect(row.engine_order_id).toBe('boid-2')
    expect(row.submit_attempts).toBe(2)
  })

  it('does NOT resend when the order already exists at the broker (dedup)', async () => {
    parkRetry(db, 'd1', 1, 1000)
    const client = {
      getOrders: vi.fn().mockResolvedValue([{ client_order_id: 'd1', broker_order_id: 'boid-1', asset: 'AAPL', side: 'buy', qty: 1, order_type: 'market', limit_price: null, status: 'new', filled_qty: 0, filled_avg_price: null, source: 't', created_at: 1, updated_at: 1 }]),
      submitDecision: vi.fn(),
    }
    const s = await runRetrySweep(db, client as unknown as EngineClient, 5000, true)
    expect(s.resubmitted).toBe(0)
    expect(vi.mocked(client.submitDecision)).not.toHaveBeenCalled()
    expect((db.prepare("SELECT status FROM trader_decisions WHERE id='d1'").get() as any).status).toBe('submitted')
  })

  it('parks engine_down after MAX_SUBMIT_RETRIES', async () => {
    parkRetry(db, 'd1', 3, 1000) // already at the cap
    const client = { getOrders: vi.fn().mockResolvedValue([]), submitDecision: vi.fn() }
    const s = await runRetrySweep(db, client as unknown as EngineClient, 5000, true)
    expect(s.parkedEngineDown).toBe(1)
    expect((db.prepare("SELECT status FROM trader_decisions WHERE id='d1'").get() as any).status).toBe('engine_down')
  })

  it('parks engine_down (no blind resend) when getOrders throws', async () => {
    parkRetry(db, 'd1', 1, 1000)
    const client = { getOrders: vi.fn().mockRejectedValue(new Error('Engine API error 503 on /orders')), submitDecision: vi.fn() }
    const s = await runRetrySweep(db, client as unknown as EngineClient, 5000, false)
    expect(s.parkedEngineDown).toBe(1)
    expect(vi.mocked(client.submitDecision)).not.toHaveBeenCalled()
  })

  it('resumes engine_down -> retry_pending when the engine is healthy again', async () => {
    db.prepare(`INSERT INTO trader_decisions
      (id, signal_id, action, asset, size_usd, entry_type, thesis, confidence, decided_at, status, submit_attempts)
      VALUES ('d1','s1','buy','AAPL',150,'market','t',0.7,?, ?, 1)`).run(Date.now(), DECISION_STATUS.ENGINE_DOWN)
    const client = {
      getOrders: vi.fn().mockResolvedValue([]),
      submitDecision: vi.fn().mockResolvedValue({ client_order_id: 'd1', broker_order_id: 'boid-3', status: 'placed', approved_size_usd: 150 }),
    }
    const s = await runRetrySweep(db, client as unknown as EngineClient, 5000, true)
    expect(s.resumedFromEngineDown).toBe(1)
    // resumed then immediately retried in the same sweep (submit_attempts was 1 < 3)
    expect((db.prepare("SELECT status FROM trader_decisions WHERE id='d1'").get() as any).status).toBe('submitted')
  })
})
