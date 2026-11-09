import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { initTraderTables } from './db.js'
import { seedMomentumStrategy } from './strategy-manager.js'
import { handleTraderSignalAction } from './telegram-reply-handler.js'
import { BIGGER_SIZE_USD } from './approval-manager.js'

function makeDb() {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = OFF')
  initTraderTables(db)
  seedMomentumStrategy(db)
  return db
}

function insertPendingApproval(db: Database.Database): string {
  const id = 'ap-test-1'
  db.prepare(`
    INSERT INTO trader_signals (id, strategy_id, asset, side, raw_score, horizon_days, generated_at, status)
    VALUES ('sig-1', 'momentum-stocks', 'AAPL', 'buy', 0.72, 20, ?, 'pending')
  `).run(Date.now())
  db.prepare('INSERT INTO trader_approvals (id, decision_id, sent_at) VALUES (?, ?, ?)').run(id, 'sig-1', Date.now())
  return id
}


describe('handleTraderSignalAction', () => {
  let db: ReturnType<typeof makeDb>
  beforeEach(() => { db = makeDb() })

  it('claims an existing pending approval by signal id', () => {
    insertPendingApproval(db)
    const result = handleTraderSignalAction(db, 'sig-1', 'approve', 42)
    expect(result).not.toBeNull()
    expect(result!.approvalId).toBe('ap-test-1')
    expect(result!.decisionId).toBe('sig-1')
    expect(result!.action).toBe('approve')
    expect(result!.fromUserId).toBe(42)
  })

  it('creates an immediate approval row when the signal never had a sent card', () => {
    db.prepare(`
      INSERT INTO trader_signals (id, strategy_id, asset, side, raw_score, horizon_days, generated_at, status)
      VALUES ('sig-dashboard-1', 'momentum-stocks', 'NVDA', 'buy', 0.81, 20, ?, 'pending')
    `).run(Date.now())

    const result = handleTraderSignalAction(db, 'sig-dashboard-1', 'bigger')
    expect(result).not.toBeNull()
    expect(result!.decisionId).toBe('sig-dashboard-1')
    expect(result!.action).toBe('approve')
    expect(result!.override_size).toBe(BIGGER_SIZE_USD)

    const row = db.prepare(`
      SELECT decision_id, response, responded_at, override_size
      FROM trader_approvals
      WHERE id = ?
    `).get(result!.approvalId) as {
      decision_id: string
      response: string
      responded_at: number
      override_size: number
    }
    expect(row.decision_id).toBe('sig-dashboard-1')
    expect(row.response).toBe('approve')
    expect(row.responded_at).toBeGreaterThan(0)
    expect(row.override_size).toBe(BIGGER_SIZE_USD)
  })

  it('returns null when the latest approval for a signal was already responded', () => {
    insertPendingApproval(db)
    handleTraderSignalAction(db, 'sig-1', 'approve')

    const result = handleTraderSignalAction(db, 'sig-1', 'skip')
    expect(result).toBeNull()
  })

  it('returns null for an unknown signal id', () => {
    const result = handleTraderSignalAction(db, 'no-such-signal', 'approve')
    expect(result).toBeNull()
  })
})
