/**
 * enrichment-fetcher.ts
 *
 * Fetches 30 days of daily price bars from the trading engine for each
 * pending signal that has no enrichment_json, computes basic technical
 * indicators (RSI-14, momentum, price levels), and stores the result as
 * JSON so the committee has real market context instead of "(none)".
 *
 * This runs between pollAndStoreSignals() and sendPendingApprovals() in
 * the trader scheduler. One price fetch per unique asset per cycle; the
 * engine endpoint is /prices/{asset}?from_ms=&to_ms= which Alpaca backs.
 */

import type Database from 'better-sqlite3'
import type { EngineClient } from './engine-client.js'
import { logger } from '../logger.js'

export interface SignalEnrichment {
  /** Latest close price from the engine's daily bars. */
  price_current: number | null
  /** % change from previous bar close. */
  price_change_1d_pct: number | null
  /** % change over 5 trading days. */
  price_change_5d_pct: number | null
  /** % change over 20 trading days (approx 1 month). */
  price_change_20d_pct: number | null
  /** 14-period RSI calculated from daily closes. Null if < 15 bars. */
  rsi_14: number | null
  /** Highest close in the fetched window. */
  window_high: number | null
  /** Lowest close in the fetched window. */
  window_low: number | null
  /** % below window high (negative = below high). */
  pct_from_window_high: number | null
  /** Number of daily bars the engine returned. */
  bars_fetched: number
  /** UTC ms when enrichment was computed. */
  fetched_at: number
}

/**
 * Standard 14-period RSI from an array of closing prices (oldest first).
 * Returns null when fewer than 15 bars are available.
 */
function computeRsi14(closes: number[]): number | null {
  if (closes.length < 15) return null

  // Use the last 15 closes: 14 deltas -> one RSI value
  const slice = closes.slice(-15)
  let totalGain = 0
  let totalLoss = 0
  for (let i = 1; i < slice.length; i++) {
    const delta = slice[i] - slice[i - 1]
    if (delta > 0) totalGain += delta
    else totalLoss += -delta
  }

  const avgGain = totalGain / 14
  const avgLoss = totalLoss / 14
  if (avgLoss === 0) return 100
  const rs = avgGain / avgLoss
  return Math.round((100 - 100 / (1 + rs)) * 10) / 10
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

function pctChange(from: number, to: number): number {
  return round2(((to - from) / from) * 100)
}

function computeEnrichment(closes: number[]): SignalEnrichment {
  const n = closes.length
  const now = Date.now()

  if (n === 0) {
    return {
      price_current: null,
      price_change_1d_pct: null,
      price_change_5d_pct: null,
      price_change_20d_pct: null,
      rsi_14: null,
      window_high: null,
      window_low: null,
      pct_from_window_high: null,
      bars_fetched: 0,
      fetched_at: now,
    }
  }

  const current = closes[n - 1]
  const prev1d  = n >= 2  ? closes[n - 2]  : null
  const prev5d  = n >= 6  ? closes[n - 6]  : null
  const prev20d = n >= 21 ? closes[n - 21] : null

  const windowHigh = Math.max(...closes)
  const windowLow  = Math.min(...closes)

  return {
    price_current:        round2(current),
    price_change_1d_pct:  prev1d  != null ? pctChange(prev1d,  current) : null,
    price_change_5d_pct:  prev5d  != null ? pctChange(prev5d,  current) : null,
    price_change_20d_pct: prev20d != null ? pctChange(prev20d, current) : null,
    rsi_14:               computeRsi14(closes),
    window_high:          round2(windowHigh),
    window_low:           round2(windowLow),
    pct_from_window_high: round2(((current - windowHigh) / windowHigh) * 100),
    bars_fetched:         n,
    fetched_at:           now,
  }
}

/**
 * Fetch and store enrichment for all pending signals that lack it.
 * Deduplicates price fetches -- one request per unique asset per call.
 * Returns the count of signals successfully enriched.
 *
 * Failures on individual assets are logged and skipped; the signal stays
 * unenriched and gets enriched on the next cycle.
 */
export async function enrichPendingSignals(
  db: Database.Database,
  client: EngineClient,
): Promise<number> {
  const signals = db.prepare(`
    SELECT id, asset
    FROM trader_signals
    WHERE status = 'pending' AND enrichment_json IS NULL
    ORDER BY generated_at DESC
    LIMIT 30
  `).all() as { id: string; asset: string }[]

  if (signals.length === 0) return 0

  const LOOKBACK_MS = 35 * 24 * 60 * 60 * 1000  // 35 days -> ~25 trading bars
  const now = Date.now()
  const fromMs = now - LOOKBACK_MS
  const toMs   = now

  // One price fetch per unique asset
  const priceCache = new Map<string, number[]>()

  const uniqueAssets = [...new Set(signals.map(s => s.asset))]
  await Promise.allSettled(
    uniqueAssets.map(async (asset) => {
      try {
        const bars = await client.getPrices(asset, fromMs, toMs)
        const closes = bars.map(b => b.close).filter(c => typeof c === 'number' && isFinite(c))
        priceCache.set(asset, closes)
        logger.debug({ asset, bars: closes.length }, 'enrichment: price bars fetched')
      } catch (err) {
        logger.warn({ err, asset }, 'enrichment: price fetch failed; signal stays unenriched')
        priceCache.set(asset, [])
      }
    }),
  )

  const update = db.prepare('UPDATE trader_signals SET enrichment_json = ? WHERE id = ?')

  let enriched = 0
  const persist = db.transaction(() => {
    for (const signal of signals) {
      const closes = priceCache.get(signal.asset) ?? []
      // Skip if engine returned no bars (offline or asset not tracked)
      if (closes.length === 0) continue
      const data = computeEnrichment(closes)
      update.run(JSON.stringify(data), signal.id)
      enriched++
    }
  })
  persist()

  if (enriched > 0) {
    logger.info({ enriched, total: signals.length }, 'Trader signal enrichment complete')
  }
  return enriched
}
