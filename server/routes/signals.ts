/**
 * trader-routes/signals.ts
 *
 * GET  /api/v1/trader/signals?limit=N
 * POST /api/v1/trader/signals/:id/action
 *
 * Returns recent signals with their approval response and decision outcome,
 * and relays dashboard-originated approval actions back to the live bot.
 * This lets the trader Signal Queue card show both pending and historical
 * signals in one call and offer a non-Telegram escape hatch when alerts fail.
 *
 * Response shape:
 * {
 *   pending: SignalRow[],   // awaiting Telegram button response
 *   history: SignalRow[],   // responded or expired, newest first
 * }
 *
 * SignalRow:
 * {
 *   id, asset, side, raw_score, signal_status, generated_at,
 *   approval_response, responded_at,
 *   decision_status, size_usd, decided_at
 * }
 */

import { Router, type Request, type Response } from 'express'
import { getBotDb } from '../db.js'
import { logger } from '../logger.js'
import { requireAdmin } from '../auth.js'
import { broadcastToMac, isBotConnected } from '../ws.js'

const router = Router()

const MAX_LIMIT = 100
const DEFAULT_LIMIT = 50

interface SignalRow {
  id: string
  approval_id: string | null
  asset: string
  side: string
  raw_score: number
  signal_status: string
  generated_at: number
  approval_response: string | null
  responded_at: number | null
  decision_status: string | null
  size_usd: number | null
  decided_at: number | null
}

router.get('/api/v1/trader/signals', (req: Request, res: Response) => {
  const bdb = getBotDb()
  if (!bdb) {
    res.status(503).json({ error: 'bot database unavailable' })
    return
  }

  const rawLimit = Number(req.query.limit)
  const limit = Number.isFinite(rawLimit) && rawLimit > 0
    ? Math.min(Math.floor(rawLimit), MAX_LIMIT)
    : DEFAULT_LIMIT

  try {
    // Pending: signal status is still 'pending' -- the skip/approve action
    // updates status so this clears immediately after any action.
    // Latest approval joined via subquery to avoid fanout when multiple
    // approval attempts exist for one signal.
    const pending = bdb.prepare(`
      SELECT
        s.id,
        a.id           AS approval_id,
        s.asset,
        s.side,
        s.raw_score,
        s.status       AS signal_status,
        s.generated_at,
        a.response     AS approval_response,
        a.responded_at,
        d.status       AS decision_status,
        d.size_usd,
        d.decided_at
      FROM trader_signals s
      LEFT JOIN trader_approvals a ON a.id = (
        SELECT id FROM trader_approvals
        WHERE decision_id = s.id
        ORDER BY sent_at DESC LIMIT 1
      )
      LEFT JOIN trader_decisions d ON d.signal_id = s.id
      WHERE s.status = 'pending'
      ORDER BY s.generated_at DESC
      LIMIT ?
    `).all(limit) as SignalRow[]

    const history = bdb.prepare(`
      SELECT
        s.id,
        a.id           AS approval_id,
        s.asset,
        s.side,
        s.raw_score,
        s.status       AS signal_status,
        s.generated_at,
        a.response     AS approval_response,
        a.responded_at,
        d.status       AS decision_status,
        d.size_usd,
        d.decided_at
      FROM trader_signals s
      LEFT JOIN trader_approvals a ON a.id = (
        SELECT id FROM trader_approvals
        WHERE decision_id = s.id
        ORDER BY sent_at DESC LIMIT 1
      )
      LEFT JOIN trader_decisions d ON d.signal_id = s.id
      WHERE s.status != 'pending'
      ORDER BY s.generated_at DESC
      LIMIT ?
    `).all(limit) as SignalRow[]

    res.json({ pending, history })
  } catch (err) {
    logger.warn({ err }, 'trader: signals read failed')
    res.status(500).json({ error: 'failed to read signals' })
  }
})

// GET /api/v1/trader/signals/:id/committee
// Returns the committee transcript for a signal, if one exists.
// Looks up the transcript via trader_committee_transcripts.signal_id, taking
// the most recent row in case a signal ever triggers multiple runs.
// Returns { transcript: null } when the signal exists but has no transcript.
// Returns 404 when the signal itself is not found.
router.get('/api/v1/trader/signals/:id/committee', (req: Request, res: Response) => {
  const bdb = getBotDb()
  if (!bdb) {
    res.status(503).json({ error: 'bot database unavailable' })
    return
  }

  const signalId = String(req.params.id)
  try {
    const signal = bdb.prepare(`SELECT id FROM trader_signals WHERE id = ?`).get(signalId) as { id: string } | undefined
    if (!signal) {
      res.status(404).json({ error: 'signal not found' })
      return
    }

    const tr = bdb.prepare(`
      SELECT id, signal_id, transcript_json, rounds, total_tokens, total_cost_usd, created_at
      FROM trader_committee_transcripts
      WHERE signal_id = ?
      ORDER BY created_at DESC
      LIMIT 1
    `).get(signalId) as {
      id: string; signal_id: string; transcript_json: string;
      rounds: number; total_tokens: number; total_cost_usd: number; created_at: number
    } | undefined

    if (!tr) {
      res.json({ transcript: null })
      return
    }

    let body: unknown = null
    try { body = JSON.parse(tr.transcript_json) } catch { body = null }

    res.json({
      transcript: {
        id: tr.id,
        signal_id: tr.signal_id,
        rounds: tr.rounds,
        total_tokens: tr.total_tokens,
        total_cost_usd: tr.total_cost_usd,
        created_at: tr.created_at,
        body,
      },
    })
  } catch (err) {
    logger.warn({ err, signalId }, 'trader: signals/:id/committee read failed')
    res.status(500).json({ error: 'failed to read committee transcript' })
  }
})

router.post('/api/v1/trader/signals/:id/action', requireAdmin, (req: Request, res: Response) => {
  const bdb = getBotDb()
  if (!bdb) {
    res.status(503).json({ error: 'bot database unavailable' })
    return
  }

  const signalId = String(req.params.id)
  const action = typeof req.body?.action === 'string' ? req.body.action.trim() : ''
  if (!['approve', 'skip', 'bigger', 'pause'].includes(action)) {
    res.status(400).json({ error: 'action must be approve, skip, bigger, or pause' })
    return
  }

  const signal = bdb.prepare(`
    SELECT id, status
    FROM trader_signals
    WHERE id = ?
  `).get(signalId) as { id: string; status: string } | undefined
  if (!signal) {
    res.status(404).json({ error: 'signal not found' })
    return
  }
  if (signal.status !== 'pending') {
    res.status(409).json({ error: 'signal is no longer awaiting action' })
    return
  }

  const latestApproval = bdb.prepare(`
    SELECT responded_at
    FROM trader_approvals
    WHERE decision_id = ?
    ORDER BY sent_at DESC
    LIMIT 1
  `).get(signalId) as { responded_at: number | null } | undefined
  if (latestApproval?.responded_at != null) {
    res.status(409).json({ error: 'signal was already claimed' })
    return
  }

  if (!isBotConnected()) {
    res.status(503).json({ error: 'trader bot is offline; dashboard action not delivered' })
    return
  }

  broadcastToMac({
    type: 'trader-signal-action',
    signalId,
    action,
    fromUserId: req.user?.id ?? null,
    requestedAt: Date.now(),
  })
  res.status(202).json({ accepted: true })
})

// ---------------------------------------------------------------------------
// Signal funnel — conversion stages from generation to execution.
//
// GET /api/v1/trader/signal-funnel
//
// Response:
//   {
//     generated: number,          // total signals ever generated
//     pre_filtered: number,       // suppressed before committee (no material change / stale / low score / skipped)
//     went_to_committee: number,  // signals that reached committee review
//     committee_abstained: number,
//     executed: number,
//     failed: number,
//     pending: number,
//     conversion_rate: number,    // executed / went_to_committee * 100, one decimal
//     by_status: Record<string, number>,
//   }
// ---------------------------------------------------------------------------

router.get('/api/v1/trader/signal-funnel', (req: Request, res: Response) => {
  const bdb = getBotDb()
  if (!bdb) { res.status(503).json({ error: 'bot database unavailable' }); return }
  try {
    const rows = bdb.prepare(
      `SELECT status, COUNT(*) AS cnt FROM trader_signals GROUP BY status`
    ).all() as Array<{ status: string; cnt: number }>

    const byStatus: Record<string, number> = {}
    let total = 0
    for (const r of rows) { byStatus[r.status] = r.cnt; total += r.cnt }

    const get = (k: string) => byStatus[k] ?? 0
    const preFiltered =
      get('suppressed_no_material_change') +
      get('suppressed_stale') +
      get('suppressed_blind_low_score') +
      get('skipped')
    const pending = get('pending')
    const wentToCommittee = total - preFiltered - pending
    const executed = get('executed')

    res.json({
      generated: total,
      pre_filtered: preFiltered,
      went_to_committee: wentToCommittee,
      committee_abstained: get('suppressed_committee_abstain'),
      suppressed_cluster_cap: get('suppressed_cluster_cap'),
      suppressed_symbol_cap: get('suppressed_symbol_cap'),
      suppressed_portfolio_heat: get('suppressed_portfolio_heat'),
      executed,
      failed: get('failed'),
      pending,
      conversion_rate: wentToCommittee > 0 ? Math.round(1000 * executed / wentToCommittee) / 10 : 0,
      by_status: byStatus,
    })
  } catch (err) {
    logger.warn({ err }, 'trader: signal-funnel query failed')
    res.status(500).json({ error: 'failed to compute signal funnel' })
  }
})

export default router
