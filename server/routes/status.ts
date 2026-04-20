/**
 * trader-routes/status.ts
 *
 * Seven engine-fronted endpoints: status, positions, orders, risk, halt,
 * clear-breaker, nav-snapshots.  All are thin proxies over the Paw Trader
 * engine REST API.  Read routes return empty/offline shapes on engine
 * failure so the dashboard renders "offline" rather than a hard error;
 * mutation routes (halt, clear-breaker) surface engine failures with 5xx.
 */

import { Router, type Request, type Response } from 'express'
import { requireAdmin } from '../auth.js'
import {
  engineFetch,
  getEngineConfig,
  type EngineHealth,
  type EngineReconcile,
} from './shared.js'

const router = Router()

// ---------------------------------------------------------------------------
// GET /api/v1/trader/status
// Always returns 200. engine_connected=false when creds missing or engine
// unreachable -- the frontend renders "offline" rather than a hard error.
// ---------------------------------------------------------------------------

router.get('/api/v1/trader/status', async (_req: Request, res: Response) => {
  const cfg = getEngineConfig()
  if (!cfg) {
    res.json({
      engine_connected: false,
      error: 'engine credentials not configured - see docs/trader-setup.md',
    })
    return
  }
  try {
    const health = await engineFetch<EngineHealth>(cfg, '/health')
    let reconcile: EngineReconcile | null = null
    try {
      reconcile = await engineFetch<EngineReconcile>(cfg, '/reconcile/last')
    } catch {
      // /reconcile/last is allowed to fail quietly -- reconcile may not have
      // run yet, and we don't want to flip the whole status to offline.
      reconcile = null
    }
    res.json({
      engine_connected: true,
      engine_status: health.status,
      alpaca_connected: health.alpaca_connected,
      alpaca_mode: health.alpaca_mode,
      // Phase 5 Task 2c -- null when the engine response is missing the
      // field (older build); the frontend hides the Coinbase pill in
      // that case rather than showing "Coinbase ERROR".
      coinbase_connected: health.coinbase_connected ?? null,
      last_reconcile: reconcile,
    })
  } catch (err) {
    res.json({ engine_connected: false, error: String(err) })
  }
})

// ---------------------------------------------------------------------------
// GET /api/v1/trader/positions
// Phase 0 stub - returns [] when engine is not reachable. Phase 1 will wire
// actual positions through to the dashboard grid.
// ---------------------------------------------------------------------------

router.get('/api/v1/trader/positions', async (_req: Request, res: Response) => {
  const cfg = getEngineConfig()
  if (!cfg) {
    res.json([])
    return
  }
  try {
    const positions = await engineFetch<unknown[]>(cfg, '/positions')
    res.json(positions)
  } catch {
    res.json([])
  }
})

// ---------------------------------------------------------------------------
// GET /api/v1/trader/orders
// ---------------------------------------------------------------------------

router.get('/api/v1/trader/orders', async (_req: Request, res: Response) => {
  const cfg = getEngineConfig()
  if (!cfg) {
    res.json([])
    return
  }
  try {
    const orders = await engineFetch<unknown[]>(cfg, '/orders')
    res.json(orders)
  } catch {
    res.json([])
  }
})

// ---------------------------------------------------------------------------
// GET /api/v1/trader/risk
// Returns { tripped: string[], details: Array<{ rule, tripped_at, reason }> }
// Always returns 200. Returns { tripped: [], details: [] } on engine error.
// ---------------------------------------------------------------------------

router.get('/api/v1/trader/risk', async (_req: Request, res: Response) => {
  const cfg = getEngineConfig()
  if (!cfg) {
    res.json({ tripped: [], details: [] })
    return
  }
  try {
    const risk = await engineFetch<{ tripped: string[]; details: unknown[] }>(cfg, '/risk/state')
    res.json(risk)
  } catch {
    res.json({ tripped: [], details: [] })
  }
})

// ---------------------------------------------------------------------------
// POST /api/v1/trader/halt
// Body: { reason: string }
// Returns { status: string }
// ---------------------------------------------------------------------------

router.post('/api/v1/trader/halt', requireAdmin, async (req: Request, res: Response) => {
  const cfg = getEngineConfig()
  if (!cfg) {
    res.status(503).json({ error: 'engine credentials not configured' })
    return
  }
  const reason = ((req.body as { reason?: string })?.reason) || 'manual halt via dashboard'
  try {
    const data = await engineFetch<{ status: string }>(cfg, '/risk/halt', {
      method: 'POST',
      body: JSON.stringify({ reason }),
    })
    res.json(data)
  } catch (err) {
    res.status(502).json({ error: String(err) })
  }
})

// ---------------------------------------------------------------------------
// POST /api/v1/trader/clear-breaker
// Body: { rule: string }
// Returns { status: string }
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// GET /api/v1/trader/nav-snapshots?limit=N  (Phase 7 Task 1)
//
// Thin proxy over the engine's /nav/snapshots.  Powers the NAV equity
// curve on the trader page.  Default limit 90 (approx three months of
// day_open snapshots, which is the default chart window).  Client-
// supplied limit is clamped to [1, 3650] (~10y) so an operator typing
// "?limit=all" does not explode memory.  Always 200 with { snapshots:
// [] } on engine failure so the chart renders "no data yet" instead of
// a hard error.
// ---------------------------------------------------------------------------

const NAV_SNAPSHOTS_DEFAULT_LIMIT = 90
const NAV_SNAPSHOTS_MAX_LIMIT = 3650

router.get('/api/v1/trader/nav-snapshots', async (req: Request, res: Response) => {
  const cfg = getEngineConfig()
  if (!cfg) {
    res.json({ snapshots: [] })
    return
  }
  const rawLimit = Number(req.query.limit)
  const limit = (
    Number.isFinite(rawLimit) && Number.isInteger(rawLimit) && rawLimit >= 1
  ) ? Math.min(rawLimit, NAV_SNAPSHOTS_MAX_LIMIT) : NAV_SNAPSHOTS_DEFAULT_LIMIT
  try {
    const snapshots = await engineFetch<unknown[]>(cfg, `/nav/snapshots?limit=${limit}`)
    res.json({ snapshots })
  } catch {
    res.json({ snapshots: [] })
  }
})

router.post('/api/v1/trader/clear-breaker', requireAdmin, async (req: Request, res: Response) => {
  const cfg = getEngineConfig()
  if (!cfg) {
    res.status(503).json({ error: 'engine credentials not configured' })
    return
  }
  const rule = (req.body as { rule?: string })?.rule
  if (!rule) {
    res.status(400).json({ error: 'rule is required' })
    return
  }
  try {
    const data = await engineFetch<{ status: string }>(cfg, '/risk/clear', {
      method: 'POST',
      body: JSON.stringify({ rule }),
    })
    res.json(data)
  } catch (err) {
    res.status(502).json({ error: String(err) })
  }
})

export default router
