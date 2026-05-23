/**
 * Phase 2 Task 5 -- ReasoningBank (Layer 5) retrieval helpers.
 *
 * The committee coordinator accepts an optional `pastCases` string
 * that is prepended to its synthesis prompt. This module provides the
 * retrieval surface that produces that string from closed-trade
 * summaries stored in trader_reasoning_bank.
 *
 * Phase 2 ships this as a stub: the table exists, the retrieval
 * function is wired, and the committee picks up whatever it returns.
 * The verdicts pipeline that populates the bank lives in Phase 3, so
 * in practice this function returns null until that lands and the
 * first verdict row is written.
 *
 * Phase 3 will replace the simple asset/strategy filter below with
 * HNSW vector similarity over an embedding of the candidate signal.
 * The function signature is intentionally stable across that
 * transition -- callers pass a signal and the max number of cases
 * they want, the function does the ranking.
 */
import type Database from 'better-sqlite3'

export interface ReasoningBankCase {
  id: string
  decision_id: string | null
  signal_id: string | null
  asset: string
  side: string
  strategy: string
  summary: string
  thesis_grade: string | null
  outcome: string | null
  pnl_net: number | null
  embedding_id: string | null
  created_at: number
}

export interface PastCaseQuery {
  asset: string
  strategy: string
  side?: string
  /** Maximum number of cases to return. Defaults to 3. */
  k?: number
}

/**
 * Look up closed-trade summaries relevant to a signal.
 *
 * Phase 2 ranking: most recent closed trades that match asset +
 * strategy. If fewer than `k` match on asset+strategy, fall back to
 * strategy-only matches to keep the coordinator grounded. Returns an
 * empty array when the bank is empty, and never throws -- DB errors
 * are swallowed and logged by the caller's logger (tests just see an
 * empty array).
 */
export function getPastCases(
  db: Database.Database,
  query: PastCaseQuery,
): ReasoningBankCase[] {
  const k = Math.max(1, Math.min(query.k ?? 3, 10))
  try {
    const primary = db
      .prepare(
        `SELECT id, decision_id, signal_id, asset, side, strategy, summary,
                thesis_grade, outcome, pnl_net, embedding_id, created_at
         FROM trader_reasoning_bank
         WHERE asset = ? AND strategy = ?
         ORDER BY created_at DESC
         LIMIT ?`,
      )
      .all(query.asset, query.strategy, k) as ReasoningBankCase[]

    if (primary.length >= k) return primary

    // Fallback: strategy-wide most recent, minus anything already in
    // primary. Keeps the context anchored to the right strategy even
    // when the exact asset has no history yet.
    const excludeIds = primary.map(c => c.id)
    const placeholders = excludeIds.map(() => '?').join(',')
    const remaining = k - primary.length
    const fallbackSql =
      `SELECT id, decision_id, signal_id, asset, side, strategy, summary,
              thesis_grade, outcome, pnl_net, embedding_id, created_at
       FROM trader_reasoning_bank
       WHERE strategy = ?` +
      (excludeIds.length ? ` AND id NOT IN (${placeholders})` : ``) +
      ` ORDER BY created_at DESC
        LIMIT ?`
    const fallback = db
      .prepare(fallbackSql)
      .all(query.strategy, ...excludeIds, remaining) as ReasoningBankCase[]
    return [...primary, ...fallback]
  } catch {
    return []
  }
}

/**
 * Render retrieved cases into the prose block the coordinator expects.
 * Returns null when there is nothing to inject -- callers check for
 * null and skip the "Past similar cases" section in that branch.
 */
export function formatPastCases(cases: ReasoningBankCase[]): string | null {
  if (!cases || cases.length === 0) return null
  const lines = cases.map((c, idx) => {
    const pnl = c.pnl_net != null ? `pnl=${c.pnl_net.toFixed(2)}` : `pnl=?`
    const grade = c.thesis_grade ?? '-'
    const outcome = c.outcome ?? '-'
    return `(${idx + 1}) ${c.asset} ${c.side} via ${c.strategy} -- ` +
      `grade=${grade}, outcome=${outcome}, ${pnl}. ${c.summary}`
  })
  return ['PAST SIMILAR CASES (most recent first):', ...lines].join('\n')
}

/**
 * One-call convenience wrapper: pull cases + format them. Returns
 * null when the bank has no relevant rows. Used by the committee
 * coordinator.
 */
export function retrievePastCases(
  db: Database.Database,
  query: PastCaseQuery,
): string | null {
  const cases = getPastCases(db, query)
  return formatPastCases(cases)
}

export type AssetClass = 'equity' | 'crypto'

export interface RollupResult {
  total: number
  wins: number
  losses: number
  winRate: number
  /** Average net PnL in USD (not a percentage -- pnl_net is stored as a dollar value). */
  avgPnLUsd: number
  /** Worst single-trade net PnL in USD (most negative value in the window). */
  worstDrawdownUsd: number
  /** Best single-trade net PnL in USD. */
  bestTradeUsd: number
  bySymbol: Record<string, string>
  formatted: string
}

/**
 * Aggregate the most recent N closed-trade cases for a given asset class
 * and return a summary suitable for prepending to committee specialist
 * prompts. Pure SQL over trader_reasoning_bank joined to trader_strategies.
 */
export function rollupRecentOutcomes(
  db: Database.Database,
  assetClass: AssetClass,
  limit = 20,
): RollupResult {
  const rows = db.prepare(`
    SELECT rb.asset, rb.side, rb.pnl_net, rb.outcome, rb.created_at
    FROM trader_reasoning_bank rb
    INNER JOIN trader_strategies s ON s.id = rb.strategy
    WHERE s.asset_class = ?
    ORDER BY rb.created_at DESC
    LIMIT ?
  `).all(assetClass, limit) as Array<{
    asset: string; side: string; pnl_net: number | null; outcome: string | null; created_at: number
  }>

  if (rows.length === 0) {
    return {
      total: 0, wins: 0, losses: 0, winRate: 0, avgPnLUsd: 0,
      worstDrawdownUsd: 0, bestTradeUsd: 0, bySymbol: {},
      formatted: 'No prior paper trades yet -- calibration phase.',
    }
  }

  let wins = 0
  let losses = 0
  // pnl_net is stored as a USD dollar value in trader_reasoning_bank.
  const pnls: number[] = []
  const bySymbolPnLs: Record<string, number[]> = {}
  for (const r of rows) {
    const outcome = (r.outcome ?? '').toLowerCase()
    // Skip rows where outcome is still pending/unknown: they have no resolved
    // win/loss classification and their pnl_net=null (defaulted to 0) would
    // dilute winRate and avgPnLUsd, making a profitable strategy look worse.
    if (outcome !== 'win' && outcome !== 'loss') continue
    const pnlUsd = r.pnl_net ?? 0
    pnls.push(pnlUsd)
    if (outcome === 'win') wins++
    else losses++
    if (!bySymbolPnLs[r.asset]) bySymbolPnLs[r.asset] = []
    bySymbolPnLs[r.asset].push(pnlUsd)
  }
  const total = wins + losses
  if (total === 0) {
    return {
      total: 0, wins: 0, losses: 0, winRate: 0, avgPnLUsd: 0,
      worstDrawdownUsd: 0, bestTradeUsd: 0, bySymbol: {},
      formatted: 'No resolved paper trades yet -- calibration phase.',
    }
  }
  const winRate = wins / total
  const avgPnLUsd = pnls.reduce((s, x) => s + x, 0) / total
  // Use reduce instead of spread to avoid RangeError on very large arrays.
  const worstDrawdownUsd = pnls.reduce((min, x) => x < min ? x : min, pnls[0])
  const bestTradeUsd = pnls.reduce((max, x) => x > max ? x : max, pnls[0])

  const bySymbol: Record<string, string> = {}
  for (const [sym, vals] of Object.entries(bySymbolPnLs)) {
    const avg = vals.reduce((s, x) => s + x, 0) / vals.length
    const label = vals.length === 1 ? '1 trade' : `${vals.length} trades`
    bySymbol[sym] = `${avg >= 0 ? '+' : ''}$${avg.toFixed(2)} (${label})`
  }

  const symbolList = Object.entries(bySymbol)
    .map(([sym, blurb]) => `  ${sym}: ${blurb}`)
    .join('\n')

  const warning = (winRate < 0.4 && total >= 5)
    ? '\n  WARNING: win rate below 40%. Consider tightening selection or pausing.'
    : ''

  const formatted = [
    `Last ${total} paper trades (${assetClass}): ${wins}W/${losses}L (${(winRate * 100).toFixed(0)}%).`,
    `Avg ${avgPnLUsd >= 0 ? '+' : ''}$${avgPnLUsd.toFixed(2)}. ` +
      `Best ${bestTradeUsd >= 0 ? '+' : ''}$${bestTradeUsd.toFixed(2)}. ` +
      `Worst $${worstDrawdownUsd.toFixed(2)}.`,
    'By symbol:',
    symbolList + warning,
  ].join('\n')

  return {
    total, wins, losses, winRate, avgPnLUsd,
    worstDrawdownUsd, bestTradeUsd, bySymbol, formatted,
  }
}

/**
 * Insert a case into the bank. Not called from the hot path in Phase
 * 2; kept here so tests can seed the bank and so Phase 3 has a clear
 * entry point.
 */
export function insertCase(
  db: Database.Database,
  row: ReasoningBankCase,
): void {
  db.prepare(`
    INSERT OR REPLACE INTO trader_reasoning_bank
      (id, decision_id, signal_id, asset, side, strategy, summary,
       thesis_grade, outcome, pnl_net, embedding_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    row.id,
    row.decision_id,
    row.signal_id,
    row.asset,
    row.side,
    row.strategy,
    row.summary,
    row.thesis_grade,
    row.outcome,
    row.pnl_net,
    row.embedding_id,
    row.created_at,
  )
}
