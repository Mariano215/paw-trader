import { afterEach, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import { syncTraderTablesToServer } from './server-sync.js'

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
