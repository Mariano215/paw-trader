import { Router, type Request, type Response } from 'express'
import { getBotDb } from '../db.js'
import { logger } from '../logger.js'
import { TRADER_PROJECT_ID, canReadTraderProject, requireTraderProjectRead } from './shared.js'

const router = Router()
const DEFAULT_LIMIT = 100
const MAX_LIMIT = 200

interface OperationalEventRow {
  seq: number
  event_id: string
  project_id: string
  source_ts: number
  recorded_at: number
  source: string
  stage: string
  event_type: string
  state: string
  asset: string | null
  strategy_id: string | null
  signal_id: string | null
  decision_id: string | null
  cohort_id: string | null
  order_id: string | null
  metadata_json: string
}

/** @deprecated kept as an alias for existing callers/tests; use canReadTraderProject. */
export const canReadTraderOperationalEvents = canReadTraderProject

export function parseNonNegativeInteger(value: unknown): number | null {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return null
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null
}

export function queryTraderOperationalEvents(
  db: NonNullable<ReturnType<typeof getBotDb>>,
  afterSeq: number | null,
  limit: number,
): { events: Array<Omit<OperationalEventRow, 'metadata_json'> & { metadata: Record<string, unknown> }>; cursor: number; has_more: boolean; project_id: string } {
  const rows = afterSeq != null
    ? db.prepare(`SELECT * FROM trader_operational_events
        WHERE project_id=? AND seq>? ORDER BY seq ASC LIMIT ?`)
      .all(TRADER_PROJECT_ID, afterSeq, limit + 1) as OperationalEventRow[]
    : db.prepare(`SELECT * FROM trader_operational_events
        WHERE project_id=? ORDER BY seq DESC LIMIT ?`)
      .all(TRADER_PROJECT_ID, limit + 1) as OperationalEventRow[]
  const hasMore = rows.length > limit
  if (hasMore) rows.pop()
  if (afterSeq == null) rows.reverse()
  const events = rows.map(({ metadata_json, ...row }) => {
    let metadata: Record<string, unknown> = {}
    try { metadata = JSON.parse(metadata_json) as Record<string, unknown> } catch { /* migration contract keeps this valid */ }
    return { ...row, metadata }
  })
  const cursor = events.length ? events[events.length - 1].seq : (afterSeq ?? 0)
  return { events, cursor, has_more: hasMore, project_id: TRADER_PROJECT_ID }
}

router.get('/api/v1/trader/operational-events', requireTraderProjectRead, (req: Request, res: Response) => {
  const db = getBotDb()
  if (!db) {
    res.status(503).json({ error: 'operational event ledger unavailable' })
    return
  }
  const rawLimit = parseNonNegativeInteger(req.query.limit)
  const limit = rawLimit != null && rawLimit >= 1 ? Math.min(rawLimit, MAX_LIMIT) : DEFAULT_LIMIT
  const hasAfter = req.query.after_seq !== undefined
  const afterSeq = hasAfter ? parseNonNegativeInteger(req.query.after_seq) : null
  if (hasAfter && afterSeq == null) {
    res.status(400).json({ error: 'after_seq must be a non-negative integer' })
    return
  }

  try {
    res.json(queryTraderOperationalEvents(db, afterSeq, limit))
  } catch (err) {
    logger.warn({ err }, 'trader: operational event query failed')
    res.status(500).json({ error: 'failed to load operational events' })
  }
})

export default router
