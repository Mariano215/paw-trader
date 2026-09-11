/**
 * trader-routes/status.ts
 *
 * Engine-fronted status, position, order, risk, control, NAV, accounting,
 * and strategy-state endpoints. Read contracts preserve the distinction
 * between confirmed empty state and unavailable broker state. Mutations are
 * admin-only and proxy through the server so engine credentials stay private.
 */

import { Router, type Request, type Response } from 'express'
import { requireAdmin } from '../auth.js'
import { logger } from '../logger.js'
import { getBotDb } from '../db.js'
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
      crypto_enabled: (health as { crypto_enabled?: boolean }).crypto_enabled ?? null,
      trade_updates_alive: health.trade_updates_alive ?? null,
      reconciler_halted: (health as { reconciler_halted?: boolean }).reconciler_halted ?? false,
      halt_reason: (health as { halt_reason?: string | null }).halt_reason ?? null,
      last_reconcile: reconcile,
    })
  } catch (err) {
    // Never echo the raw error to the client: engineFetch folds the engine
    // URL into its messages, so String(err) leaks internal topology. Same
    // treatment as broker-pnl below. The detail still reaches the operator
    // through the server log.
    logger.warn({ err }, 'trader: status query failed')
    res.json({ engine_connected: false, error: 'engine unreachable' })
  }
})

// ---------------------------------------------------------------------------
// GET /api/v1/trader/positions
// Failed reads are unavailable, never a confirmed empty portfolio.
// ---------------------------------------------------------------------------

router.get('/api/v1/trader/positions', async (_req: Request, res: Response) => {
  const cfg = getEngineConfig()
  if (!cfg) {
    res.status(503).json({ error: 'positions unavailable' })
    return
  }
  try {
    const positions = await engineFetch<unknown[]>(cfg, '/positions')
    if (!Array.isArray(positions)) throw new Error('invalid positions response')
    res.json(positions)
  } catch {
    res.status(503).json({ error: 'positions unavailable' })
  }
})

// ---------------------------------------------------------------------------
// GET /api/v1/trader/orders
// Failed reads are unavailable, never a confirmed empty blotter. Pagination
// stays within the engine contract so the dashboard cannot request an
// unbounded ledger scan.
// ---------------------------------------------------------------------------

router.get('/api/v1/trader/orders', async (req: Request, res: Response) => {
  const cfg = getEngineConfig()
  if (!cfg) {
    res.status(503).json({ error: 'orders unavailable' })
    return
  }
  const rawLimit = Number(req.query.limit)
  const rawOffset = Number(req.query.offset)
  const requestedStatus = String(req.query.status ?? 'all')
  const status = ['open', 'closed', 'all'].includes(requestedStatus) ? requestedStatus : 'all'
  const limit = Number.isInteger(rawLimit) && rawLimit >= 1
    ? Math.min(rawLimit, 500)
    : 200
  const offset = Number.isInteger(rawOffset) && rawOffset >= 0
    ? Math.min(rawOffset, 1_000_000)
    : 0
  try {
    const orders = await engineFetch<unknown[]>(cfg, `/orders?status=${status}&limit=${limit}&offset=${offset}`)
    if (!Array.isArray(orders)) throw new Error('invalid orders response')
    res.json(orders)
  } catch (err) {
    logger.warn({ err }, 'trader: orders query failed')
    res.status(503).json({ error: 'orders unavailable' })
  }
})

// ---------------------------------------------------------------------------
// POST /api/v1/trader/orders/:clientOrderId/cancel
// Admin-only individual cancellation. The engine credential remains on this
// server; browsers send only their normal dashboard session.
// ---------------------------------------------------------------------------

const CLIENT_ORDER_ID = /^[A-Za-z0-9._:-]{1,128}$/

router.post('/api/v1/trader/orders/:clientOrderId/cancel', requireAdmin, async (req: Request, res: Response) => {
  const rawClientOrderId = req.params.clientOrderId
  const clientOrderId = Array.isArray(rawClientOrderId) ? (rawClientOrderId[0] ?? '') : rawClientOrderId
  if (!CLIENT_ORDER_ID.test(clientOrderId)) {
    res.status(400).json({ error: 'invalid client order id' })
    return
  }
  const cfg = getEngineConfig()
  if (!cfg) {
    res.status(503).json({ error: 'order cancellation unavailable' })
    return
  }
  try {
    const result = await engineFetch<{
      client_order_id: string
      status: string
      submitted: boolean
    }>(cfg, `/orders/${encodeURIComponent(clientOrderId)}/cancel`, { method: 'POST' })
    res.json(result)
  } catch (err) {
    logger.error({ err, clientOrderId }, 'trader: order cancellation failed')
    res.status(502).json({ error: 'order cancellation failed' })
  }
})

// ---------------------------------------------------------------------------
// GET /api/v1/trader/risk
// Returns { tripped: string[], details: Array<{ rule, tripped_at, reason }> }
// Unavailable risk state is an error, never an empty/clear breaker list.
// ---------------------------------------------------------------------------

router.get('/api/v1/trader/risk', async (_req: Request, res: Response) => {
  const cfg = getEngineConfig()
  if (!cfg) {
    res.status(503).json({ error: 'risk state unavailable' })
    return
  }
  try {
    const risk = await engineFetch<{ tripped: string[]; details: unknown[] }>(cfg, '/risk/state')
    res.json(risk)
  } catch (err) {
    logger.warn({ err }, 'trader: risk query failed')
    res.status(503).json({ error: 'risk state unavailable' })
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
    // Deliberately echoes the raw error, unlike the read endpoints above.
    // This is requireAdmin and it is the kill switch: an operator who just
    // failed to halt trading needs to know WHY, immediately, on screen.
    // Leaking the engine URL to an admin over Tailscale is the lesser harm.
    logger.error({ err }, 'trader: halt failed')
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
// Serve the bot's durable archive-aware calculation, not a rolling order window.
router.get('/api/v1/trader/broker-pnl', (_req: Request, res: Response) => {
  try {
    const row = getBotDb()?.prepare("SELECT value FROM kv_settings WHERE key='trader.accounting.last'").get() as {value: string} | undefined
    if (!row) { res.json({available: false}); return }
    const snapshot = JSON.parse(row.value)
    const age = Date.now() - snapshot.evaluated_at
    if (snapshot.available !== true || !Number.isFinite(snapshot.evaluated_at) ||
        !['realized_total', 'open_unrealized', 'net', 'round_trips'].every(k => Number.isFinite(snapshot[k]))) {
      res.json({available: false}); return
    }
    res.json({...snapshot, stale: age < 0 || age >= 15 * 60 * 1000})
  } catch {
    res.json({available: false, error: 'accounting snapshot unavailable'})
  }
})

// ---------------------------------------------------------------------------
// GET /api/v1/trader/strategy-status
// Small operational projection used by Mission Control. Parameter blobs stay
// out of the response; this reports only whether each stock/crypto strategy is
// allowed to run.
// ---------------------------------------------------------------------------

router.get('/api/v1/trader/strategy-status', (_req: Request, res: Response) => {
  try {
    const db = getBotDb()
    if (!db) {
      res.status(503).json({ error: 'strategy status unavailable' })
      return
    }
    const strategies = db.prepare(
      `SELECT id, name, asset_class, tier, status, updated_at
       FROM trader_strategies ORDER BY asset_class, id`,
    ).all()
    let cohorts: unknown[] = []
    let cohortsAvailable = true
    let bitcoinOrderFlowCollection: Record<string, unknown> | null = null
    try {
      cohorts = db.prepare(`SELECT
          c.id,c.strategy_id,c.asset_class,c.status,c.config_fingerprint,c.universe_json,
          c.max_position_usd,c.daily_trade_cap,c.min_closed_trades,c.min_deflated_sharpe,
          c.max_drawdown_pct,c.created_at,c.started_at,c.ended_at,c.invalidation_reason,
          sc.trade_count,sc.win_count,sc.net_pnl_usd,sc.expectancy,sc.sharpe,
          sc.deflated_sharpe,sc.max_drawdown_pct AS observed_max_drawdown_pct,
          sc.excess_return,sc.failure_rate,sc.regimes_json,sc.evidence_complete,
          sc.passed,sc.criteria_json,sc.computed_at
        FROM trader_evaluation_cohorts c
        LEFT JOIN trader_cohort_scorecards sc ON sc.cohort_id=c.id
        ORDER BY c.created_at DESC,c.id`).all()
    } catch {
      // One sync cycle may briefly put an older bot DB behind a newer server.
      cohortsAvailable = false
    }
    try {
      const row = db.prepare("SELECT value FROM kv_settings WHERE key='trader.bitcoin_order_flow.collection'")
        .get() as {value?: string} | undefined
      const raw = row?.value ? JSON.parse(row.value) as unknown : null
      if (raw && !Array.isArray(raw) && typeof raw === 'object') {
        const candidate = raw as Record<string, unknown>
        const states = new Set(['starting', 'connected', 'reconnecting', 'stopped', 'disabled', 'error'])
        if (candidate.product_id === 'BTC-USD' && typeof candidate.state === 'string' && states.has(candidate.state)) {
          const safe: Record<string, unknown> = {state: candidate.state, product_id: 'BTC-USD'}
          for (const key of [
            'started_at', 'connected_at', 'last_message_at', 'last_heartbeat_at',
            'last_trade_at', 'last_l2_at', 'last_bar_end_at', 'trades_stored',
            'l2_updates_stored', 'bars_completed', 'sequence_gap_count',
            'reconnect_count', 'rejected_messages', 'updated_at',
            'storage_error_count', 'declaration_at', 'collection_through_at',
            'eligible_bars_total', 'ineligible_bars_total',
            'collection_days_completed', 'minimum_forward_days',
            'earliest_evaluation_at',
            'evaluation_completed_at', 'evaluation_holdout_uses',
            'evaluation_trade_count',
          ]) {
            const value = candidate[key]
            if (value === null || (Number.isSafeInteger(value) && Number(value) >= 0)) safe[key] = value
          }
          if (typeof candidate.last_bar_eligible === 'boolean' || candidate.last_bar_eligible === null) {
            safe.last_bar_eligible = candidate.last_bar_eligible
          }
          if (typeof candidate.collection_mature === 'boolean') {
            safe.collection_mature = candidate.collection_mature
          }
          const evaluationStates = new Set([
            'awaiting_collection', 'rejected_pre_holdout', 'rejected', 'passed', 'error',
          ])
          if (typeof candidate.evaluation_status === 'string' &&
              evaluationStates.has(candidate.evaluation_status)) {
            safe.evaluation_status = candidate.evaluation_status
          }
          if (candidate.last_bar_reason === null ||
              (typeof candidate.last_bar_reason === 'string' && /^[a-z0-9_,]{1,240}$/.test(candidate.last_bar_reason))) {
            safe.last_bar_reason = candidate.last_bar_reason
          }
          bitcoinOrderFlowCollection = safe
        }
      }
    } catch {
      // Status projection is optional during rollout or before first sync.
    }
    res.json({
      available: true,
      strategies,
      cohorts_available: cohortsAvailable,
      cohorts,
      bitcoin_order_flow_collection: bitcoinOrderFlowCollection,
    })
  } catch (err) {
    logger.warn({ err }, 'trader: strategy status query failed')
    res.status(503).json({ error: 'strategy status unavailable' })
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
    // Same reasoning as /risk/halt above: admin-only, safety-critical, the
    // operator needs the real failure reason on screen.
    logger.error({ err }, 'trader: clear-breaker failed')
    res.status(502).json({ error: String(err) })
  }
})

export default router
