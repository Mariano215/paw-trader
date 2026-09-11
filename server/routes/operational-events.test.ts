import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import type { Request } from 'express'
import {
  canReadTraderOperationalEvents,
  parseNonNegativeInteger,
  queryTraderOperationalEvents,
} from './operational-events.js'

let testDb: Database.Database

beforeAll(() => {
  testDb = new Database(':memory:')
  testDb.exec(`CREATE TABLE trader_operational_events (
    seq INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT UNIQUE, project_id TEXT,
    source_ts INTEGER, recorded_at INTEGER, source TEXT, stage TEXT,
    event_type TEXT, state TEXT, asset TEXT, strategy_id TEXT, signal_id TEXT,
    decision_id TEXT, cohort_id TEXT, order_id TEXT, metadata_json TEXT
  )`)
  const insert = testDb.prepare(`INSERT INTO trader_operational_events
    (event_id,project_id,source_ts,recorded_at,source,stage,event_type,state,asset,metadata_json)
    VALUES (?,?,?,?,?,?,?,?,?,?)`)
  insert.run('e1','trader',1000,1001,'brain.scheduler','scheduler','scheduler.tick.started','started',null,'{}')
  insert.run('e2','trader',2000,2001,'brain.reconciler','reconcile','reconcile.run.completed','completed',null,'{"checked":2}')
  insert.run('other','other-project',3000,3001,'brain.scheduler','scheduler','scheduler.tick.started','started',null,'{}')
})

afterAll(() => { testDb.close() })

describe('trader operational event query', () => {
  it('returns only the latest trader event with a monotonic cursor', () => {
    const result = queryTraderOperationalEvents(testDb, null, 1)
    expect(result.events.map(event => event.event_id)).toEqual(['e2'])
    expect(result.events[0].metadata).toEqual({ checked: 2 })
    expect(result.cursor).toBe(2)
    expect(result.has_more).toBe(true)
  })

  it('returns committed rows after the cursor in ascending order', () => {
    const result = queryTraderOperationalEvents(testDb, 0, 20)
    expect(result.events.map(event => event.event_id)).toEqual(['e1', 'e2'])
    expect(result.cursor).toBe(2)
  })

  it('allows only admins or trader-scoped viewers', () => {
    const request = (isAdmin: boolean, allowedProjectIds: string[]) => ({
      user: { isAdmin }, scope: { allowedProjectIds },
    }) as unknown as Request
    expect(canReadTraderOperationalEvents(request(false, ['trader']))).toBe(true)
    expect(canReadTraderOperationalEvents(request(true, []))).toBe(true)
    expect(canReadTraderOperationalEvents(request(false, ['other']))).toBe(false)
  })

  it('rejects malformed cursors', () => {
    expect(parseNonNegativeInteger('-1')).toBeNull()
    expect(parseNonNegativeInteger('1.5')).toBeNull()
    expect(parseNonNegativeInteger('2')).toBe(2)
  })
})
