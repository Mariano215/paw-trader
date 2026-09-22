// Earnings calendar for single stocks. On 2026-07-31 AAPL gapped from about
// $338 through its $307 stop to $301 the morning after earnings, and 13
// stacked lots lost $1,683: more than the whole book's net loss. A stop
// cannot protect across an overnight gap, so the fix is to not hold into it.
//
// Source: Nasdaq's public analyst endpoint (no key). ETFs return 400, which
// reads as "no earnings". Knob `earnings_blackout_days` (0 = off) sets how
// many calendar days before earnings new entries are blocked; held positions
// exit when earnings are today or tomorrow.
import { logger } from '../logger.js'
import { traderKnob } from './knobs.js'

const DAY_MS = 86_400_000
const TTL_MS = 6 * 60 * 60 * 1000
const cache = new Map<string, { dateMs: number | null; at: number }>()

/** Parse "report earnings on  10/29/2026" into a UTC midnight ms. */
export function parseEarningsDate(text: string | undefined): number | null {
  const m = text?.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/)
  return m ? Date.UTC(Number(m[3]), Number(m[1]) - 1, Number(m[2])) : null
}

async function fetchEarningsDate(asset: string, fetchFn: typeof fetch): Promise<number | null> {
  const res = await fetchFn(`https://api.nasdaq.com/api/analyst/${encodeURIComponent(asset)}/earnings-date`, {
    headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' },
    signal: AbortSignal.timeout(5_000),
  })
  if (!res.ok) return null
  const body = await res.json() as { data?: { reportText?: string; announcement?: string } | null }
  return parseEarningsDate(body.data?.reportText) ?? parseEarningsDate(body.data?.announcement)
}

/**
 * Calendar days from today (UTC) to the next earnings date, or null when
 * the blackout knob is off, the asset is crypto or an ETF, or the lookup
 * fails. Fails open: a failed lookup never blocks a trade.
 */
export async function daysToEarnings(asset: string, nowMs = Date.now(), fetchFn: typeof fetch = fetch): Promise<number | null> {
  if (earningsBlackoutDays() <= 0 || asset.includes('/')) return null
  let hit = cache.get(asset)
  if (!hit || nowMs - hit.at > TTL_MS) {
    try {
      hit = { dateMs: await fetchEarningsDate(asset, fetchFn), at: nowMs }
    } catch (err) {
      logger.warn({ asset, err: err instanceof Error ? err.message : String(err) }, 'Earnings date lookup failed')
      hit = { dateMs: null, at: nowMs }
    }
    cache.set(asset, hit)
  }
  if (hit.dateMs == null) return null
  const today = Math.floor(nowMs / DAY_MS) * DAY_MS
  const days = Math.round((hit.dateMs - today) / DAY_MS)
  return days >= 0 ? days : null
}

export function earningsBlackoutDays(): number {
  return traderKnob('earnings_blackout_days', 0)
}

/** Test hook. */
export function clearEarningsCache(): void { cache.clear() }
