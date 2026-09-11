import { beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { initTraderTables } from './db.js'
import {
  recordTraderOperationalEvent,
  sanitizeTraderOperationalMetadata,
} from './operational-events.js'

describe('trader operational event ledger', () => {
  let db: Database.Database

  beforeEach(() => {
    db = new Database(':memory:')
    initTraderTables(db)
  })

  it('appends a project-scoped event and strips metadata outside the allowlist', () => {
    const id = recordTraderOperationalEvent(db, {
      eventId: 'event-1', sourceTs: 1000, recordedAt: 1001,
      source: 'brain.scheduler', stage: 'scheduler', eventType: 'scheduler.tick.started', state: 'started',
      metadata: { checked: 2, secret: 'do-not-store', reason: 'normal', nested: { token: 'x' } },
    })
    expect(id).toBe('event-1')
    const row = db.prepare('SELECT * FROM trader_operational_events').get() as Record<string, unknown>
    expect(row.project_id).toBe('trader')
    expect(row.source_ts).toBe(1000)
    expect(JSON.parse(String(row.metadata_json))).toEqual({ checked: 2, reason: 'normal' })
  })

  it('deduplicates a stable event ID', () => {
    const input = { eventId: 'same', source: 'brain.scheduler', stage: 'scheduler' as const,
      eventType: 'scheduler.tick.started', state: 'started' as const }
    recordTraderOperationalEvent(db, input)
    recordTraderOperationalEvent(db, input)
    expect((db.prepare('SELECT count(*) AS n FROM trader_operational_events').get() as {n:number}).n).toBe(1)
  })

  it('rejects updates and deletes at the database boundary', () => {
    recordTraderOperationalEvent(db, {
      source: 'brain.scheduler', stage: 'scheduler', eventType: 'scheduler.tick.started', state: 'started',
    })
    expect(() => db.prepare("UPDATE trader_operational_events SET state='failed'").run()).toThrow(/append-only/)
    expect(() => db.prepare('DELETE FROM trader_operational_events').run()).toThrow(/append-only/)
  })

  it('rejects unsafe tokens and string metadata', () => {
    expect(recordTraderOperationalEvent(db, {
      source: 'brain scheduler with spaces', stage: 'scheduler', eventType: 'scheduler.tick.started', state: 'started',
    })).toBeNull()
    expect(sanitizeTraderOperationalMetadata({ reason: 'raw broker response with spaces', status: 'filled' }))
      .toEqual({ status: 'filled' })
  })
})
