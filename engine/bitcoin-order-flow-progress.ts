import type Database from 'better-sqlite3'

const DAY_MS = 24 * 60 * 60 * 1000

export interface BitcoinOrderFlowResearchProgress {
  declarationAt: number
  collectionThroughAt: number | null
  totalBars: number
  eligibleBars: number
  ineligibleBars: number
  collectionDaysCompleted: number
  minimumForwardDays: number
  earliestEvaluationAt: number
  collectionMature: boolean
}

interface ProgressAggregate {
  total_bars: number
  eligible_bars: number
  collection_through_at: number | null
}

/** Read-only progress over immutable completed bars. Never evaluates or activates a strategy. */
export function getBitcoinOrderFlowResearchProgress(
  db: Database.Database,
  declarationAt: number,
  minimumForwardDays = 180,
): BitcoinOrderFlowResearchProgress {
  if (!Number.isSafeInteger(declarationAt) || declarationAt <= 0) {
    throw new Error('invalid Bitcoin research declaration timestamp')
  }
  if (!Number.isSafeInteger(minimumForwardDays) || minimumForwardDays <= 0 || minimumForwardDays > 3650) {
    throw new Error('invalid Bitcoin research minimum forward days')
  }
  const row = db.prepare(`SELECT
      COUNT(*) AS total_bars,
      COALESCE(SUM(eligible), 0) AS eligible_bars,
      MAX(bucket_end_ms) AS collection_through_at
    FROM bitcoin_order_flow_15m_bars`).get() as ProgressAggregate
  const totalBars = Number(row.total_bars)
  const eligibleBars = Number(row.eligible_bars)
  const collectionThroughAt = row.collection_through_at === null ? null : Number(row.collection_through_at)
  const earliestEvaluationAt = declarationAt + minimumForwardDays * DAY_MS
  const collectionDaysCompleted = collectionThroughAt === null
    ? 0
    : Math.floor(Math.max(0, collectionThroughAt - declarationAt) / DAY_MS)
  return {
    declarationAt,
    collectionThroughAt,
    totalBars,
    eligibleBars,
    ineligibleBars: totalBars - eligibleBars,
    collectionDaysCompleted,
    minimumForwardDays,
    earliestEvaluationAt,
    collectionMature: collectionThroughAt !== null && collectionThroughAt >= earliestEvaluationAt,
  }
}
