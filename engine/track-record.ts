/**
 * Phase 3 Task 2 -- Strategy track record materializer.
 *
 * trader_strategy_track_record is a denormalized rollup of
 * trader_verdicts joined back to the originating strategy. The truth
 * lives in the verdicts table; this module recomputes the rollup so
 * the dashboard + autonomy ladder (Task 5) can read it cheaply
 * without re-aggregating on every read.
 *
 * Recomputation is triggered after every verdict write (close-out
 * watcher hook) so the rollup is always within one tick of the
 * verdicts table. A separate `recomputeAllTrackRecords` is exposed
 * for maintenance / migration scenarios where the cache needs a
 * full rebuild.
 *
 * No LLM calls. Pure SQL + arithmetic.
 */
import type Database from 'better-sqlite3'
import { logger } from '../logger.js'

export interface StrategyTrackRecord {
  strategy_id: string
  trade_count: number
  win_count: number
  rolling_sharpe: number
  avg_winner_pct: number
  avg_loser_pct: number
  max_dd_pct: number
  net_pnl_usd: number
  computed_at: number
}

interface VerdictForRollup {
  pnl_gross: number
  pnl_net: number
  closed_at: number
  cost_basis_usd: number  // computed via decision.size_usd; used for pnl_pct
}

/**
 * Pull all verdicts for a single strategy in chronological order. The
 * join walks trader_verdicts -> trader_decisions -> trader_signals to
 * filter by strategy_id, plus pulls decision.size_usd as the cost
 * basis for pnl_pct math.
 *
 * Excludes quarantined verdicts (schema v6): everything closed before the
 * duplicate-lot fix was graded per duplicate decision rather than per real
 * position, so the record counted 127 trades where 18 actually happened. Those
 * rows are kept for forensics but must not reach the track record, the autonomy
 * ladder, or the go-live gate's trade count.
 */
function getVerdictsForStrategy(
  db: Database.Database,
  strategyId: string,
): VerdictForRollup[] {
  return db.prepare(`
    SELECT v.pnl_gross, v.pnl_net, v.closed_at,
           COALESCE(d.size_usd, 0) AS cost_basis_usd
    FROM trader_verdicts v
    JOIN trader_decisions d ON d.id = v.decision_id
    JOIN trader_signals   s ON s.id = d.signal_id
    WHERE s.strategy_id = ?
      AND v.excluded_at IS NULL
    ORDER BY v.closed_at ASC
  `).all(strategyId) as VerdictForRollup[]
}

/**
 * Compute a track record from a verdict list. Pure function so the
 * test suite can drive it directly without DB scaffolding.
 *
 *  - rolling_sharpe: per-trade Sharpe approximation. mean(pnl_pct) /
 *    std(pnl_pct), no annualization (per-trade Sharpe is the right
 *    unit for ranking strategies). Returns 0 when stdev is 0 (one
 *    trade or all identical returns).
 *  - max_dd_pct: max drawdown of the cumulative net pnl curve,
 *    expressed as a fraction of navBase (account equity). Always in
 *    [-1, 0]. 0 when the curve never declines, or when no navBase is
 *    available -- see the comment at the computation below for why a
 *    percentage is not reportable without an equity base.
 */
export function computeTrackRecord(
  strategyId: string,
  verdicts: VerdictForRollup[],
  nowMs: number = Date.now(),
  navBase: number | null = null,
): StrategyTrackRecord {
  const trade_count = verdicts.length
  if (trade_count === 0) {
    return {
      strategy_id: strategyId,
      trade_count: 0,
      win_count: 0,
      rolling_sharpe: 0,
      avg_winner_pct: 0,
      avg_loser_pct: 0,
      max_dd_pct: 0,
      net_pnl_usd: 0,
      computed_at: nowMs,
    }
  }

  let win_count = 0
  let net_pnl_usd = 0
  const pnlPcts: number[] = []
  const winnerPcts: number[] = []
  const loserPcts: number[] = []

  for (const v of verdicts) {
    const pct = v.cost_basis_usd > 0 ? v.pnl_gross / v.cost_basis_usd : 0
    pnlPcts.push(pct)
    if (v.pnl_gross > 0) {
      win_count += 1
      winnerPcts.push(pct)
    } else {
      // Break-even trades (pnl_gross === 0) count as losses -- conservative
      // convention that keeps win_count + loser_count === trade_count and
      // avoids inflating win rate by silently excluding zero-pnl closes.
      loserPcts.push(pct)
    }
    net_pnl_usd += v.pnl_net
  }

  const mean = (xs: number[]): number => xs.length === 0 ? 0 : xs.reduce((s, x) => s + x, 0) / xs.length
  const stdev = (xs: number[]): number => {
    if (xs.length < 2) return 0
    const m = mean(xs)
    const variance = xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1)
    return Math.sqrt(variance)
  }

  const meanPct = mean(pnlPcts)
  const sdPct = stdev(pnlPcts)
  const rolling_sharpe = sdPct > 0 ? meanPct / sdPct : 0

  const avg_winner_pct = winnerPcts.length > 0 ? mean(winnerPcts) : 0
  const avg_loser_pct = loserPcts.length > 0 ? mean(loserPcts) : 0

  // Max drawdown over the cumulative net pnl curve, in dollars first.
  let cum = 0
  let peak = 0
  let maxDdUsd = 0
  for (const v of verdicts) {
    cum += v.pnl_net
    if (cum > peak) peak = cum
    const ddAbs = peak - cum
    if (ddAbs > maxDdUsd) maxDdUsd = ddAbs
  }

  // Denominate against account equity, not against the peak of the P&L curve.
  //
  // Dividing by the peak of a cumulative-P&L curve is unbounded by
  // construction, because that peak can sit arbitrarily close to zero while
  // the subsequent decline is large. Two successive fixes missed this. The
  // first used Math.max(peak, 1), which leaked raw dollars as a percent
  // (-$945.96 rendered as -94595.88%). The second guarded only peak <= 0,
  // which still blows up on a *small positive* peak: peak +$4.20 with the
  // curve at -$10.68 gives 3.54, rendered as -354%. That is how the
  // 2026-08-02 weekly report printed -259.20%.
  //
  // A drawdown percentage is only bounded by -100% when the denominator is an
  // equity base. With no navBase there is no honest percentage to report, so
  // return 0 and let net_pnl_usd carry the loss.
  const usableNav = navBase != null && navBase > 0
  const max_dd_pct = usableNav && maxDdUsd > 0
    ? -Math.min(maxDdUsd / navBase, 1)
    : 0

  return {
    strategy_id: strategyId,
    trade_count,
    win_count,
    rolling_sharpe,
    avg_winner_pct,
    avg_loser_pct,
    max_dd_pct,
    net_pnl_usd,
    computed_at: nowMs,
  }
}

/** UPSERT a row into trader_strategy_track_record. */
function persistTrackRecord(db: Database.Database, record: StrategyTrackRecord): void {
  db.prepare(`
    INSERT INTO trader_strategy_track_record
      (strategy_id, trade_count, win_count, rolling_sharpe,
       avg_winner_pct, avg_loser_pct, max_dd_pct, net_pnl_usd, computed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(strategy_id) DO UPDATE SET
      trade_count    = excluded.trade_count,
      win_count      = excluded.win_count,
      rolling_sharpe = excluded.rolling_sharpe,
      avg_winner_pct = excluded.avg_winner_pct,
      avg_loser_pct  = excluded.avg_loser_pct,
      max_dd_pct     = excluded.max_dd_pct,
      net_pnl_usd    = excluded.net_pnl_usd,
      computed_at    = excluded.computed_at
  `).run(
    record.strategy_id,
    record.trade_count,
    record.win_count,
    record.rolling_sharpe,
    record.avg_winner_pct,
    record.avg_loser_pct,
    record.max_dd_pct,
    record.net_pnl_usd,
    record.computed_at,
  )
}

/**
 * Latest account equity, used as the drawdown denominator. Read from the
 * persisted snapshot table rather than the engine so the rollup stays
 * synchronous and works with the engine unreachable. account_nav defaults to 0
 * for rows written before schema v3, so fall back to nav_close, and return null
 * when neither is usable rather than inventing a base.
 */
function latestNavBase(db: Database.Database): number | null {
  try {
    const row = db.prepare(`
      SELECT account_nav, nav_close
      FROM trader_pnl_snapshots
      ORDER BY date DESC
      LIMIT 1
    `).get() as { account_nav: number | null; nav_close: number | null } | undefined
    if (!row) return null
    if (row.account_nav != null && row.account_nav > 0) return row.account_nav
    if (row.nav_close != null && row.nav_close > 0) return row.nav_close
    return null
  } catch {
    return null
  }
}

/**
 * Recompute the track record for one strategy and upsert. Returns the
 * computed record so callers (mostly the close-out watcher) can log
 * useful detail. Failures are logged and swallowed; persistence
 * errors must not roll back the upstream verdict write.
 */
export function recomputeTrackRecord(
  db: Database.Database,
  strategyId: string,
): StrategyTrackRecord | null {
  try {
    const verdicts = getVerdictsForStrategy(db, strategyId)
    const record = computeTrackRecord(strategyId, verdicts, Date.now(), latestNavBase(db))
    persistTrackRecord(db, record)
    return record
  } catch (err) {
    logger.warn({ err, strategyId }, 'Track record recompute failed')
    return null
  }
}

/**
 * Recompute every strategy that has at least one verdict. Used by
 * maintenance scripts and tests. Strategies with zero verdicts are
 * left out of the cache (the absence is the answer).
 */
export function recomputeAllTrackRecords(db: Database.Database): StrategyTrackRecord[] {
  const strategies = db.prepare(`
    SELECT DISTINCT s.strategy_id
    FROM trader_signals s
    JOIN trader_decisions d ON d.signal_id = s.id
    JOIN trader_verdicts  v ON v.decision_id = d.id
  `).all() as Array<{ strategy_id: string }>

  const records: StrategyTrackRecord[] = []
  for (const row of strategies) {
    const r = recomputeTrackRecord(db, row.strategy_id)
    if (r) records.push(r)
  }
  return records
}

/** Read back the full track-record table for the dashboard endpoint. */
export function listTrackRecords(db: Database.Database): StrategyTrackRecord[] {
  return db.prepare(`
    SELECT strategy_id, trade_count, win_count, rolling_sharpe,
           avg_winner_pct, avg_loser_pct, max_dd_pct, net_pnl_usd, computed_at
    FROM trader_strategy_track_record
    ORDER BY strategy_id
  `).all() as StrategyTrackRecord[]
}

// ---------------------------------------------------------------------------
// Open-position accounting
// ---------------------------------------------------------------------------

import type { EnginePosition } from './types.js'

export interface OpenPositionRow {
  decision_id: string
  signal_id: string
  asset: string
  side: string
  strategy_id: string
  cost_basis_usd: number
  decided_at: number
}

export interface OpenPositionsSummary {
  /** Count of executed decisions with no verdict yet (the "Open Positions" KPI). */
  openCount: number
  /**
   * Sum of size_usd across open decisions whose asset HAS a live engine
   * position. Deliberately the same population as totalMarketValueUsd and
   * totalUnrealizedPnlUsd so the three can be read side by side.
   *
   * The 2026-08-02 report printed "Cost basis total: $71,521.42 - Market
   * value: $56,484.08 - Unrealized: $161.97" on one line, which cannot all be
   * true: cost basis summed 44 decision rows including ones the broker never
   * filled, while market value and unrealized were per-asset broker values
   * over ~12 assets. Unfilled notional now has its own field below.
   */
  totalCostBasisUsd: number
  /** Sum of size_usd for open decisions with NO live engine position. Intent, not exposure. */
  unmatchedCostBasisUsd: number
  /**
   * Sum of unrealized_pnl from the live engine positions that match an open
   * decision by asset. Decisions whose asset has no live engine position
   * contribute 0 (and are counted in `unmatchedCount` so the report can flag
   * drift between the brain's open-decision set and the engine's positions).
   */
  totalUnrealizedPnlUsd: number
  /** Sum of market_value from matched live positions; the current dollar value held. */
  totalMarketValueUsd: number
  /** Open decisions whose asset has NO live engine position (possible stale/never-filled). */
  unmatchedCount: number
  positions: OpenPositionRow[]
}

/**
 * Executed decisions that have not produced a verdict yet. This is the brain's
 * notion of an open position: a buy that fired but has not closed out. The
 * LEFT JOIN to trader_verdicts + WHERE v.decision_id IS NULL is equivalent to
 * the NOT IN form findOpenDecisions uses, kept here as its own helper so the
 * report and dashboard can read open positions without importing the close-out
 * watcher.
 */
export function listOpenPositions(db: Database.Database): OpenPositionRow[] {
  return db.prepare(`
    SELECT
      d.id          AS decision_id,
      d.signal_id   AS signal_id,
      d.asset       AS asset,
      s.side        AS side,
      s.strategy_id AS strategy_id,
      COALESCE(d.size_usd, 0) AS cost_basis_usd,
      d.decided_at  AS decided_at
    FROM trader_decisions d
    JOIN trader_signals s ON s.id = d.signal_id
    LEFT JOIN trader_verdicts v ON v.decision_id = d.id
    WHERE d.status = 'executed'
      AND v.decision_id IS NULL
    ORDER BY d.decided_at ASC
  `).all() as OpenPositionRow[]
}

/**
 * Statuses that mean "we already have exposure (or are about to) on this
 * asset". Broader than listOpenPositions' 'executed', because the re-entry
 * guard has to cover the window between submit and fill: the trader tick runs
 * every 5 minutes and the reconciler may not have promoted submitted ->
 * executed yet. exit_submitted counts too -- re-entering while the close is in
 * flight is the whipsaw we are trying to stop.
 */
const HOLDING_STATUSES = [
  'submitting', 'submitted', 'pending_fill', 'executed', 'exit_submitted',
] as const

/**
 * True when the book already holds (or is in the middle of acquiring) this
 * asset for this strategy and side.
 *
 * This is the re-entry guard. The partial unique index on trader_signals is
 * scoped to status IN ('pending','dispatching'), so a signal that has already
 * dispatched leaves the index and frees the slot; five minutes later the engine
 * re-emits the same candidate and the dispatcher opens a second identical lot.
 * That is how one TLT signal became 8 lots of $1973.25 on 2026-07-31, and how
 * the internal trade count reached 127 against 5 broker round-trips.
 *
 * Deliberately keyed on holdings rather than on signal status: re-entry after a
 * genuine full exit must stay possible, and it is, because closing writes a
 * verdict which drops the decision out of this query.
 */
export function isAssetHeld(
  db: Database.Database,
  params: {
    asset: string
    side: string
    strategyId: string
    /**
     * Live broker positions. When supplied, an asset the broker is flat on can
     * NEVER be reported as held, whatever the decision rows say.
     *
     * This is not belt-and-braces, it is the difference between a guard and an
     * outage. On 2026-08-02 six QQQ decisions sat at status='executed' with the
     * broker flat since June, because the close-out watcher could not grade
     * them and left them open forever. A DB-only guard reads that as "we hold
     * QQQ" and blocks every future QQQ signal permanently. Broker truth wins.
     */
    positions?: Array<{ asset: string; qty: number }>
  },
): boolean {
  if (params.positions) {
    const flatAtBroker = !params.positions.some(
      (p) => p.asset === params.asset && Math.abs(p.qty) > 1e-9,
    )
    if (flatAtBroker) return false
  }
  const placeholders = HOLDING_STATUSES.map(() => '?').join(', ')
  const row = db.prepare(`
    SELECT 1
    FROM trader_decisions d
    JOIN trader_signals s ON s.id = d.signal_id
    LEFT JOIN trader_verdicts v ON v.decision_id = d.id
    WHERE s.asset = ?
      AND s.side = ?
      AND s.strategy_id = ?
      AND d.status IN (${placeholders})
      AND v.decision_id IS NULL
    LIMIT 1
  `).get(params.asset, params.side, params.strategyId, ...HOLDING_STATUSES)
  return row !== undefined
}

/**
 * Combine the open-decision set with a live engine positions snapshot to
 * produce the count + cost basis + unrealized MTM the weekly report needs.
 *
 * Matching is by asset. When multiple open decisions share one asset (e.g. two
 * scaled-in buys of AAPL), the engine reports a single aggregate position for
 * that asset, so we attribute that asset's market_value/unrealized_pnl ONCE
 * (to the asset, not per decision) to avoid double counting. Cost basis is
 * split the same way: totalCostBasisUsd covers matched assets only, so it is
 * comparable to market value, and unmatchedCostBasisUsd carries the notional
 * of decisions the brain thinks are open but the broker has no position for.
 * openCount still reflects every decision.
 *
 * positions can be [] (engine unreachable). In that case MTM/market-value are
 * 0, every open decision is unmatched, and the caller renders the count + cost
 * basis with an "MTM unavailable" note rather than a fake $0 unrealized.
 */
export function summarizeOpenPositions(
  openDecisions: OpenPositionRow[],
  positions: EnginePosition[],
): OpenPositionsSummary {
  const byAsset = new Map<string, EnginePosition>()
  for (const p of positions) {
    if (Math.abs(p.qty) > 1e-9) byAsset.set(p.asset, p)
  }

  let totalCostBasisUsd = 0
  let unmatchedCostBasisUsd = 0
  const matchedAssets = new Set<string>()
  const unmatchedAssets = new Set<string>()
  for (const d of openDecisions) {
    if (byAsset.has(d.asset)) {
      matchedAssets.add(d.asset)
      totalCostBasisUsd += d.cost_basis_usd
    } else {
      unmatchedAssets.add(d.asset)
      unmatchedCostBasisUsd += d.cost_basis_usd
    }
  }

  let totalUnrealizedPnlUsd = 0
  let totalMarketValueUsd = 0
  for (const asset of matchedAssets) {
    const pos = byAsset.get(asset)!
    totalUnrealizedPnlUsd += pos.unrealized_pnl
    totalMarketValueUsd += pos.market_value
  }

  return {
    openCount: openDecisions.length,
    totalCostBasisUsd,
    unmatchedCostBasisUsd,
    totalUnrealizedPnlUsd,
    totalMarketValueUsd,
    unmatchedCount: unmatchedAssets.size,
    positions: openDecisions,
  }
}
