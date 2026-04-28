import type Database from 'better-sqlite3'
import { TRADER_SIGNAL_SCORE_THRESHOLD } from '../config.js'
import { logger } from '../logger.js'
import type { EngineClient } from './engine-client.js'

const SCORE_THRESHOLD = TRADER_SIGNAL_SCORE_THRESHOLD

/**
 * Returns true when the given timestamp falls within NYSE regular
 * trading hours: Mon-Fri 09:30-16:00 America/New_York.
 * Crypto assets (asset.includes('/')) bypass this check entirely.
 */
export function isEquityMarketHours(tsMs: number = Date.now()): boolean {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour: 'numeric',
    minute: 'numeric',
    weekday: 'short',
    hour12: false,
  }).formatToParts(new Date(tsMs))

  const get = (type: string) => parts.find(p => p.type === type)?.value ?? '0'
  const weekday = get('weekday')
  if (weekday === 'Sat' || weekday === 'Sun') return false

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
