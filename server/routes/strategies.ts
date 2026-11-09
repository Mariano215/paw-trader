/**
 * trader-routes/strategies.ts
 *
 * Five strategy-scoped endpoints:
 *   GET  /api/v1/trader/track-records                 -- rollup across all strategies
 *   GET  /api/v1/trader/strategies/:id/equity-curve   -- cumulative PnL series
 *   GET  /api/v1/trader/strategies/:id/attribution    -- per-role tally
 *   GET  /api/v1/trader/strategies/:id/decisions      -- recent decisions list
 *   POST /api/v1/trader/strategies/:id/pause          -- admin pause toggle
 *
 * All reads go against the bot DB (same handle as the other trader routes).
 * Project-scoping is intentionally not applied: trader is a single-project
 * domain (project_id='trader') and the other trader GETs follow the same
 * pattern. Authentication is enforced by the router-wide `authenticate`
 * middleware so 401 still applies.
 */

import { Router, type Request, type Response } from 'express'
import { getBotDb } from '../db.js'
import { logger } from '../logger.js'
import { requireAdmin } from '../auth.js'
import { aggregateAttribution, type AttributionRow } from '../trader-attribution-aggregator.js'
import {
  strategyExists,
  type TraderDecisionRow,
  type VerdictAttributionRow,
} from './shared.js'

const router = Router()

// ---------------------------------------------------------------------------
// Phase 3 Task 2 -- Strategy track records.
//
// Materialized rollup of trader_verdicts grouped by strategy. Recomputed
// in the bot's close-out watcher after every verdict write, so this
// endpoint is a pure read of the cached rollup.
// ---------------------------------------------------------------------------

interface TraderTrackRecordRow {
  strategy_id: string
  trade_count: number
  win_count: number
  rolling_sharpe: number
  avg_winner_pct: number
  avg_loser_pct: number
  max_dd_pct: number
  net_pnl_usd: number
  computed_at: number
}

router.get('/api/v1/trader/track-records', async (_req: Request, res: Response) => {
  const bdb = getBotDb()
  if (!bdb) {
    res.status(503).json({ error: 'bot database unavailable' })
    return
  }
  try {
    const rows = bdb
      .prepare(
        `SELECT strategy_id, trade_count, win_count, rolling_sharpe,
                avg_winner_pct, avg_loser_pct, max_dd_pct, net_pnl_usd,
                computed_at
         FROM trader_strategy_track_record
         ORDER BY strategy_id`,
      )
      .all() as TraderTrackRecordRow[]
    res.json({ track_records: rows })
  } catch (err) {
    logger.warn({ err }, 'trader: list track records failed')
    res.status(500).json({ error: 'failed to list track records' })
  }
})

// ---------------------------------------------------------------------------
// Phase 4 Task D -- Per-strategy drill-down routes.
//
// Strategy existence check: `SELECT 1 FROM trader_strategies WHERE id=?`.
// When the strategy row does not exist, endpoints return 404.
// ---------------------------------------------------------------------------

interface EquityCurvePointRow {
  pnl_net: number
  closed_at: number
}

// GET /api/v1/trader/strategies/:id/equity-curve?limit=N
// Time series of {closed_at, cumulative_pnl_net} points ordered oldest
// first. Default limit 200 verdicts -- enough for a ~6 month curve at a
// trade per day. Sampling (1-point-per-day) is a future optimization.
router.get('/api/v1/trader/strategies/:id/equity-curve', async (req: Request, res: Response) => {
  const bdb = getBotDb()
  if (!bdb) {
    res.status(503).json({ error: 'bot database unavailable' })
    return
  }
  const strategyId = String(req.params.id)
  if (!strategyExists(bdb, strategyId)) {
    res.status(404).json({ error: 'strategy not found' })
    return
  }
  const rawLimit = Number(req.query.limit)
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(Math.floor(rawLimit), 2000) : 200
  try {
    // Pull newest N in a subquery then re-sort ascending for curve draw.
    const rows = bdb
      .prepare(
        `SELECT closed_at, pnl_net FROM (
           SELECT v.closed_at AS closed_at, v.pnl_net AS pnl_net
           FROM trader_verdicts v
           JOIN trader_decisions d ON d.id = v.decision_id
           JOIN trader_signals   s ON s.id = d.signal_id
           WHERE s.strategy_id = ?
           ORDER BY v.closed_at DESC
           LIMIT ?
         ) ORDER BY closed_at ASC`,
      )
      .all(strategyId, limit) as EquityCurvePointRow[]
    let cum = 0
    const points = rows.map(r => {
      cum += Number(r.pnl_net)
      return { closed_at: r.closed_at, cumulative_pnl_net: cum }
    })
    res.json({ points })
  } catch (err) {
    logger.warn({ err, strategyId }, 'trader: equity curve query failed')
    res.status(500).json({ error: 'failed to load equity curve' })
  }
})

// GET /api/v1/trader/strategies/:id/attribution
// Per-role tally across every verdict for this strategy. Each
// `agent_attribution_json` is an array of `{role, data}` entries produced
// by `attributeAgents` in verdict-engine. Aggregation is factored into
// `aggregateAttribution` (trader-attribution-aggregator.ts) and shared
// with the global GET /api/v1/trader/committee-report route.
router.get('/api/v1/trader/strategies/:id/attribution', async (req: Request, res: Response) => {
  const bdb = getBotDb()
  if (!bdb) {
    res.status(503).json({ error: 'bot database unavailable' })
    return
  }
  const strategyId = String(req.params.id)
  if (!strategyExists(bdb, strategyId)) {
    res.status(404).json({ error: 'strategy not found' })
    return
  }
  try {
    const rows = bdb
      .prepare(
        `SELECT v.agent_attribution_json
         FROM trader_verdicts v
         JOIN trader_decisions d ON d.id = v.decision_id
         JOIN trader_signals   s ON s.id = d.signal_id
         WHERE s.strategy_id = ?`,
      )
      .all(strategyId) as VerdictAttributionRow[]
    const roles = aggregateAttribution(rows as AttributionRow[])
    res.json({ roles, verdict_count: rows.length })
  } catch (err) {
    logger.warn({ err, strategyId }, 'trader: attribution query failed')
    res.status(500).json({ error: 'failed to compute attribution' })
  }
})

// GET /api/v1/trader/strategies/:id/decisions?limit=N
// Recent decisions scoped to this strategy, newest-first. Mirrors the
// shape of /api/v1/trader/decisions so the existing transcript modal
// code can be reused on the frontend drill-down page. Default limit 25,
// max 200.
router.get('/api/v1/trader/strategies/:id/decisions', async (req: Request, res: Response) => {
  const bdb = getBotDb()
  if (!bdb) {
    res.status(503).json({ error: 'bot database unavailable' })
    return
  }
  const strategyId = String(req.params.id)
  if (!strategyExists(bdb, strategyId)) {
    res.status(404).json({ error: 'strategy not found' })
    return
  }
  const rawLimit = Number(req.query.limit)
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(Math.floor(rawLimit), 200) : 25
  try {
    const rows = bdb
      .prepare(
        `SELECT d.id, d.signal_id, d.action, d.asset, d.size_usd, d.entry_type,
                d.thesis, d.confidence, d.committee_transcript_id,
                d.decided_at, d.status
         FROM trader_decisions d
         JOIN trader_signals s ON s.id = d.signal_id
         WHERE s.strategy_id = ?
         ORDER BY d.decided_at DESC
         LIMIT ?`,
      )
      .all(strategyId, limit) as TraderDecisionRow[]
    res.json({ decisions: rows })
  } catch (err) {
    logger.warn({ err, strategyId }, 'trader: list strategy decisions failed')
    res.status(500).json({ error: 'failed to list strategy decisions' })
  }
})

// ---------------------------------------------------------------------------
// Phase 5 Task 7a -- Pause a strategy.
//
// Admin-only (matches the gating pattern of the other trader mutation
// endpoints: /halt and /clear-breaker). trader_strategies has no
// project_id column today and trader is a single-project domain, so
// project-role gates do not apply.
//
// Idempotent: pausing an already-paused strategy returns 200 with
// status='paused' and bumps updated_at. Returns 404 when the strategy
// row does not exist.
// ---------------------------------------------------------------------------

router.post('/api/v1/trader/strategies/:id/pause', requireAdmin, (req: Request, res: Response) => {
  const bdb = getBotDb()
  if (!bdb) {
    res.status(503).json({ error: 'bot database unavailable' })
    return
  }
  const strategyId = String(req.params.id)
  try {
    const result = bdb
      .prepare(`UPDATE trader_strategies SET status = 'paused', updated_at = ? WHERE id = ?`)
      .run(Date.now(), strategyId)
    if (result.changes === 0) {
      res.status(404).json({ error: 'strategy not found' })
      return
    }
    res.json({ status: 'paused' })
  } catch (err) {
    logger.warn({ err, strategyId }, 'trader: pause strategy failed')
    res.status(500).json({ error: 'failed to pause strategy' })
  }
})

export default router
