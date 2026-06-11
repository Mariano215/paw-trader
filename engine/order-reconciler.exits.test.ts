import { describe, it, expect, vi } from 'vitest'
import Database from 'better-sqlite3'
import { initTraderTables } from './db.js'
import { reconcileOpenOrders, EXIT_ORPHAN_HORIZON_MS } from './order-reconciler.js'
import type { EngineClient } from './engine-client.js'

/**
 * Live incident 2026-06-11: two exit orders were accepted by the engine
 * pre-market (rows at exit_submitted), then the engine restarted and the
 * queued orders were lost. Nothing tracked exit_submitted rows -- the
 * duplicate guard blocked any retry forever while no closing order existed
 * at the broker. The reconciler now owns exit rows:
 *   filled        -> 'closed'
 *   canceled/...  -> row DELETED (guard freed; sweep retries)
 *   orphaned      -> row DELETED after EXIT_ORPHAN_HORIZON_MS
 *   live unfilled -> untouched
 */

const NOW = Date.now()

function makeDb() {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  initTraderTables(db)
  db.prepare(`INSERT INTO trader_strategies (id,name,asset_class,tier,status,params_json,created_at,updated_at)
    VALUES ('momentum-stocks','M','equity',1,'active','{}',?,?)`).run(NOW, NOW)
  db.prepare(`INSERT INTO trader_signals (id,strategy_id,asset,side,raw_score,horizon_days,generated_at,status)
    VALUES ('s1','momentum-stocks','SPY','buy',0.8,20,?,'executed')`).run(NOW)
  db.prepare(`INSERT INTO trader_decisions
    (id,signal_id,action,asset,size_usd,entry_type,thesis,confidence,decided_at,status)
    VALUES ('d-entry','s1','buy','SPY',2000,'market','t',0.7,?,'executed')`).run(NOW)
  return db
}

function seedExit(db: Database.Database, id: string, decidedAt: number) {
  db.prepare(`INSERT INTO trader_decisions
    (id,signal_id,parent_decision_id,action,asset,size_usd,entry_type,thesis,confidence,decided_at,status)
    VALUES (?,'s1','d-entry','sell','SPY',0,'market','exit',1,?,'exit_submitted')`).run(id, decidedAt)
}

function clientWith(orders: unknown[]): EngineClient {
  return { getOrders: vi.fn().mockResolvedValue(orders) } as unknown as EngineClient
}

describe('reconcileOpenOrders: exit_submitted rows', () => {
  it('promotes a filled exit to closed and records the fill', async () => {
    const db = makeDb()
    seedExit(db, 'd-exit', NOW)
    const client = clientWith([{
      client_order_id: 'd-exit', broker_order_id: 'b1', asset: 'SPY', side: 'sell',
      qty: 0.7, order_type: 'market', limit_price: null, status: 'filled',
      filled_qty: 0.7, filled_avg_price: 725.5, source: 'alpaca', created_at: NOW, updated_at: NOW,
    }])
    const sum = await reconcileOpenOrders(db, client)
    expect(sum.promotedToFilled).toBe(1)
    const row = db.prepare("SELECT status, filled_qty FROM trader_decisions WHERE id='d-exit'").get() as any
    expect(row.status).toBe('closed')
    expect(row.filled_qty).toBe(0.7)
    const fill = db.prepare("SELECT side, fill_qty FROM trader_fills WHERE decision_id='d-exit'").get() as any
    expect(fill.side).toBe('sell')
  })

  it('DELETES a canceled exit row so the sweep can retry (not marked failed)', async () => {
    const db = makeDb()
    seedExit(db, 'd-exit', NOW)
    const client = clientWith([{
      client_order_id: 'd-exit', broker_order_id: 'b1', asset: 'SPY', side: 'sell',
      qty: 0.7, order_type: 'market', limit_price: null, status: 'canceled',
      filled_qty: 0, filled_avg_price: null, source: 'alpaca', created_at: NOW, updated_at: NOW,
    }])
    const sum = await reconcileOpenOrders(db, client)
    expect(sum.canceledOrRejected).toBe(1)
    expect(db.prepare("SELECT id FROM trader_decisions WHERE id='d-exit'").get()).toBeUndefined()
  })

  it('DELETES an orphaned exit row after the exit horizon (engine-restart loss)', async () => {
    const db = makeDb()
    seedExit(db, 'd-exit', NOW - EXIT_ORPHAN_HORIZON_MS - 1000)
    const sum = await reconcileOpenOrders(db, clientWith([]))
    expect(sum.expiredOrphans).toBe(1)
    expect(db.prepare("SELECT id FROM trader_decisions WHERE id='d-exit'").get()).toBeUndefined()
  })

  it('leaves a recent unmatched exit alone (propagation lag)', async () => {
    const db = makeDb()
    seedExit(db, 'd-exit', NOW)
    const sum = await reconcileOpenOrders(db, clientWith([]))
    expect(sum.expiredOrphans).toBe(0)
    const row = db.prepare("SELECT status FROM trader_decisions WHERE id='d-exit'").get() as any
    expect(row.status).toBe('exit_submitted')
  })

  it('leaves a live unfilled exit at exit_submitted (guard state preserved)', async () => {
    const db = makeDb()
    seedExit(db, 'd-exit', NOW)
    const client = clientWith([{
      client_order_id: 'd-exit', broker_order_id: 'b1', asset: 'SPY', side: 'sell',
      qty: 0.7, order_type: 'market', limit_price: null, status: 'accepted',
      filled_qty: 0, filled_avg_price: null, source: 'alpaca', created_at: NOW, updated_at: NOW,
    }])
    const sum = await reconcileOpenOrders(db, client)
    const row = db.prepare("SELECT status FROM trader_decisions WHERE id='d-exit'").get() as any
    expect(row.status).toBe('exit_submitted')
    expect(sum.promotedToPending).toBe(0)
  })
})
