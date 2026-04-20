/**
 * Phase 3 Task 5 -- Autonomy ladder.
 *
 * Gates the per-decision size on the active strategy's track record.
 * The committee still gets to reason and choose a size_multiplier;
 * this module applies a final prudent scale BEFORE the decision is
 * submitted to the engine.
 *
 * Tier rules:
 *  - cold-start: trade_count < COLD_START_TRADES (30)        -> scale 0.25
 *  - tier-0:     past cold-start but failing a guardrail      -> scale 0.50
 *  - tier-1:     past cold-start, all guardrails clear        -> scale 1.00
 *
 * Tier-0 guardrails (any one trips):
 *  - rolling_sharpe <= 0
 *  - max_dd_pct < -0.10 (decline > 10%)
 *  - 3 of the last 5 thesis grades are C or D
 *
 * The COLD_START_TRADES + COLD_START_SCALE constants mirror the
 * engine-side position_sizer.py warm-up scaling so the brain and
 * engine agree on what "cold start" means.
 */
import type Database from 'better-sqlite3'
import type { StrategyTrackRecord } from './track-record.js'
import type { ThesisGrade } from './verdict-engine.js'

export type LadderTier = 'cold-start' | 'tier-0' | 'tier-1'

export interface LadderInput {
  trackRecord: StrategyTrackRecord | null
  recentGrades: ThesisGrade[]
}

export interface LadderResult {
  tier: LadderTier
  scale: number
  reason: string
}

export const COLD_START_TRADES = 30
export const COLD_START_SCALE = 0.25
export const TIER_0_SCALE = 0.5
export const TIER_1_SCALE = 1.0
export const MAX_DD_THRESHOLD = -0.10
export const RECENT_GRADES_LOOKBACK = 5
export const RECENT_GRADES_BAD_THRESHOLD = 3

/**
 * Pure classification of one strategy's tier. Test driver.
 */
export function classifyTier(input: LadderInput): LadderResult {
  const { trackRecord, recentGrades } = input

  const tradeCount = trackRecord?.trade_count ?? 0
  if (!trackRecord || tradeCount < COLD_START_TRADES) {
    return {
      tier: 'cold-start',
      scale: COLD_START_SCALE,
      reason: `cold start (${tradeCount} of ${COLD_START_TRADES} trades)`,
    }
  }

  if (trackRecord.rolling_sharpe <= 0) {
    return {
      tier: 'tier-0',
      scale: TIER_0_SCALE,
      reason: `tier 0: per-trade sharpe ${trackRecord.rolling_sharpe.toFixed(2)} not positive`,
    }
  }

  if (trackRecord.max_dd_pct < MAX_DD_THRESHOLD) {
    return {
      tier: 'tier-0',
      scale: TIER_0_SCALE,
      reason: `tier 0: max drawdown ${(trackRecord.max_dd_pct * 100).toFixed(1)}% breached ${(MAX_DD_THRESHOLD * 100).toFixed(0)}% gate`,
    }
  }

  const recent = recentGrades.slice(0, RECENT_GRADES_LOOKBACK)
  const bad = recent.filter(g => g === 'C' || g === 'D').length
  if (recent.length >= RECENT_GRADES_BAD_THRESHOLD && bad >= RECENT_GRADES_BAD_THRESHOLD) {
    return {
      tier: 'tier-0',
      scale: TIER_0_SCALE,
      reason: `tier 0: ${bad} of ${recent.length} recent grades are C or D`,
    }
  }

  return {
    tier: 'tier-1',
    scale: TIER_1_SCALE,
    reason: `tier 1: ${trackRecord.trade_count} trades, sharpe ${trackRecord.rolling_sharpe.toFixed(2)}, max dd ${(trackRecord.max_dd_pct * 100).toFixed(1)}%`,
  }
}

/**
 * DB-backed wrapper. Fetches the strategy's track record + recent
 * grades and feeds them to classifyTier. Defaults to cold-start when
 * the strategy has no track record yet.
 */
export function classifyStrategyTier(
  db: Database.Database,
  strategyId: string,
): LadderResult {
  const trackRecord = db.prepare(`
    SELECT strategy_id, trade_count, win_count, rolling_sharpe,
           avg_winner_pct, avg_loser_pct, max_dd_pct, net_pnl_usd,
           computed_at
    FROM trader_strategy_track_record
    WHERE strategy_id = ?
  `).get(strategyId) as StrategyTrackRecord | undefined

  const gradeRows = db.prepare(`
    SELECT v.thesis_grade
    FROM trader_verdicts v
    JOIN trader_decisions d ON d.id = v.decision_id
    JOIN trader_signals   s ON s.id = d.signal_id
    WHERE s.strategy_id = ?
    ORDER BY v.closed_at DESC
    LIMIT ?
  `).all(strategyId, RECENT_GRADES_LOOKBACK) as Array<{ thesis_grade: string }>

  return classifyTier({
    trackRecord: trackRecord ?? null,
    recentGrades: gradeRows.map(r => r.thesis_grade as ThesisGrade),
  })
}
