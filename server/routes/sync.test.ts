import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'

const broadcastTraderUpdate = vi.fn()
vi.mock('../ws.js', () => ({ broadcastTraderUpdate }))

const { commitTraderSync } = await import('./sync.js')

let testDb: Database.Database

beforeEach(() => {
  testDb = new Database(':memory:')
  testDb.exec(`CREATE TABLE trader_operational_events (
    seq INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT NOT NULL UNIQUE,
    project_id TEXT NOT NULL, source_ts INTEGER NOT NULL, recorded_at INTEGER NOT NULL,
    source TEXT NOT NULL, stage TEXT NOT NULL, event_type TEXT NOT NULL,
    state TEXT NOT NULL, asset TEXT, strategy_id TEXT, signal_id TEXT,
    decision_id TEXT, cohort_id TEXT, order_id TEXT, metadata_json TEXT NOT NULL
  )`)
  broadcastTraderUpdate.mockClear()
})

afterEach(() => { testDb.close() })

const validEvent = {
  event_id: 'event-1', project_id: 'trader', source_ts: 1000, recorded_at: 1001,
  source: 'brain.scheduler', stage: 'scheduler', event_type: 'scheduler.tick.started',
  state: 'started', asset: null, strategy_id: null, signal_id: null,
  decision_id: null, cohort_id: null, order_id: null,
  metadata_json: '{"checked":1}',
}

describe('operational event sync commit', () => {
  it('inserts once and broadcasts only after a new committed row exists', () => {
    const first = commitTraderSync(testDb, { operational_events: [validEvent] })
    expect(first.operational_events).toBe(1)
    expect((testDb.prepare('SELECT count(*) AS n FROM trader_operational_events').get() as {n:number}).n).toBe(1)
    expect(broadcastTraderUpdate).toHaveBeenCalledWith('trader', 1)

    broadcastTraderUpdate.mockClear()
    const duplicate = commitTraderSync(testDb, { operational_events: [validEvent] })
    expect(duplicate.operational_events).toBe(0)
    expect(broadcastTraderUpdate).not.toHaveBeenCalled()
  })

  it('rejects wrong-project and non-allowlisted metadata without broadcasting', () => {
    const result = commitTraderSync(testDb, { operational_events: [
      { ...validEvent, event_id: 'wrong-project', project_id: 'other' },
      { ...validEvent, event_id: 'secret', metadata_json: '{"secret":"credential"}' },
      { ...validEvent, event_id: null },
      null as unknown as Record<string, unknown>,
    ] })
    expect(result.operational_events).toBe(0)
    expect((testDb.prepare('SELECT count(*) AS n FROM trader_operational_events').get() as {n:number}).n).toBe(0)
    expect(broadcastTraderUpdate).not.toHaveBeenCalled()
  })

  it('accepts allowlisted Bitcoin research health events', () => {
    const result = commitTraderSync(testDb, {operational_events: [{
      ...validEvent,
      event_id: 'research-1',
      source: 'coinbase.public-market-data',
      stage: 'research',
      event_type: 'research.collector.watchdog',
      state: 'completed',
      asset: 'BTC-USD',
      strategy_id: 'order-flow-imbalance-crypto',
      metadata_json: '{"channel":"level2","trades_stored":12,"eligible":true}',
    }]})
    expect(result.operational_events).toBe(1)
    expect(testDb.prepare("SELECT stage,event_type FROM trader_operational_events WHERE event_id='research-1'").get())
      .toEqual({stage: 'research', event_type: 'research.collector.watchdog'})
  })
})
