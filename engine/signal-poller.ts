import type Database from 'better-sqlite3'
import type { EngineClient } from './engine-client.js'

const SCORE_THRESHOLD = 0.5

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

export async function pollAndStoreSignals(db: Database.Database, client: EngineClient): Promise<void> {
  let candidates
  try {
    candidates = await client.getSignals(30)
  } catch {
    return  // engine unreachable -- skip cycle, do not throw
  }

  const insert = db.prepare(`
    INSERT OR IGNORE INTO trader_signals
      (id, strategy_id, asset, side, raw_score, horizon_days, enrichment_json, generated_at, status)
    VALUES (?, ?, ?, ?, ?, ?, NULL, ?, 'pending')
  `)

  const insertMany = db.transaction((items: typeof candidates) => {
    for (const c of items) {
      if (Math.abs(c.raw_score) < SCORE_THRESHOLD) continue
      insert.run(
        c.id,
        resolveStrategyId(c.strategy, c.asset),
        c.asset,
        c.side,
        c.raw_score,
        c.horizon_days,
        c.generated_at,
      )
    }
  })

  insertMany(candidates)
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
