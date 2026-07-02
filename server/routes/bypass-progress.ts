/**
 * trader-routes/bypass-progress.ts
 *
 * Bypass-mode progress card.
 *
 *   GET /api/v1/trader/bypass-progress
 *
 * Returns counts used by the dashboard bypass progress card:
 *   count     -- lifetime bypass-tagged decisions (status != 'rejected')
 *   target    -- TRADER_BYPASS_TRADE_TARGET (hardcoded 20; server does not
 *                import bot config)
 *   daily     -- non-abstain decisions made today (NY day boundary)
 *   dailyCap  -- TRADER_DAILY_TRADE_CAP (hardcoded 20)
 *   flipped   -- true when count >= target
 *
 * Bypass decisions are identified by the '[BYPASS' prefix that the bot
 * writes into the thesis column when the bypass counter is active.
 *
 * Daily count uses the NY timezone day boundary (startOfNyDayMs) because
 * the trader's daily cap is enforced against the NY trading calendar.
 * startOfNyDayMs is inlined here -- the server compiles independently from
 * the bot and shares no config imports.
 */

import { Router, type Request, type Response } from 'express'
import { getBotDb } from '../db.js'
import { logger } from '../logger.js'

const router = Router()

// ---------------------------------------------------------------------------
// Inline copy of src/trader/bypass-counter.ts::startOfNyDayMs so the server
// stays independent of bot source imports. Keep in sync if the canonical
// version changes.
// ---------------------------------------------------------------------------

function startOfNyDayMs(nowMs = Date.now()): number {
  const now = new Date(nowMs)
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  }).formatToParts(now)
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '0'
  const year = Number(get('year'))
  const month = Number(get('month'))
  const day = Number(get('day'))
  const hourPart = Number(get('hour'))
  const minute = Number(get('minute'))
  const second = Number(get('second'))
  const hour = hourPart === 24 ? 0 : hourPart
  const asUtcMs = Date.UTC(year, month - 1, day, hour, minute, second)
  const tzOffsetMs = asUtcMs - now.getTime()
  return Date.UTC(year, month - 1, day, 0, 0, 0) - tzOffsetMs
}

// ---------------------------------------------------------------------------
// Hardcoded caps -- mirror TRADER_BYPASS_TRADE_TARGET and TRADER_DAILY_TRADE_CAP
// from the bot config. Server does not import bot env so we keep these in
// sync manually.
// ---------------------------------------------------------------------------

const BYPASS_TRADE_TARGET = 20
const DAILY_TRADE_CAP = 20

// GET /api/v1/trader/bypass-progress
router.get('/api/v1/trader/bypass-progress', async (_req: Request, res: Response) => {
  const bdb = getBotDb()
  if (!bdb) {
    res.status(503).json({ error: 'bot database unavailable' })
    return
  }
  try {
    const bypassCount = (
      bdb
        .prepare(
          `SELECT COUNT(*) AS n FROM trader_decisions
           WHERE thesis LIKE '[BYPASS%' AND status != 'rejected'`,
        )
        .get() as { n: number }
    ).n

    const today = (
      bdb
        .prepare(
          `SELECT COUNT(*) AS n FROM trader_decisions
           WHERE action != 'abstain' AND decided_at >= ?`,
        )
        .get(startOfNyDayMs()) as { n: number }
    ).n

    res.json({
      count: bypassCount,
      target: BYPASS_TRADE_TARGET,
      daily: today,
      dailyCap: DAILY_TRADE_CAP,
      flipped: bypassCount >= BYPASS_TRADE_TARGET,
    })
  } catch (err) {
    logger.warn({ err }, 'trader: bypass-progress query failed')
    res.status(500).json({ error: String(err) })
  }
})

// GET /api/v1/trader/gate-progress
//
// Go-live gate state synced from the bot (kv_settings key 'trader.gate.last',
// written weekly by src/trader/go-live-gate.ts). The bot enforces the gate;
// this endpoint only surfaces the last evaluation for the dashboard card.
router.get('/api/v1/trader/gate-progress', async (_req: Request, res: Response) => {
  const bdb = getBotDb()
  if (!bdb) {
    res.status(503).json({ error: 'bot database unavailable' })
    return
  }
  try {
    const row = bdb
      .prepare("SELECT value FROM kv_settings WHERE key = 'trader.gate.last'")
      .get() as { value: string } | undefined
    if (!row) {
      res.json({ available: false })
      return
    }
    res.json({ available: true, gate: JSON.parse(row.value) })
  } catch (err) {
    // Missing kv_settings table (fresh DB before first sync) is a normal
    // "not evaluated yet" state, not an error.
    if (String(err).includes('no such table')) {
      res.json({ available: false })
      return
    }
    logger.warn({ err }, 'trader: gate-progress query failed')
    res.status(500).json({ error: String(err) })
  }
})

export default router
