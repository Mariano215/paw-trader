/**
 * trader-routes/audit-log.ts
 *
 * Two routes:
 *   GET /api/v1/trader/kill-switch-log       -- admin JSON list
 *   GET /api/v1/trader/kill-switch-log.csv   -- admin CSV download
 *
 * Admin-only (system-level resource, not project-scoped).  The file
 * sits under trader-routes/ because the URL namespace is /trader/ --
 * the brain's weekly-report builder polls it alongside the other
 * trader endpoints -- but the underlying resource is the system-wide
 * kill_switch_log table, not trader-specific state.  Phase 7 Task 7
 * renamed this file from kill-switch.ts to close that naming gap;
 * the URL paths are preserved so no client-side code changed.
 *
 * The weekly-report builder polls the JSON endpoint with the week's
 * [start, end] timestamps so the rendered report can show how many
 * times the kill switch was toggled in-window.
 *
 * Default since_ms = 0, default until_ms = Date.now(). Both are
 * inclusive. Client-supplied ?limit is clamped to [1, KILL_SWITCH_LOG_LIMIT]
 * (imported from system-state.ts so the DB default and the route cap
 * stay in lockstep). The CSV endpoint honours the same filter params
 * and streams a text/csv download.
 */

import { Router, type Request, type Response } from 'express'
import { getServerDb } from '../db.js'
import { logger } from '../logger.js'
import { requireAdmin } from '../auth.js'
import { KILL_SWITCH_LOG_LIMIT, readKillSwitchLog } from '../system-state.js'

const router = Router()

// Parses + validates since_ms, until_ms, limit in one place so the JSON
// and CSV handlers stay in lockstep. Returns either a bounds object or
// an error code+message that the caller passes to res.status().json().
function parseLogQuery(req: Request):
  | { ok: true; sinceMs: number; untilMs: number; limit: number }
  | { ok: false; status: number; error: string } {
  const sinceRaw = req.query.since_ms
  const untilRaw = req.query.until_ms
  const limitRaw = req.query.limit

  const sinceMs = sinceRaw === undefined ? 0 : Number(sinceRaw)
  const untilMs = untilRaw === undefined ? Date.now() : Number(untilRaw)
  if (!Number.isFinite(sinceMs) || !Number.isFinite(untilMs)) {
    return { ok: false, status: 400, error: 'since_ms and until_ms must be numbers' }
  }

  let limit = KILL_SWITCH_LOG_LIMIT
  if (limitRaw !== undefined) {
    const parsed = Number(limitRaw)
    // Reject non-numeric, non-finite, non-integer (floats), and zero/negative
    // values with a single 400. Floats like 1.5 would otherwise silently
    // floor to 1 which hides a malformed client.
    if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < 1) {
      return { ok: false, status: 400, error: 'limit must be a positive integer' }
    }
    limit = Math.min(parsed, KILL_SWITCH_LOG_LIMIT)
  }

  return { ok: true, sinceMs, untilMs, limit }
}

router.get('/api/v1/trader/kill-switch-log', requireAdmin, (req: Request, res: Response) => {
  const parsed = parseLogQuery(req)
  if (!parsed.ok) {
    res.status(parsed.status).json({ error: parsed.error })
    return
  }
  try {
    const entries = readKillSwitchLog(getServerDb(), {
      since_ms: parsed.sinceMs,
      until_ms: parsed.untilMs,
      limit: parsed.limit,
    })
    res.json({ entries })
  } catch (err) {
    logger.warn({ err }, 'trader: kill-switch log read failed')
    res.status(500).json({ error: 'failed to read kill-switch log' })
  }
})

// ---------------------------------------------------------------------------
// Phase 6 Task 5 -- Kill-switch log CSV export.
//
// Admin-only. Accepts the same since_ms / until_ms / limit params as the
// JSON endpoint. Streams a text/csv response with Content-Disposition:
// attachment so browsers trigger a download. Column order:
//   id, toggled_at_ms, new_state, reason, set_by
// ---------------------------------------------------------------------------

// Minimal CSV escape: wraps values containing `"`, `,`, or newline in
// double quotes and doubles any embedded `"`. Returns the empty string
// for null/undefined so missing columns render as ",," not ",null,".
// Kept local (not re-exported) to match the verdicts.ts pattern.
function csvEscape(val: unknown): string {
  if (val === null || val === undefined) return ''
  const str = String(val)
  if (/[",\n\r]/.test(str)) {
    return '"' + str.replace(/"/g, '""') + '"'
  }
  return str
}

router.get('/api/v1/trader/kill-switch-log.csv', requireAdmin, (req: Request, res: Response) => {
  const parsed = parseLogQuery(req)
  if (!parsed.ok) {
    res.status(parsed.status).json({ error: parsed.error })
    return
  }
  try {
    const entries = readKillSwitchLog(getServerDb(), {
      since_ms: parsed.sinceMs,
      until_ms: parsed.untilMs,
      limit: parsed.limit,
    })

    const header = 'id,toggled_at_ms,new_state,reason,set_by'
    const lines = [header]
    for (const e of entries) {
      lines.push([
        csvEscape(e.id),
        csvEscape(e.toggled_at_ms),
        csvEscape(e.new_state),
        csvEscape(e.reason),
        csvEscape(e.set_by),
      ].join(','))
    }
    const body = lines.join('\n') + '\n'

    res.setHeader('Content-Type', 'text/csv; charset=utf-8')
    res.setHeader('Content-Disposition', 'attachment; filename="kill-switch-log.csv"')
    res.status(200).send(body)
  } catch (err) {
    logger.warn({ err }, 'trader: kill-switch log csv export failed')
    res.status(500).json({ error: 'failed to export kill-switch log csv' })
  }
})

export default router
