import type Database from 'better-sqlite3'

/**
 * Returns the UTC millisecond timestamp of the most recent midnight in
 * America/New_York. Used for the daily-cap gate so 4pm-4pm ET counts as
 * one trading day even across UTC midnight rollover.
 */
export function startOfNyDayMs(nowMs = Date.now()): number {
  const now = new Date(nowMs)
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(now)
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '0'
  const year = Number(get('year'))
  const month = Number(get('month'))
  const day = Number(get('day'))
  const hourPart = Number(get('hour'))
  const minutePart = Number(get('minute'))
  const secondPart = Number(get('second'))
  const hour = hourPart === 24 ? 0 : hourPart
  const asUtcMs = Date.UTC(year, month - 1, day, hour, minutePart, secondPart)
  const tzOffsetMs = asUtcMs - now.getTime()
  return Date.UTC(year, month - 1, day, 0, 0, 0) - tzOffsetMs
}

type Cache = { value: number; expiresAt: number }
const TTL_MS = 30_000
let bypassCache: Cache | null = null
let dailyCache: Cache | null = null

/** Reset both caches. For tests only. */
export function resetCountersForTest(): void {
  bypassCache = null
  dailyCache = null
}

/** Force-invalidate caches after a write. Call from decision-dispatcher post-insert. */
export function invalidateCounters(): void {
  bypassCache = null
  dailyCache = null
}

/**
 * Count of lifetime bypass-tagged decisions that were not rejected.
 * Caches for 30s — invalidate after a bypass insert via invalidateCounters().
 */
export function countBypassTrades(db: Database.Database, nowMs = Date.now()): number {
  if (bypassCache && bypassCache.expiresAt > nowMs) return bypassCache.value
  const row = db.prepare(`
    SELECT COUNT(*) AS n FROM trader_decisions
    WHERE thesis LIKE '[BYPASS%' AND status != 'rejected'
  `).get() as { n: number }
  bypassCache = { value: row.n, expiresAt: nowMs + TTL_MS }
  return row.n
}

/**
 * Count of today's (NY tz) non-abstain decisions.
 * Caches for 30s — invalidate after any new decision insert.
 */
export function countTradesToday(db: Database.Database, nowMs = Date.now()): number {
  if (dailyCache && dailyCache.expiresAt > nowMs) return dailyCache.value
  const startMs = startOfNyDayMs(nowMs)
  const row = db.prepare(`
    SELECT COUNT(*) AS n FROM trader_decisions
    WHERE action != 'abstain' AND decided_at >= ?
  `).get(startMs) as { n: number }
  dailyCache = { value: row.n, expiresAt: nowMs + TTL_MS }
  return row.n
}
