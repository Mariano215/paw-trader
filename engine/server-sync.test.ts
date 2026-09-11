import { afterEach, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import { syncTraderTablesToServer } from './server-sync.js'
import { initTraderTables } from './db.js'
import { recordTraderOperationalEvent } from './operational-events.js'

vi.mock('../config.js', () => ({
  DASHBOARD_URL: 'https://dashboard.example.invalid',
  BOT_API_TOKEN: 'test-token', DASHBOARD_API_TOKEN: 'test-admin',
}))

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs() })

it('never reads fixture rows or sends dashboard writes in test mode with configured credentials', async () => {
  vi.stubEnv('NODE_ENV', 'test')
  const fetch = vi.fn()
  vi.stubGlobal('fetch', fetch)
  const db = new Database(':memory:')
  const prepare = vi.spyOn(db, 'prepare')
  try {
    await syncTraderTablesToServer(db)
    expect(prepare).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
  } finally { db.close() }
})

it('advances the append-only event cursor only after a successful sync', async () => {
  vi.stubEnv('NODE_ENV', 'production')
  const fetch = vi.fn().mockResolvedValue({ ok: true, status: 200 })
  vi.stubGlobal('fetch', fetch)
  const db = new Database(':memory:')
  try {
    initTraderTables(db)
    db.prepare('CREATE TABLE IF NOT EXISTS kv_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)').run()
    db.prepare('INSERT INTO kv_settings (key,value) VALUES (?,?)').run(
      'trader.bitcoin_order_flow.collection',
      JSON.stringify({state: 'connected', product_id: 'BTC-USD'}),
    )
    for (const eventId of ['event-1', 'event-2']) {
      recordTraderOperationalEvent(db, {
        eventId,
        source: 'brain.scheduler',
        stage: 'scheduler',
        eventType: 'scheduler.tick.completed',
        state: 'completed',
      })
    }

    await syncTraderTablesToServer(db)
    const firstPayload = JSON.parse(fetch.mock.calls[0][1].body as string)
    expect(firstPayload.operational_events.map((row: { event_id: string }) => row.event_id))
      .toEqual(['event-1', 'event-2'])
    expect(firstPayload.kv).toContainEqual({
      key: 'trader.bitcoin_order_flow.collection',
      value: JSON.stringify({state: 'connected', product_id: 'BTC-USD'}),
    })
    expect(db.prepare("SELECT value FROM kv_settings WHERE key='trader.operational_events.server_sync_seq'").get())
      .toEqual({ value: '2' })

    recordTraderOperationalEvent(db, {
      eventId: 'event-3',
      source: 'brain.scheduler',
      stage: 'scheduler',
      eventType: 'scheduler.tick.completed',
      state: 'completed',
    })
    await syncTraderTablesToServer(db)
    const secondPayload = JSON.parse(fetch.mock.calls[1][1].body as string)
    expect(secondPayload.operational_events.map((row: { event_id: string }) => row.event_id))
      .toEqual(['event-3'])
  } finally { db.close() }
})
