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
  await handler({query: {}} as unknown as Request, response as unknown as Response)
  return response
}

function routeHandlers(path: string) {
  type Layer = {route?: {path: string; stack: Array<{handle: (req: Request, res: Response, next: () => void) => unknown}>}}
  const layers = router.stack as unknown as Layer[]
  const handlers = layers.find(layer => layer.route?.path === path)?.route?.stack.map(layer => layer.handle)
  if (!handlers) throw new Error('Route missing')
  return handlers
}

function mockResponse() {
  const response = {json: vi.fn(), status: vi.fn()}
  response.status.mockReturnValue(response)
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
  it('orders failures return 503 instead of a false empty blotter', async () => {
    mocks.fetch.mockRejectedValue(new Error('private engine address'))
    const response = await get('/api/v1/trader/orders')
    expect(response.status).toHaveBeenCalledWith(503)
    expect(response.json).toHaveBeenCalledWith({error: 'orders unavailable'})
  })
  it('risk failures return 503 instead of a false clear state', async () => {
    mocks.fetch.mockRejectedValue(new Error('private engine address'))
    const response = await get('/api/v1/trader/risk')
    expect(response.status).toHaveBeenCalledWith(503)
    expect(response.json).toHaveBeenCalledWith({error: 'risk state unavailable'})
  })
  it('keeps successful risk state compatible', async () => {
    const risk = {tripped: [], details: []}
    mocks.fetch.mockResolvedValue(risk)
    const response = await get('/api/v1/trader/risk')
    expect(response.json).toHaveBeenCalledWith(risk)
    expect(response.status).not.toHaveBeenCalled()
  })
  it('bounds and forwards order pagination', async () => {
    const handler = routeHandlers('/api/v1/trader/orders')[0]
    const response = mockResponse()
    mocks.fetch.mockResolvedValue([])
    await handler({query: {status: 'open', limit: '9999', offset: '7'}} as unknown as Request, response as unknown as Response, vi.fn())
    expect(mocks.fetch).toHaveBeenCalledWith(
      {url: 'http://test', token: 'fixture'},
      '/orders?status=open&limit=500&offset=7',
    )
    expect(response.json).toHaveBeenCalledWith([])
  })
  it('rejects non-admin order cancellation before the engine call', () => {
    const middleware = routeHandlers('/api/v1/trader/orders/:clientOrderId/cancel')[0]
    const response = mockResponse()
    const next = vi.fn()
    middleware({user: {isAdmin: false}} as unknown as Request, response as unknown as Response, next)
    expect(response.status).toHaveBeenCalledWith(403)
    expect(next).not.toHaveBeenCalled()
    expect(mocks.fetch).not.toHaveBeenCalled()
  })
  it('validates client ids and proxies admin cancellation without exposing the engine token', async () => {
    const handler = routeHandlers('/api/v1/trader/orders/:clientOrderId/cancel')[1]
    const invalidResponse = mockResponse()
    await handler({params: {clientOrderId: '../escape'}} as unknown as Request, invalidResponse as unknown as Response, vi.fn())
    expect(invalidResponse.status).toHaveBeenCalledWith(400)
    expect(mocks.fetch).not.toHaveBeenCalled()

    mocks.fetch.mockResolvedValue({client_order_id: 'order:123', status: 'pending_cancel', submitted: true})
    const response = mockResponse()
    await handler({params: {clientOrderId: 'order:123'}} as unknown as Request, response as unknown as Response, vi.fn())
    expect(mocks.fetch).toHaveBeenCalledWith(
      {url: 'http://test', token: 'fixture'},
      '/orders/order%3A123/cancel',
      {method: 'POST'},
    )
    expect(response.json).toHaveBeenCalledWith({client_order_id: 'order:123', status: 'pending_cancel', submitted: true})
  })
  it('returns a generic error when engine cancellation fails', async () => {
    const handler = routeHandlers('/api/v1/trader/orders/:clientOrderId/cancel')[1]
    const response = mockResponse()
    mocks.fetch.mockRejectedValue(new Error('http://private-engine:8000 secret detail'))
    await handler({params: {clientOrderId: 'safe-id'}} as unknown as Request, response as unknown as Response, vi.fn())
    expect(response.status).toHaveBeenCalledWith(502)
    expect(response.json).toHaveBeenCalledWith({error: 'order cancellation failed'})
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
  it('returns the minimal stock and crypto strategy status projection', async () => {
    const db = new Database(':memory:')
    db.exec(`CREATE TABLE trader_strategies (
      id TEXT PRIMARY KEY, name TEXT, asset_class TEXT, tier INTEGER,
      status TEXT, updated_at INTEGER
    )`)
    db.prepare('INSERT INTO trader_strategies VALUES (?,?,?,?,?,?)')
      .run('momentum-crypto', 'Bitcoin Momentum', 'crypto', 0, 'paused', 123)
    mocks.db.mockReturnValue(db)
    const response = await get('/api/v1/trader/strategy-status')
    expect(response.json).toHaveBeenCalledWith({available: true, cohorts_available: false, cohorts: [], bitcoin_order_flow_collection: null, strategies: [{
      id: 'momentum-crypto', name: 'Bitcoin Momentum', asset_class: 'crypto',
      tier: 0, status: 'paused', updated_at: 123,
    }]})
    db.close()
  })
  it('returns an allowlisted Bitcoin collection projection without internal fields', async () => {
    const db = new Database(':memory:')
    db.exec(`CREATE TABLE trader_strategies (
      id TEXT PRIMARY KEY, name TEXT, asset_class TEXT, tier INTEGER,
      status TEXT, updated_at INTEGER
    ); CREATE TABLE kv_settings (key TEXT PRIMARY KEY,value TEXT)`)
    db.prepare('INSERT INTO kv_settings VALUES (?,?)').run('trader.bitcoin_order_flow.collection', JSON.stringify({
      state: 'connected', product_id: 'BTC-USD', trades_stored: 12, l2_updates_stored: 34,
      eligible_bars_total: 7, ineligible_bars_total: 2, collection_days_completed: 1,
      minimum_forward_days: 180, earliest_evaluation_at: 456, collection_mature: false,
      evaluation_status: 'awaiting_collection', evaluation_completed_at: null,
      evaluation_holdout_uses: null, evaluation_trade_count: null,
      updated_at: 123, research_db_path: '/private/store.db', remote_text: '<script>',
    }))
    mocks.db.mockReturnValue(db)
    const response = await get('/api/v1/trader/strategy-status')
    expect(response.json).toHaveBeenCalledWith(expect.objectContaining({
      bitcoin_order_flow_collection: {
        state: 'connected', product_id: 'BTC-USD', trades_stored: 12,
        l2_updates_stored: 34, eligible_bars_total: 7, ineligible_bars_total: 2,
        collection_days_completed: 1, minimum_forward_days: 180,
        earliest_evaluation_at: 456, collection_mature: false,
        evaluation_status: 'awaiting_collection', evaluation_completed_at: null,
        evaluation_holdout_uses: null, evaluation_trade_count: null, updated_at: 123,
      },
    }))
    const payload = response.json.mock.calls[0][0]
    expect(JSON.stringify(payload)).not.toContain('private/store')
    expect(JSON.stringify(payload)).not.toContain('<script>')
    db.close()
  })
})
