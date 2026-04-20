import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { initTraderTables } from './db.js'
import { seedMomentumStrategy } from './strategy-manager.js'
import { tryHandleApprovalReply, handleTraderButtonCallback } from './telegram-reply-handler.js'
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
  db.prepare('INSERT INTO trader_approvals (id, decision_id, sent_at) VALUES (?, ?, ?)').run(id, 'sig-1', Date.now())
  return id
}

describe('telegram-reply-handler', () => {
  let db: ReturnType<typeof makeDb>
  beforeEach(() => { db = makeDb() })

  it('parses APPROVE', () => {
    insertPendingApproval(db)
    const result = tryHandleApprovalReply(db, 'APPROVE')
    expect(result).not.toBeNull()
    expect(result!.action).toBe('approve')
    expect(result!.override_size).toBeUndefined()
  })

  it('parses SKIP', () => {
    insertPendingApproval(db)
    const result = tryHandleApprovalReply(db, 'SKIP')
    expect(result!.action).toBe('skip')
  })

  it('parses APPROVE BIGGER 250', () => {
    insertPendingApproval(db)
    const result = tryHandleApprovalReply(db, 'APPROVE BIGGER 250')
    expect(result!.action).toBe('approve')
    expect(result!.override_size).toBe(250)
  })

  it('parses APPROVE BIGGER $250 (dollar sign prefix)', () => {
    insertPendingApproval(db)
    const result = tryHandleApprovalReply(db, 'APPROVE BIGGER $250')
    expect(result).not.toBeNull()
    expect(result!.action).toBe('approve')
    expect(result!.override_size).toBe(250)
  })

  it('caps APPROVE BIGGER 600 at 500 (Phase 1 cap)', () => {
    insertPendingApproval(db)
    const result = tryHandleApprovalReply(db, 'APPROVE BIGGER 600')
    expect(result).not.toBeNull()
    expect(result!.action).toBe('approve')
    expect(result!.override_size).toBe(500)
  })

  it('returns null for APPROVE BIGGER 0 (zero size guard)', () => {
    insertPendingApproval(db)
    const result = tryHandleApprovalReply(db, 'APPROVE BIGGER 0')
    expect(result).toBeNull()
  })

  it('parses PAUSE STRATEGY', () => {
    insertPendingApproval(db)
    const result = tryHandleApprovalReply(db, 'PAUSE STRATEGY')
    expect(result!.action).toBe('pause')
  })

  it('returns null when no pending approval', () => {
    const result = tryHandleApprovalReply(db, 'APPROVE')
    expect(result).toBeNull()
  })

  it('returns null for unrecognized text', () => {
    insertPendingApproval(db)
    const result = tryHandleApprovalReply(db, 'hello there')
    expect(result).toBeNull()
  })

  it('stores fromUserId on parsed reply', () => {
    insertPendingApproval(db)
    const result = tryHandleApprovalReply(db, 'APPROVE', 222222222)
    expect(result).not.toBeNull()
    expect(result!.fromUserId).toBe(222222222)
  })

  it('concurrent claim: only one caller wins when two fire simultaneously', () => {
    // Insert a single pending approval row
    insertPendingApproval(db)

    // Call tryHandleApprovalReply twice synchronously (simulating concurrent webhook retries)
    // SQLite serializes writes, so one UPDATE will find changes===1, the other changes===0
    const result1 = tryHandleApprovalReply(db, 'APPROVE')
    const result2 = tryHandleApprovalReply(db, 'APPROVE')

    // Exactly one should win
    const winners = [result1, result2].filter(r => r !== null)
    expect(winners).toHaveLength(1)
    expect(winners[0]!.action).toBe('approve')

    // The other must return null
    const losers = [result1, result2].filter(r => r === null)
    expect(losers).toHaveLength(1)
  })
})

describe('handleTraderButtonCallback', () => {
  let db: ReturnType<typeof makeDb>
  beforeEach(() => { db = makeDb() })

  function insertApproval(id: string, decisionId = 'sig-1') {
    db.prepare('INSERT INTO trader_approvals (id, decision_id, sent_at) VALUES (?, ?, ?)').run(id, decisionId, Date.now())
  }

  it('claims approve action by approvalId', () => {
    insertApproval('ap-1')
    const result = handleTraderButtonCallback(db, 'ap-1', 'approve', 111111111)
    expect(result).not.toBeNull()
    expect(result!.action).toBe('approve')
    expect(result!.approvalId).toBe('ap-1')
    expect(result!.decisionId).toBe('sig-1')
    expect(result!.override_size).toBeUndefined()
    expect(result!.fromUserId).toBe(111111111)
  })

  it('claims skip action', () => {
    insertApproval('ap-1')
    const result = handleTraderButtonCallback(db, 'ap-1', 'skip')
    expect(result!.action).toBe('skip')
  })

  it('claims pause action', () => {
    insertApproval('ap-1')
    const result = handleTraderButtonCallback(db, 'ap-1', 'pause')
    expect(result!.action).toBe('pause')
  })

  it('bigger maps to approve with Phase 1 override size', () => {
    insertApproval('ap-1')
    const result = handleTraderButtonCallback(db, 'ap-1', 'bigger')
    expect(result!.action).toBe('approve')
    expect(result!.override_size).toBe(BIGGER_SIZE_USD)
  })

  it('returns null for unknown action', () => {
    insertApproval('ap-1')
    const result = handleTraderButtonCallback(db, 'ap-1', 'unknown-action')
    expect(result).toBeNull()
  })

  it('returns null when approval already claimed (duplicate tap)', () => {
    insertApproval('ap-1')
    handleTraderButtonCallback(db, 'ap-1', 'approve')
    const second = handleTraderButtonCallback(db, 'ap-1', 'skip')
    expect(second).toBeNull()
  })

  it('returns null for non-existent approvalId', () => {
    const result = handleTraderButtonCallback(db, 'no-such-id', 'approve')
    expect(result).toBeNull()
  })

  it('does not affect other pending approvals', () => {
    insertApproval('ap-1', 'sig-1')
    insertApproval('ap-2', 'sig-2')
    handleTraderButtonCallback(db, 'ap-1', 'approve')

    const still = db.prepare('SELECT responded_at FROM trader_approvals WHERE id=?').get('ap-2') as any
    expect(still.responded_at).toBeNull()
  })
})
