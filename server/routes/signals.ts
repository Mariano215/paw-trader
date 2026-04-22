/**
 * trader-routes/signals.ts
 *
 * GET /api/v1/trader/signals?limit=N
 *
 * Returns recent signals with their approval response and decision outcome,
 * so the dashboard Signal Queue card can show both pending and historical
 * signals in one call.
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

const router = Router()

const MAX_LIMIT = 100
const DEFAULT_LIMIT = 50

interface SignalRow {
  id: string
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

export default router
