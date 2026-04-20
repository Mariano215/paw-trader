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
 *    expressed as a fraction of the running peak. Always <= 0 (a
 *    decline). 0 when the curve never declines.
 */
export function computeTrackRecord(
  strategyId: string,
  verdicts: VerdictForRollup[],
  nowMs: number = Date.now(),
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
    } else if (v.pnl_gross < 0) {
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

  // Max drawdown over the cumulative net pnl curve.
  let cum = 0
  let peak = 0
  let maxDd = 0
  for (const v of verdicts) {
    cum += v.pnl_net
    if (cum > peak) peak = cum
    const ddAbs = peak - cum
    // Express as a fraction of the running peak. When the peak is 0
    // (still underwater from start), use the decline relative to the
    // initial 0 baseline as an absolute USD figure normalised by the
    // largest cum so far. We clamp peak to 1 in that case so the
    // fraction stays meaningful and bounded.
    const ddPct = ddAbs / Math.max(peak, 1)
    if (ddPct > maxDd) maxDd = ddPct
  }
  // Express as a non-positive number (a decline). Use 0 explicitly
  // (not -0) when there is no drawdown so callers can do strict
  // equality checks safely.
  const max_dd_pct = maxDd === 0 ? 0 : -maxDd

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
    const record = computeTrackRecord(strategyId, verdicts)
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
