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
      reconciler_halted: (health as { reconciler_halted?: boolean }).reconciler_halted ?? false,
      halt_reason: (health as { halt_reason?: string | null }).halt_reason ?? null,
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

// ---------------------------------------------------------------------------
// GET /api/v1/trader/overview
//
// Aggregated KPI data for the dashboard strip: current NAV, today P&L, and
// rolling 7-day P&L.  Derived from the last 7 nav snapshots so no new engine
// endpoint is required.  Snapshots are expected newest-first from the engine.
// Always returns 200 with null fields on engine failure.
// ---------------------------------------------------------------------------

interface NavSnapshot {
  nav?: number
  period?: string
  recorded_at?: number
  [key: string]: unknown
}

router.get('/api/v1/trader/overview', async (_req: Request, res: Response) => {
  const cfg = getEngineConfig()
  if (!cfg) {
    res.json({ nav: null, today_pnl: null, week_pnl: null })
    return
  }
  try {
    // Engine returns snapshots newest-first with mixed periods
    // (day_open, day_close, week_open). NAV is the newest snapshot's
    // value; today P&L is current NAV minus the most recent day_open;
    // week P&L is current NAV minus the most recent week_open. Limit 30
    // keeps the latest day_open and week_open in range.
    const snapshots = await engineFetch<NavSnapshot[]>(cfg, '/nav/snapshots?limit=30')
    const arr = Array.isArray(snapshots) ? snapshots : []
    const nav = arr[0]?.nav ?? null
    const dayOpen = arr.find((s) => s.period === 'day_open')?.nav
    const weekOpen = arr.find((s) => s.period === 'week_open')?.nav
    const today_pnl = (nav != null && dayOpen != null) ? nav - dayOpen : null
    const week_pnl = (nav != null && weekOpen != null) ? nav - weekOpen : null
    res.json({ nav, today_pnl, week_pnl })
  } catch {
    res.json({ nav: null, today_pnl: null, week_pnl: null })
  }
})

// ---------------------------------------------------------------------------
// GET /api/v1/trader/broker-pnl
// Realized P&L from ENGINE filled orders (FIFO per asset) + open unrealized
// from engine positions. Broker truth: matches scripts/verify-trader-pnl.mjs
// and src/trader/go-live-gate.ts computeBrokerTruth. FIFO is inlined here
// because the server compiles independently of bot source.
// ---------------------------------------------------------------------------

interface EngineOrderLite {
  asset: string
  side: 'buy' | 'sell'
  status: string
  filled_qty: number
  filled_avg_price: number | null
  updated_at: number
}

interface EnginePositionLite {
  asset: string
  qty: number
  unrealized_pnl?: number
}

function fifoRealized(fills: Array<{ side: string; qty: number; price: number }>): { roundTrips: number; realized: number } {
  const open: Array<{ qty: number; price: number }> = []
  let roundTrips = 0
  let realized = 0
  for (const f of fills) {
    if (f.side === 'buy') { open.push({ qty: f.qty, price: f.price }); continue }
    let rem = f.qty
    while (rem > 1e-12 && open.length > 0) {
      const lot = open[0]
      const m = Math.min(rem, lot.qty)
      realized += (f.price - lot.price) * m
      roundTrips++
      lot.qty -= m; rem -= m
      if (lot.qty <= 1e-12) open.shift()
    }
  }
  return { roundTrips, realized }
}

router.get('/api/v1/trader/broker-pnl', async (_req: Request, res: Response) => {
  const cfg = getEngineConfig()
  if (!cfg) {
    res.json({ available: false })
    return
  }
  try {
    const [orders, positions] = await Promise.all([
      engineFetch<EngineOrderLite[]>(cfg, '/orders'),
      engineFetch<EnginePositionLite[]>(cfg, '/positions'),
    ])
    // Dedup by order id first: if the engine ever returns a partially_filled
    // snapshot AND the final filled row for the same order, counting both
    // would inflate realized P&L. filled_qty only grows, so keep the max.
    const latestByOrder = new Map<string, EngineOrderLite & { client_order_id?: string }>()
    for (const o of (Array.isArray(orders) ? orders : []) as Array<EngineOrderLite & { client_order_id?: string }>) {
      const key = o.client_order_id ?? `${o.asset}:${o.side}:${o.updated_at}`
      const prev = latestByOrder.get(key)
      if (!prev || (o.filled_qty ?? 0) > (prev.filled_qty ?? 0)) latestByOrder.set(key, o)
    }
    const byAsset = new Map<string, Array<{ side: string; qty: number; price: number; ts: number }>>()
    for (const o of latestByOrder.values()) {
      const status = (o.status ?? '').toLowerCase()
      if (!(o.filled_qty > 0) || (status !== 'filled' && status !== 'partially_filled')) continue
      const rows = byAsset.get(o.asset) ?? []
      rows.push({ side: o.side, qty: o.filled_qty, price: o.filled_avg_price ?? 0, ts: o.updated_at })
      byAsset.set(o.asset, rows)
    }
    let realizedTotal = 0
    let roundTrips = 0
    const perAsset: Array<{ asset: string; round_trips: number; realized: number }> = []
    for (const [asset, fills] of byAsset) {
      fills.sort((a, b) => a.ts - b.ts)
      const r = fifoRealized(fills)
      if (r.roundTrips > 0) perAsset.push({ asset, round_trips: r.roundTrips, realized: r.realized })
      realizedTotal += r.realized
      roundTrips += r.roundTrips
    }
    const openUnrealized = (Array.isArray(positions) ? positions : []).reduce(
      (s, p) => s + (Math.abs(p.qty) > 1e-9 ? (p.unrealized_pnl ?? 0) : 0), 0)
    res.json({
      available: true,
      realized_total: realizedTotal,
      round_trips: roundTrips,
      open_unrealized: openUnrealized,
      net: realizedTotal + openUnrealized,
      per_asset: perAsset.sort((a, b) => b.realized - a.realized),
    })
  } catch (err) {
    // Engine unreachable is a normal degraded state for this card. Never
    // echo the raw error: a future engineFetch change could fold the engine
    // URL into the message.
    res.json({ available: false, error: 'engine unreachable' })
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
