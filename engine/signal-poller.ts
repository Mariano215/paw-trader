import type Database from 'better-sqlite3'
import { TRADER_SIGNAL_SCORE_THRESHOLD } from '../config.js'
import { logger } from '../logger.js'
import type { EngineClient } from './engine-client.js'

const SCORE_THRESHOLD = TRADER_SIGNAL_SCORE_THRESHOLD

// ---------------------------------------------------------------------------
// NYSE holiday helpers
// ---------------------------------------------------------------------------

/**
 * Easter Sunday for a given year, Gregorian calendar.
 * Anonymous Gregorian algorithm (Meeus/Jones/Butcher).
 */
function easterSunday(year: number): { month: number; day: number } {
  const a = year % 19
  const b = Math.floor(year / 100)
  const c = year % 100
  const d = Math.floor(b / 4)
  const e = b % 4
  const f = Math.floor((b + 8) / 25)
  const g = Math.floor((b - f + 1) / 3)
  const h = (19 * a + b - d - g + 15) % 30
  const i = Math.floor(c / 4)
  const k = c % 4
  const l = (32 + 2 * e + 2 * i - h - k) % 7
  const m = Math.floor((a + 11 * h + 22 * l) / 451)
  const month = Math.floor((h + l - 7 * m + 114) / 31)
  const day = ((h + l - 7 * m + 114) % 31) + 1
  return { month, day }
}

/**
 * Apply Sat→Fri / Sun→Mon observation rule to a fixed holiday.
 * Uses local Date arithmetic (no timezone needed — purely calendar).
 */
function observed(year: number, month: number, day: number): { month: number; day: number } {
  const dow = new Date(year, month - 1, day).getDay()  // 0=Sun, 6=Sat
  const shift = dow === 6 ? -1 : dow === 0 ? 1 : 0
  if (shift === 0) return { month, day }
  const d = new Date(year, month - 1, day + shift)
  return { month: d.getMonth() + 1, day: d.getDate() }
}

/** Day-of-month for the Nth occurrence of `weekday` (0=Sun…6=Sat) in a month. */
function nthWeekday(n: number, weekday: number, month: number, year: number): number {
  const firstDow = new Date(year, month - 1, 1).getDay()
  return 1 + ((weekday - firstDow + 7) % 7) + (n - 1) * 7
}

/** Day-of-month for the last occurrence of `weekday` in a month. */
function lastWeekday(weekday: number, month: number, year: number): number {
  const lastDay = new Date(year, month, 0).getDate()
  const lastDow = new Date(year, month - 1, lastDay).getDay()
  return lastDay - ((lastDow - weekday + 7) % 7)
}

/**
 * Returns true when the ET calendar date is an NYSE market holiday.
 * Covers all 10 holidays NYSE currently observes.
 */
export function isNyseHoliday(year: number, month: number, day: number): boolean {
  // 1. New Year's Day — Jan 1 (observed)
  const ny = observed(year, 1, 1)
  if (month === ny.month && day === ny.day) return true

  // 2. MLK Day — 3rd Monday in January
  if (month === 1 && day === nthWeekday(3, 1, 1, year)) return true

  // 3. Presidents' Day — 3rd Monday in February
  if (month === 2 && day === nthWeekday(3, 1, 2, year)) return true

  // 4. Good Friday — 2 days before Easter Sunday
  const easter = easterSunday(year)
  const gf = new Date(year, easter.month - 1, easter.day - 2)
  if (month === gf.getMonth() + 1 && day === gf.getDate()) return true

  // 5. Memorial Day — last Monday in May
  if (month === 5 && day === lastWeekday(1, 5, year)) return true

  // 6. Juneteenth — Jun 19 (observed), NYSE adopted 2022
  if (year >= 2022) {
    const jt = observed(year, 6, 19)
    if (month === jt.month && day === jt.day) return true
  }

  // 7. Independence Day — Jul 4 (observed)
  const id4 = observed(year, 7, 4)
  if (month === id4.month && day === id4.day) return true

  // 8. Labor Day — 1st Monday in September
  if (month === 9 && day === nthWeekday(1, 1, 9, year)) return true

  // 9. Thanksgiving — 4th Thursday in November
  if (month === 11 && day === nthWeekday(4, 4, 11, year)) return true

  // 10. Christmas — Dec 25 (observed)
  const xmas = observed(year, 12, 25)
  if (month === xmas.month && day === xmas.day) return true

  return false
}

// ---------------------------------------------------------------------------

/**
 * Returns true when the given timestamp falls within NYSE regular
 * trading hours: Mon-Fri 09:30-16:00 America/New_York, excluding NYSE holidays.
 * Crypto assets (asset.includes('/')) bypass this check entirely.
 */
export function isEquityMarketHours(tsMs: number = Date.now()): boolean {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: 'numeric',
    minute: 'numeric',
    weekday: 'short',
    hour12: false,
  }).formatToParts(new Date(tsMs))

  const get = (type: string) => parts.find(p => p.type === type)?.value ?? '0'
  const weekday = get('weekday')
  if (weekday === 'Sat' || weekday === 'Sun') return false

  const year  = parseInt(get('year'), 10)
  const month = parseInt(get('month'), 10)
  const day   = parseInt(get('day'), 10)
  if (isNyseHoliday(year, month, day)) return false

  const mins = parseInt(get('hour'), 10) * 60 + parseInt(get('minute'), 10)
  return mins >= 9 * 60 + 30 && mins < 16 * 60
}

interface StoredSignal {
  id: string
  strategy_id: string
  asset: string
  side: string
  raw_score: number
  horizon_days: number
  enrichment_json: string | null
  generated_at: number
  status: string
}

export async function pollAndStoreSignals(
  db: Database.Database,
  client: EngineClient,
): Promise<{ fetched: number }> {
  let candidates
  try {
    candidates = await client.getSignals(30)
  } catch {
    return { fetched: 0 }  // engine unreachable -- skip cycle, do not throw
  }

  const insert = db.prepare(`
    INSERT OR IGNORE INTO trader_signals
      (id, strategy_id, asset, side, raw_score, horizon_days, enrichment_json, generated_at, status)
    VALUES (?, ?, ?, ?, ?, ?, NULL, ?, 'pending')
  `)

  // Check if a pending signal already exists for this asset+side.
  // Prevents the engine from flooding the queue with duplicate signals in
  // one poll cycle or across cycles when the user has not acted yet.
  const hasPending = db.prepare(`
    SELECT 1 FROM trader_signals
    WHERE asset = ? AND side = ? AND status = 'pending'
    LIMIT 1
  `)

  const insertMany = db.transaction((items: typeof candidates) => {
    let stored = 0
    let filtered = 0
    let deduped = 0
    // Track which asset+side slots we have already inserted this
    // cycle to handle batches where the engine returns multiple IDs for the
    // same opportunity.
    const seenThisCycle = new Set<string>()

    for (const c of items) {
      if (Math.abs(c.raw_score) < SCORE_THRESHOLD) {
        filtered += 1
        continue
      }

      // Market hours gate: drop equity signals generated outside NYSE hours.
      // Crypto (asset contains '/') trades 24/7 and always passes.
      const isCrypto = c.asset.includes('/')
      if (!isCrypto && !isEquityMarketHours(c.generated_at)) {
        filtered += 1
        continue
      }

      const strategyId = resolveStrategyId(c.strategy, c.asset)
      const key = `${c.asset.toUpperCase()}|${c.side}`

      // Skip if already seen in this batch
      if (seenThisCycle.has(key)) {
        deduped += 1
        continue
      }

      // Skip if a pending signal already exists in the DB for this slot
      const existing = hasPending.get(c.asset.toUpperCase(), c.side)
      if (existing) {
        deduped += 1
        seenThisCycle.add(key)
        continue
      }

      insert.run(
        c.id,
        strategyId,
        c.asset.toUpperCase(),
        c.side,
        c.raw_score,
        c.horizon_days,
        c.generated_at,
      )
      seenThisCycle.add(key)
      stored += 1
    }
    return { stored, filtered, deduped }
  })

  const result = insertMany(candidates)
  logger.info(
    {
      fetched: candidates.length,
      stored: result.stored,
      filtered: result.filtered,
      deduped: result.deduped,
      threshold: SCORE_THRESHOLD,
    },
    'Trader signal poll complete',
  )
  return { fetched: candidates.length }
}

/**
 * Normalise the engine's strategy name + asset into the trader_strategies
 * PK the brain stores. Engine strategies that already encode an asset
 * class (e.g. 'momentum-crypto') are passed through unchanged. Bare
 * equity strategies get a '-stocks' suffix to preserve the existing
 * schema convention, and crypto pairs (asset contains '/') get a
 * '-crypto' suffix when the engine name didn't include one.
 *
 * Phase 2 Task 7. Keeps the crypto arm's track record separate from
 * the equity arms without forcing the engine to adopt a rigid
 * suffix convention.
 */
export function resolveStrategyId(strategy: string, asset: string): string {
  if (strategy.endsWith('-crypto') || strategy.endsWith('-stocks')) {
    return strategy
  }
  const isCryptoPair = asset.includes('/')
  return `${strategy}-${isCryptoPair ? 'crypto' : 'stocks'}`
}

export function getPendingSignals(db: Database.Database): StoredSignal[] {
  return db.prepare("SELECT * FROM trader_signals WHERE status = 'pending' ORDER BY raw_score DESC").all() as StoredSignal[]
}
