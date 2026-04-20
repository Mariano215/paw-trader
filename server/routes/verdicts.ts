/**
 * trader-routes/verdicts.ts
 *
 * Two per-strategy verdict endpoints:
 *   GET /api/v1/trader/strategies/:id/verdicts       -- paginated JSON list
 *   GET /api/v1/trader/strategies/:id/verdicts.csv   -- admin CSV export
 *
 * Both read the same three-table join (trader_verdicts x trader_decisions
 * x trader_signals) filtered by strategy_id. The JSON endpoint uses a
 * compound (closed_at, id) cursor for deterministic pagination; the CSV
 * export dumps the whole history with no pagination cap.
 */

import { Router, type Request, type Response } from 'express'
import { getBotDb } from '../db.js'
import { logger } from '../logger.js'
import { requireAdmin } from '../auth.js'
import { strategyExists, strategyStatus } from './shared.js'

const router = Router()

interface TraderVerdictHistoryRow {
  id: string
  decision_id: string
  asset: string
  side: string
  pnl_gross: number
  pnl_net: number
  bench_return: number
  hold_drawdown: number
  thesis_grade: string
  closed_at: number
}

// GET /api/v1/trader/strategies/:id/verdicts?limit=N&before_closed_at=MS
// Paginated verdict list for one strategy, newest-first. Cursor pagination
// uses a compound (closed_at, id) cursor to stay correct even when two
// verdicts share the same closed_at millisecond value -- a naive
// before_closed_at<T cursor would silently drop same-ms siblings that
// straddle a page boundary. The ORDER BY matches the cursor composition
// (closed_at DESC, id DESC) so the tiebreaker is deterministic.
// `limit` defaults to 25, capped at 200. When the result is exactly
// limit items, returns both nextBeforeClosedAt (back-compat) AND nextBeforeId
// so pages can chain across same-ms groups without loss.
router.get('/api/v1/trader/strategies/:id/verdicts', async (req: Request, res: Response) => {
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
  const rawBefore = Number(req.query.before_closed_at)
  const before = Number.isFinite(rawBefore) && rawBefore > 0 ? Math.floor(rawBefore) : null
  const beforeIdRaw = req.query.before_id
  const beforeId = typeof beforeIdRaw === 'string' && beforeIdRaw.length > 0 ? beforeIdRaw : null
  try {
    // Three predicate branches: no cursor, closed_at-only (legacy), or
    // compound (closed_at, id). Keeping explicit prepare() calls out here
    // avoids the `Array<string|number>` spread which better-sqlite3 types
    // narrow to `unknown[]`.
    const selectCols = `v.id, v.decision_id, d.asset, s.side,
                        v.pnl_gross, v.pnl_net, v.bench_return, v.hold_drawdown,
                        v.thesis_grade, v.closed_at`
    const joins = `FROM trader_verdicts v
                   JOIN trader_decisions d ON d.id = v.decision_id
                   JOIN trader_signals   s ON s.id = d.signal_id`
    const orderLimit = `ORDER BY v.closed_at DESC, v.id DESC LIMIT ?`
    const rows = (before != null && beforeId != null
      ? bdb.prepare(
          `SELECT ${selectCols} ${joins}
           WHERE s.strategy_id = ?
             AND (v.closed_at < ? OR (v.closed_at = ? AND v.id < ?))
           ${orderLimit}`,
        ).all(strategyId, before, before, beforeId, limit)
      : before != null
        ? bdb.prepare(
            `SELECT ${selectCols} ${joins}
             WHERE s.strategy_id = ? AND v.closed_at < ?
             ${orderLimit}`,
          ).all(strategyId, before, limit)
        : bdb.prepare(
            `SELECT ${selectCols} ${joins}
             WHERE s.strategy_id = ?
             ${orderLimit}`,
          ).all(strategyId, limit)) as TraderVerdictHistoryRow[]
    const body: {
      verdicts: TraderVerdictHistoryRow[]
      nextBeforeClosedAt?: number
      nextBeforeId?: string
      strategy_status?: string | null
    } = { verdicts: rows }
    if (rows.length === limit) {
      const last = rows[rows.length - 1]
      body.nextBeforeClosedAt = last.closed_at
      body.nextBeforeId = last.id
    }
    // Phase 5 Task 7a -- include the current strategy status so the
    // drill-down page can render the pause button in the correct
    // enabled/disabled state without a separate detail round-trip.
    body.strategy_status = strategyStatus(bdb, strategyId)
    res.json(body)
  } catch (err) {
    logger.warn({ err, strategyId }, 'trader: list strategy verdicts failed')
    res.status(500).json({ error: 'failed to list strategy verdicts' })
  }
})

// ---------------------------------------------------------------------------
// Phase 5 Task 7b -- Verdict history CSV export.
//
// Admin-only (matches the other trader drill-down mutation + system
// endpoints). Phase 5 security audit flagged the previous viewer-level
// gate as inconsistent with sibling routes and a risk of leaking full
// PnL history to project viewers; tightened to requireAdmin on
// 2026-04-19.
// Streams the entire verdict history for one strategy as CSV with no
// pagination cap. Browser triggers a download via the
// Content-Disposition: attachment header.
// ---------------------------------------------------------------------------

// Minimal CSV escape: wraps values containing `"`, `,`, or newline in
// double quotes and doubles any embedded `"`. Returns the empty string
// for null/undefined so missing columns render as ",," not ",null,".
function csvEscape(val: unknown): string {
  if (val === null || val === undefined) return ''
  const str = String(val)
  if (/[",\n\r]/.test(str)) {
    return '"' + str.replace(/"/g, '""') + '"'
  }
  return str
}

router.get('/api/v1/trader/strategies/:id/verdicts.csv', requireAdmin, (req: Request, res: Response) => {
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
    // Same join shape as the JSON verdict-list endpoint, just no
    // pagination cap. The id column on trader_verdicts is the verdict
    // id, distinct from decision_id.
    const rows = bdb
      .prepare(
        `SELECT v.id, v.decision_id, v.closed_at,
                v.pnl_gross, v.pnl_net, v.bench_return,
                v.hold_drawdown, v.thesis_grade
         FROM trader_verdicts v
         JOIN trader_decisions d ON d.id = v.decision_id
         JOIN trader_signals   s ON s.id = d.signal_id
         WHERE s.strategy_id = ?
         ORDER BY v.closed_at DESC, v.id DESC`,
      )
      .all(strategyId) as Array<{
        id: string
        decision_id: string
        closed_at: number
        pnl_gross: number
        pnl_net: number
        bench_return: number
        hold_drawdown: number
        thesis_grade: string
      }>

    const header = 'id,decision_id,closed_at,pnl_gross,pnl_net,bench_return,hold_drawdown,thesis_grade'
    const lines = [header]
    for (const r of rows) {
      lines.push([
        csvEscape(r.id),
        csvEscape(r.decision_id),
        csvEscape(r.closed_at),
        csvEscape(r.pnl_gross),
        csvEscape(r.pnl_net),
        csvEscape(r.bench_return),
        csvEscape(r.hold_drawdown),
        csvEscape(r.thesis_grade),
      ].join(','))
    }
    const body = lines.join('\n') + '\n'

    res.setHeader('Content-Type', 'text/csv; charset=utf-8')
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="verdicts-${strategyId}.csv"`,
    )
    res.status(200).send(body)
  } catch (err) {
    logger.warn({ err, strategyId }, 'trader: verdict csv export failed')
    res.status(500).json({ error: 'failed to export verdict csv' })
  }
})

export default router
