/**
 * trader-routes/committee.ts
 *
 * Trader-wide committee transcripts and report card. Four routes:
 *   GET /api/v1/trader/decisions               -- recent decisions list
 *   GET /api/v1/trader/decisions/:id/transcript -- full transcript body
 *   GET /api/v1/trader/committee-report        -- aggregated per-role tally
 *   GET /api/v1/trader/committee-trend         -- per-day per-role hit rate
 *
 * Trader decisions and committee transcripts live in the bot DB, not the
 * engine. These endpoints read them via the bot DB (readonly handle). They
 * are authenticated by the general /api/v1 middleware but are not gated on
 * project membership -- same pattern as the other trader routes.
 */

import { Router, type Request, type Response } from 'express'
import { getBotDb } from '../db.js'
import { logger } from '../logger.js'
import { aggregateAttribution, type AttributionRow } from '../trader-attribution-aggregator.js'
import { type TraderDecisionRow, type VerdictAttributionRow } from './shared.js'

const router = Router()

interface TraderTranscriptRow {
  id: string
  signal_id: string
  transcript_json: string
  rounds: number
  total_tokens: number
  total_cost_usd: number
  created_at: number
}

// GET /api/v1/trader/decisions?limit=N
// Returns the most recent decisions (newest first), default 25, max 200.
router.get('/api/v1/trader/decisions', async (req: Request, res: Response) => {
  const bdb = getBotDb()
  if (!bdb) {
    res.status(503).json({ error: 'bot database unavailable' })
    return
  }
  const rawLimit = Number(req.query.limit)
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(Math.floor(rawLimit), 200) : 25
  try {
    const rows = bdb
      .prepare(
        `SELECT id, signal_id, action, asset, size_usd, entry_type, thesis,
                confidence, committee_transcript_id, decided_at, status
         FROM trader_decisions
         ORDER BY decided_at DESC
         LIMIT ?`,
      )
      .all(limit) as TraderDecisionRow[]
    res.json({ decisions: rows })
  } catch (err) {
    logger.warn({ err }, 'trader: list decisions failed')
    res.status(500).json({ error: 'failed to list decisions' })
  }
})

// GET /api/v1/trader/decisions/:id/transcript
// Returns 404 when the decision does not exist, or when it exists but has no
// committee transcript linked. Returns 200 with the parsed transcript_json
// plus the decision row on success.
router.get('/api/v1/trader/decisions/:id/transcript', async (req: Request, res: Response) => {
  const bdb = getBotDb()
  if (!bdb) {
    res.status(503).json({ error: 'bot database unavailable' })
    return
  }
  const decisionId = req.params.id
  try {
    const decision = bdb
      .prepare(
        `SELECT id, signal_id, action, asset, size_usd, entry_type, thesis,
                confidence, committee_transcript_id, decided_at, status
         FROM trader_decisions
         WHERE id = ?`,
      )
      .get(decisionId) as TraderDecisionRow | undefined
    if (!decision) {
      res.status(404).json({ error: 'decision not found' })
      return
    }
    if (!decision.committee_transcript_id) {
      res.status(404).json({ error: 'no committee transcript for this decision' })
      return
    }
    const tr = bdb
      .prepare(
        `SELECT id, signal_id, transcript_json, rounds, total_tokens,
                total_cost_usd, created_at
         FROM trader_committee_transcripts
         WHERE id = ?`,
      )
      .get(decision.committee_transcript_id) as TraderTranscriptRow | undefined
    if (!tr) {
      res.status(404).json({ error: 'transcript not found' })
      return
    }
    let parsed: unknown = null
    try {
      parsed = JSON.parse(tr.transcript_json)
    } catch {
      parsed = null
    }
    res.json({
      decision,
      transcript: {
        id: tr.id,
        signal_id: tr.signal_id,
        rounds: tr.rounds,
        total_tokens: tr.total_tokens,
        total_cost_usd: tr.total_cost_usd,
        created_at: tr.created_at,
        body: parsed,
      },
    })
  } catch (err) {
    logger.warn({ err, decisionId }, 'trader: get transcript failed')
    res.status(500).json({ error: 'failed to load transcript' })
  }
})

// ---------------------------------------------------------------------------
// Phase 4 Task E -- Global committee report card.
//
// Aggregates the same per-role tallies as the per-strategy attribution
// route, but with NO strategy filter. Lets the dashboard answer
// "across all verdicts, how often has the trader been right?" without
// clicking into a specific strategy. Uses the shared
// `aggregateAttribution` helper so the two routes cannot drift apart.
//
// Optional query params:
//   since_ms -- lower-bound filter on v.closed_at (inclusive). Default: all-time.
//   until_ms -- upper-bound filter on v.closed_at (exclusive). Default: unbounded.
//
// Response shape:
//   {
//     roles: [{ role, appearances, right_count, wrong_count, extras }],
//     verdict_count: number,
//     window_start_ms: number | null,
//     window_end_ms:   number | null,
//   }
// ---------------------------------------------------------------------------

router.get('/api/v1/trader/committee-report', async (req: Request, res: Response) => {
  const bdb = getBotDb()
  if (!bdb) {
    res.status(503).json({ error: 'bot database unavailable' })
    return
  }
  // Parse optional time-window filters. Non-numeric or non-positive values
  // are treated as "not provided" rather than as an error -- consistent
  // with how `limit` is handled on the sibling routes.
  const rawSince = Number(req.query.since_ms)
  const since = Number.isFinite(rawSince) && rawSince > 0 ? Math.floor(rawSince) : null
  const rawUntil = Number(req.query.until_ms)
  const until = Number.isFinite(rawUntil) && rawUntil > 0 ? Math.floor(rawUntil) : null
  try {
    // No JOINs needed here -- attribution JSON lives on trader_verdicts
    // and is independent of strategy context. Keep the SELECT narrow.
    let sql = 'SELECT agent_attribution_json FROM trader_verdicts'
    const where: string[] = []
    const params: number[] = []
    if (since !== null) { where.push('closed_at >= ?'); params.push(since) }
    if (until !== null) { where.push('closed_at < ?');  params.push(until) }
    if (where.length) sql += ' WHERE ' + where.join(' AND ')
    const rows = bdb.prepare(sql).all(...params) as VerdictAttributionRow[]
    const roles = aggregateAttribution(rows as AttributionRow[])
    res.json({
      roles,
      verdict_count: rows.length,
      window_start_ms: since,
      window_end_ms: until,
    })
  } catch (err) {
    logger.warn({ err }, 'trader: committee-report query failed')
    res.status(500).json({ error: 'failed to compute committee report' })
  }
})

// ---------------------------------------------------------------------------
// Phase 7 Task 1 -- Committee accuracy trend.
//
// The committee-report card shows the aggregate hit rate per role for the
// whole window at a glance, but the operator needs to see whether the
// committee is getting better or worse over time to act on it.  This
// endpoint rolls `trader_verdicts.agent_attribution_json` up into daily
// per-role buckets so the dashboard can render a line per role.
//
// Query: GET /api/v1/trader/committee-trend?days=30
//   days -- int, 1..365, default 30.  Anything malformed or out of range
//           falls back to 30 rather than 400-ing; the endpoint is a
//           read-only visualisation feed, not a form submission.
//
// Response shape:
//   {
//     days: Array<{
//       date: 'YYYY-MM-DD',    -- UTC date of the bucket start
//       day_start_ms: number,  -- ms since epoch at 00:00 UTC
//       by_role: Record<string, {
//         appearances: number,
//         right_count: number,
//         wrong_count: number,
//       }>,
//     }>,
//     roles: string[],      -- union of every role seen in the window
//     window_days: number,  -- resolved days count
//     window_start_ms: number,
//     window_end_ms: number,
//   }
//
// Days with no verdicts are OMITTED (not zero-filled).  The client is
// free to zero-fill for the chart if it wants a continuous x-axis; the
// API stays cheap and lets the caller decide.  Rolling averages are
// also a client concern -- the server ships raw daily buckets so the
// dashboard can switch between 7-day-rolling and 1-day-raw without a
// round-trip.
// ---------------------------------------------------------------------------

interface CommitteeTrendRow {
  day_start_ms: number
  agent_attribution_json: string
}

interface CommitteeTrendDay {
  date: string
  day_start_ms: number
  by_role: Record<string, { appearances: number; right_count: number; wrong_count: number }>
}

const COMMITTEE_TREND_DEFAULT_DAYS = 30
const COMMITTEE_TREND_MAX_DAYS = 365

router.get('/api/v1/trader/committee-trend', async (req: Request, res: Response) => {
  const bdb = getBotDb()
  if (!bdb) {
    res.status(503).json({ error: 'bot database unavailable' })
    return
  }
  const rawDays = Number(req.query.days)
  const days = (
    Number.isFinite(rawDays) && Number.isInteger(rawDays) &&
    rawDays >= 1 && rawDays <= COMMITTEE_TREND_MAX_DAYS
  ) ? rawDays : COMMITTEE_TREND_DEFAULT_DAYS

  const MS_PER_DAY = 24 * 60 * 60 * 1000
  const now = Date.now()
  // Round `now` DOWN to the start of its UTC day so the last bucket is
  // "today so far".  The start of the window is `days` whole days before
  // that, inclusive.
  const todayStartMs = Math.floor(now / MS_PER_DAY) * MS_PER_DAY
  const windowStartMs = todayStartMs - (days - 1) * MS_PER_DAY
  const windowEndMs = now

  try {
    // Bucket verdicts by UTC day start.  closed_at is ms since epoch;
    // SQLite integer division gets us the day index without a datetime()
    // round-trip.  We keep the raw attribution JSON so the aggregator
    // (which already handles malformed rows) can fold each day's rows.
    const rows = bdb
      .prepare(
        `SELECT (closed_at / ${MS_PER_DAY}) * ${MS_PER_DAY} AS day_start_ms,
                agent_attribution_json
         FROM trader_verdicts
         WHERE closed_at >= ? AND closed_at < ?
         ORDER BY day_start_ms ASC`,
      )
      .all(windowStartMs, windowEndMs) as CommitteeTrendRow[]

    // Group attribution rows by day, then aggregate each day's rows
    // independently through the shared aggregator so role parsing stays
    // byte-identical to committee-report.
    const byDay = new Map<number, AttributionRow[]>()
    for (const r of rows) {
      let bucket = byDay.get(r.day_start_ms)
      if (!bucket) {
        bucket = []
        byDay.set(r.day_start_ms, bucket)
      }
      bucket.push({ agent_attribution_json: r.agent_attribution_json })
    }

    const rolesSeen = new Set<string>()
    const dayEntries: CommitteeTrendDay[] = []
    for (const [dayStartMs, bucket] of Array.from(byDay.entries()).sort((a, b) => a[0] - b[0])) {
      const roles = aggregateAttribution(bucket)
      const by_role: CommitteeTrendDay['by_role'] = {}
      for (const r of roles) {
        by_role[r.role] = {
          appearances: r.appearances,
          right_count: r.right_count,
          wrong_count: r.wrong_count,
        }
        rolesSeen.add(r.role)
      }
      dayEntries.push({
        date: new Date(dayStartMs).toISOString().slice(0, 10),
        day_start_ms: dayStartMs,
        by_role,
      })
    }

    res.json({
      days: dayEntries,
      roles: Array.from(rolesSeen).sort((a, b) => a.localeCompare(b)),
      window_days: days,
      window_start_ms: windowStartMs,
      window_end_ms: windowEndMs,
    })
  } catch (err) {
    logger.warn({ err }, 'trader: committee-trend query failed')
    res.status(500).json({ error: 'failed to compute committee trend' })
  }
})

export default router
