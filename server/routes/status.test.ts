import { beforeEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import type { Request, Response } from 'express'

const mocks = vi.hoisted(() => ({db: vi.fn(), fetch: vi.fn(), config: vi.fn()}))
vi.mock('../db.js', () => ({getBotDb: mocks.db}))
vi.mock('./shared.js', () => ({engineFetch: mocks.fetch, getEngineConfig: mocks.config}))
import router from './status.js'

async function get(path: string) {
  type Layer = {route?: {path: string; stack: Array<{handle: (req: Request, res: Response) => unknown}>}}
  const layers = router.stack as unknown as Layer[]
  const handler = layers.find(layer => layer.route?.path === path)?.route?.stack[0].handle
  if (!handler) throw new Error('Route missing')
  const response = {json: vi.fn(), status: vi.fn()}
  response.status.mockReturnValue(response)
  await handler({} as Request, response as unknown as Response)
  return response
}

describe('status routes without network listeners', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.config.mockReturnValue({url: 'http://test', token: 'fixture'})
    mocks.db.mockReturnValue(null)
  })
  it('positions failures return 503, not empty holdings or raw errors', async () => {
    mocks.fetch.mockRejectedValue(new Error('private engine address'))
    const response = await get('/api/v1/trader/positions')
    expect(response.status).toHaveBeenCalledWith(503)
    expect(response.json).toHaveBeenCalledWith({error: 'positions unavailable'})
  })
  it('keeps successful positions response compatible', async () => {
    mocks.fetch.mockResolvedValue([])
    const response = await get('/api/v1/trader/positions')
    expect(response.json).toHaveBeenCalledWith([])
    expect(response.status).not.toHaveBeenCalled()
  })
  it('marks missing accounting unavailable', async () => {
    const response = await get('/api/v1/trader/broker-pnl')
    expect(response.json).toHaveBeenCalledWith({available: false})
    expect(mocks.fetch).not.toHaveBeenCalled()
  })
  it.each([0, 16 * 60 * 1000])('serves durable accounting with timestamp age %i', async age => {
    const db = new Database(':memory:')
    db.exec('CREATE TABLE kv_settings (key TEXT PRIMARY KEY,value TEXT)')
    const snapshot = {available: true, evaluated_at: Date.now() - age, realized_total: 98,
      open_unrealized: -7.5, net: 90.5, round_trips: 1, costs_complete: false}
    db.prepare('INSERT INTO kv_settings VALUES (?,?)').run('trader.accounting.last', JSON.stringify(snapshot))
    mocks.db.mockReturnValue(db)
    const response = await get('/api/v1/trader/broker-pnl')
    expect(response.json).toHaveBeenCalledWith({...snapshot, stale: age > 0})
    expect(mocks.fetch).not.toHaveBeenCalled()
    db.close()
  })
})
