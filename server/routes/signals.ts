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
    const rows = bdb.prepare(`
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
      LEFT JOIN trader_approvals a ON a.decision_id = s.id
      LEFT JOIN trader_decisions d ON d.signal_id  = s.id
      ORDER BY s.generated_at DESC
      LIMIT ?
    `).all(limit) as SignalRow[]

    const pending = rows.filter(r => r.approval_response === null && r.responded_at === null)
    const history = rows.filter(r => r.approval_response !== null || r.responded_at !== null)

    res.json({ pending, history })
  } catch (err) {
    logger.warn({ err }, 'trader: signals read failed')
    res.status(500).json({ error: 'failed to read signals' })
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

export default router
