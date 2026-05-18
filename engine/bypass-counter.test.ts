import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import { countBypassTrades, countTradesToday, resetCountersForTest, startOfNyDayMs } from './bypass-counter.js'

function freshDb(): Database.Database {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE trader_decisions (
      id TEXT PRIMARY KEY,
      signal_id TEXT NOT NULL,
      action TEXT NOT NULL,
      asset TEXT NOT NULL,
      thesis TEXT NOT NULL,
      confidence REAL NOT NULL,
      committee_transcript_id TEXT,
      decided_at INTEGER NOT NULL,
      status TEXT NOT NULL
    );
  `)
  return db
}

function insertDecision(db: Database.Database, p: {
  id: string, action: string, thesis: string, status: string, decided_at: number
}): void {
  db.prepare(`
    INSERT INTO trader_decisions
      (id, signal_id, action, asset, thesis, confidence, decided_at, status)
    VALUES (?, ?, ?, 'AAPL', ?, 0.5, ?, ?)
  `).run(p.id, 'sig-' + p.id, p.action, p.thesis, p.decided_at, p.status)
}

describe('bypass-counter', () => {
  beforeEach(() => resetCountersForTest())
  afterEach(() => resetCountersForTest())

  it('countBypassTrades returns 0 when DB empty', () => {
    const db = freshDb()
    expect(countBypassTrades(db)).toBe(0)
  })

  it('counts only [BYPASS thesis decisions where status != rejected', () => {
    const db = freshDb()
    insertDecision(db, { id: 'd1', action: 'buy', thesis: '[BYPASS#1/20] x', status: 'approved', decided_at: Date.now() })
    insertDecision(db, { id: 'd2', action: 'buy', thesis: '[BYPASS#2/20] y', status: 'dispatched', decided_at: Date.now() })
    insertDecision(db, { id: 'd3', action: 'buy', thesis: '[BYPASS#3/20] z', status: 'rejected', decided_at: Date.now() })
    insertDecision(db, { id: 'd4', action: 'buy', thesis: 'committee approved', status: 'approved', decided_at: Date.now() })
    expect(countBypassTrades(db)).toBe(2)
  })

  it('countTradesToday excludes abstain action', () => {
    const db = freshDb()
    const now = Date.now()
    insertDecision(db, { id: 'd1', action: 'buy', thesis: 't', status: 'approved', decided_at: now })
    insertDecision(db, { id: 'd2', action: 'sell', thesis: 't', status: 'approved', decided_at: now })
    insertDecision(db, { id: 'd3', action: 'abstain', thesis: 't', status: 'committee_abstain', decided_at: now })
    expect(countTradesToday(db)).toBe(2)
  })

  it('countTradesToday uses NY day boundary', () => {
    const db = freshDb()
    const tenDaysAgo = Date.now() - (10 * 24 * 60 * 60 * 1000)
    insertDecision(db, { id: 'd1', action: 'buy', thesis: 't', status: 'approved', decided_at: tenDaysAgo })
    insertDecision(db, { id: 'd2', action: 'buy', thesis: 't', status: 'approved', decided_at: Date.now() })
    expect(countTradesToday(db)).toBe(1)
  })

  it('caches results for 30s', () => {
    const db = freshDb()
    insertDecision(db, { id: 'd1', action: 'buy', thesis: '[BYPASS#1/20] x', status: 'approved', decided_at: Date.now() })
    const spy = vi.spyOn(db, 'prepare')
    countBypassTrades(db)
    countBypassTrades(db)
    countBypassTrades(db)
    expect(spy).toHaveBeenCalledTimes(1)
    spy.mockRestore()
  })

  it('startOfNyDayMs returns midnight NY time as UTC ms', () => {
    const sample = new Date('2026-05-17T14:00:00Z').getTime()
    const startMs = startOfNyDayMs(sample)
    const startDate = new Date(startMs)
    const nyFormatted = startDate.toLocaleString('en-US', { timeZone: 'America/New_York' })
    expect(nyFormatted).toMatch(/12:00:00\s*AM/)
  })
})
