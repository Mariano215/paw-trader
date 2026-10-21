/**
 * enrichment-fetcher.ts
 *
 * Fetches ~60 calendar days of daily price bars from the trading engine for each
 * pending signal that has no enrichment_json, computes basic technical
 * indicators (RSI-14, momentum, price levels), and stores the result as
 * JSON so the committee has real market context instead of "(none)".
 *
 * This runs between pollAndStoreSignals() and autoDispatchPendingSignals() in
 * the trader scheduler. One price fetch per unique asset per cycle; the
 * engine endpoint is /prices/{asset}?from_ms=&to_ms= which Alpaca backs.
 */

import type Database from 'better-sqlite3'
import type { EngineClient } from './engine-client.js'
import type { MarkovRegimePayload, PricePoint } from './types.js'
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
  /**
   * Highest high of the last VOL_WINDOW_BARS completed bars (before today,
   * America/New_York), the same window the engine backtest sizes stops from.
   * Bars without high/low use their close.
   */
  window_high: number | null
  /** Lowest low of the same window. */
  window_low: number | null
  /** % from window high. Negative = below it; positive when the current price is above the completed-bar window's high. */
  pct_from_window_high: number | null
  /** Number of daily bars the engine returned. */
  bars_fetched: number
  /** UTC ms when enrichment was computed. */
  fetched_at: number
  /** Markov regime payload from GET /signals/markov/{asset}. Null when unavailable. */
  markov_regime: MarkovRegimePayload | null
  /**
   * Age in calendar days of the Markov regime training data (as_of → now).
   * Null when Markov is unavailable. Values > 30 indicate stale regime data
   * and are surfaced to the committee so the quant specialist can discount
   * the regime confidence accordingly.
   */
  markov_data_age_days: number | null
}

// ---------------------------------------------------------------------------
// CoinGecko fallback for crypto price bars
// The engine's /prices endpoint is Alpaca-backed (equity only). Crypto pairs
// have no price bars from the engine; CoinGecko free API fills the gap.
// ---------------------------------------------------------------------------

const COINGECKO_IDS: Record<string, string> = {
  'BTC/USD':  'bitcoin',
  'ETH/USD':  'ethereum',
  'SOL/USD':  'solana',
  'AVAX/USD': 'avalanche-2',
  'DOGE/USD': 'dogecoin',
  'LINK/USD': 'chainlink',
}

type Bar = Pick<PricePoint, 'date' | 'close' | 'high' | 'low'>

// Must equal VOL_WINDOW_DAYS in the engine's backtest/trade_simulator.py (bars, not days).
export const VOL_WINDOW_BARS = 35
// Calendar days to fetch so at least VOL_WINDOW_BARS completed bars come back.
const LOOKBACK_DAYS = 60

const nyDate = (ms: number): string => new Date(ms).toLocaleDateString('en-CA', { timeZone: 'America/New_York' })

async function fetchCoinGeckoPrices(asset: string): Promise<Bar[]> {
  const coinId = COINGECKO_IDS[asset.toUpperCase()]
  if (!coinId) return []

  const url =
    `https://api.coingecko.com/api/v3/coins/${coinId}/market_chart` +
    `?vs_currency=usd&days=${LOOKBACK_DAYS}&interval=daily`

  const resp = await fetch(url, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(10_000),
  })
  if (!resp.ok) throw new Error(`CoinGecko HTTP ${resp.status} for ${asset}`)

  const data = await resp.json() as { prices?: [number, number][] }
  return (data.prices ?? [])
    .filter(([, price]) => typeof price === 'number' && isFinite(price))
    .map(([ts, price]) => ({ date: nyDate(ts), close: price }))
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

/** Days since the Markov training data as_of date. Null when unavailable. */
function markovDataAgeDays(markov: MarkovRegimePayload | null): number | null {
  if (!markov?.as_of) return null
  const asOfMs = new Date(markov.as_of as string).getTime()
  if (isNaN(asOfMs)) return null
  return Math.floor((Date.now() - asOfMs) / (24 * 60 * 60 * 1000))
}

function computeEnrichment(bars: Bar[], markov: MarkovRegimePayload | null): SignalEnrichment {
  const now = Date.now()

  // Completed bars only: today's partial bar is not in the backtest window, and
  // the backtest's stop basis is the signal bar's close (the last completed bar).
  // A tradable equity signal is always enriched on its entry day (the poller drops off-hours signals, dispatch suppresses stale ones), so date < today is the backtest's "bars before the entry bar".
  const today = nyDate(now)
  const completed = bars
    .filter(b => b.date < today)
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
  // shortcut: with no completed bar at all, fall back to what the engine sent; it only happens on a feed with no history.
  const closes = (completed.length > 0 ? completed : bars).map(b => b.close)
  const n = closes.length

  if (bars.length === 0) {
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
      markov_regime: markov,
      markov_data_age_days: markovDataAgeDays(markov),
    }
  }

  const current = closes[n - 1]
  const prev1d  = n >= 2  ? closes[n - 2]  : null
  const prev5d  = n >= 6  ? closes[n - 6]  : null
  const prev20d = n >= 21 ? closes[n - 21] : null

  const window = completed.slice(-VOL_WINDOW_BARS)
  const windowHigh = window.length > 0 ? Math.max(...window.map(b => b.high ?? b.close)) : null
  const windowLow  = window.length > 0 ? Math.min(...window.map(b => b.low ?? b.close)) : null

  return {
    price_current:        round2(current),
    price_change_1d_pct:  prev1d  != null ? pctChange(prev1d,  current) : null,
    price_change_5d_pct:  prev5d  != null ? pctChange(prev5d,  current) : null,
    price_change_20d_pct: prev20d != null ? pctChange(prev20d, current) : null,
    rsi_14:               computeRsi14(closes),
    window_high:          windowHigh != null ? round2(windowHigh) : null,
    window_low:           windowLow != null ? round2(windowLow) : null,
    pct_from_window_high: windowHigh != null ? round2(((current - windowHigh) / windowHigh) * 100) : null,
    bars_fetched:         bars.length,
    fetched_at:           now,
    markov_regime:        markov,
    markov_data_age_days: markovDataAgeDays(markov),
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

  const LOOKBACK_MS = LOOKBACK_DAYS * 24 * 60 * 60 * 1000
  const now = Date.now()
  const fromMs = now - LOOKBACK_MS
  const toMs   = now

  // One price fetch + one markov fetch per unique asset
  const priceCache = new Map<string, Bar[]>()
  const markovCache = new Map<string, MarkovRegimePayload | null>()

  const uniqueAssets = [...new Set(signals.map(s => s.asset))]
  await Promise.allSettled(
    uniqueAssets.map(async (asset) => {
      try {
        const bars = await client.getPrices(asset, fromMs, toMs)
        const valid = bars.filter(b => typeof b.close === 'number' && isFinite(b.close))
        priceCache.set(asset, valid)
        logger.debug({ asset, bars: valid.length }, 'enrichment: price bars fetched')
      } catch (err) {
        logger.warn({ err, asset }, 'enrichment: price fetch failed; signal stays unenriched')
        priceCache.set(asset, [])
      }

      // CoinGecko fallback: crypto pairs (asset contains '/') have no bars on
      // the engine's Alpaca-backed /prices endpoint. Try CoinGecko free API so
      // the committee has current RSI and momentum context.
      if ((priceCache.get(asset) ?? []).length === 0 && asset.includes('/')) {
        try {
          const cgBars = await fetchCoinGeckoPrices(asset)
          if (cgBars.length > 0) {
            priceCache.set(asset, cgBars)
            logger.info({ asset, bars: cgBars.length }, 'enrichment: CoinGecko fallback price bars fetched')
          } else {
            logger.warn({ asset }, 'enrichment: CoinGecko returned 0 bars for crypto asset')
          }
        } catch (err) {
          logger.warn({ err, asset }, 'enrichment: CoinGecko fallback failed; using Markov-only enrichment')
        }
      }

      let markov: MarkovRegimePayload | null = null
      try {
        markov = await client.getMarkovRegime(asset)
        if (markov != null) {
          logger.debug({ asset, state: markov.current_state }, 'enrichment: markov regime fetched')
        }
      } catch (err) {
        logger.warn({ err, asset }, 'enrichment: markov regime fetch failed; falling back to null')
        markov = null
      }
      markovCache.set(asset, markov)
    }),
  )

  const update = db.prepare('UPDATE trader_signals SET enrichment_json = ? WHERE id = ?')

  let enriched = 0
  const persist = db.transaction(() => {
    for (const signal of signals) {
      const bars = priceCache.get(signal.asset) ?? []
      const markov = markovCache.get(signal.asset) ?? null
      // Skip only when both bars AND Markov are missing: no useful data at all.
      // Crypto assets (e.g. BTC/USD) have Markov from the engine but no price
      // bars on the /prices endpoint; write Markov-only enrichment so the
      // committee can use regime signal instead of seeing "(none)".
      if (bars.length === 0 && markov == null) continue
      const data = computeEnrichment(bars, markov)
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
