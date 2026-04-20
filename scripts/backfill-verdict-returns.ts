#!/usr/bin/env node
/**
 * Phase 4 Task B -- one-shot migration that backfills bench_return +
 * hold_drawdown on existing trader_verdicts rows.
 *
 * Phase 3 Task 1 wrote verdicts with placeholder zeros because the
 * engine's /prices endpoint did not exist yet. Phase 3 Task 3 added
 * the endpoint. This script walks all verdicts with
 * returns_backfilled=0, fetches daily closes for the asset + its
 * benchmark over the hold window, computes the two numbers, and
 * flips the flag to 1.
 *
 * Idempotent: re-running after the first successful pass only touches
 * rows that are still flagged 0 (e.g. decisions where the engine was
 * unreachable on the first try). Rows that completed are permanently
 * marked `returns_backfilled=1` and never revisited.
 *
 * Usage:
 *   npx tsx scripts/backfill-verdict-returns.ts
 *   npx tsx scripts/backfill-verdict-returns.ts --dry-run
 *
 * Exit codes:
 *   0  success (including "nothing to do")
 *   1  fatal setup error (missing engine credentials, DB init failed)
 */
import { initDatabase, getDb } from '../src/db.js'
import { initCredentialStore } from '../src/credentials.js'
import { getEngineClient, EngineClient } from '../src/trader/engine-client.js'
import { fetchReturnsForDecision } from '../src/trader/close-out-watcher.js'
import { gradeThesis } from '../src/trader/verdict-engine.js'
import { logger } from '../src/logger.js'
import type Database from 'better-sqlite3'

export interface BackfillPendingRow {
  verdict_id: string
  decision_id: string
  asset: string
  asset_class: string | null
  decided_at: number
  closed_at: number
  pnl_gross: number
  size_usd: number
}

/**
 * Pick up every verdict still flagged as needing backfill. Joins
 * through trader_decisions -> trader_signals -> trader_strategies so
 * we get the asset_class (used by pickBenchSymbol for the crypto vs
 * stock benchmark decision). LEFT JOIN on strategies so orphaned
 * signals do not block the backfill -- we fall back to symbol-based
 * detection.
 */
export function listPendingVerdicts(db: Database.Database): BackfillPendingRow[] {
  return db.prepare(`
    SELECT
      v.id           AS verdict_id,
      v.decision_id  AS decision_id,
      d.asset        AS asset,
      s.asset_class  AS asset_class,
      d.decided_at   AS decided_at,
      v.closed_at    AS closed_at,
      v.pnl_gross    AS pnl_gross,
      d.size_usd     AS size_usd
    FROM trader_verdicts v
    JOIN trader_decisions d ON d.id = v.decision_id
    JOIN trader_signals sig ON sig.id = d.signal_id
    LEFT JOIN trader_strategies s ON s.id = sig.strategy_id
    WHERE v.returns_backfilled = 0
    ORDER BY v.closed_at ASC
  `).all() as BackfillPendingRow[]
}

export interface BackfillSummary {
  total: number
  updated: number
  skipped: number
  errors: number
}

/**
 * Run the backfill against the supplied db + engine client.
 *
 * When `dryRun` is true we still fetch prices (so the run reports
 * what IT WOULD have written) but skip the UPDATE. Lets operators
 * eyeball the first handful of numbers before committing to a write.
 *
 * Each row is handled in isolation: a fetch failure on decision A
 * does not stop decision B. Rows that fail stay flagged 0 so the
 * next invocation picks them up.
 */
export async function runBackfill(
  db: Database.Database,
  engine: EngineClient,
  opts: { dryRun?: boolean } = {},
): Promise<BackfillSummary> {
  const pending = listPendingVerdicts(db)
  const summary: BackfillSummary = {
    total: pending.length,
    updated: 0,
    skipped: 0,
    errors: 0,
  }
  if (pending.length === 0) {
    return summary
  }

  // thesis_grade stored on the original write was computed with the
  // placeholder bench_return=0. Once we substitute the real benchmark
  // we must regrade so the row stays internally consistent. pnl_pct
  // is not persisted, so we approximate it from pnl_gross and the
  // decision's intended size_usd. Slippage can nudge the actual cost
  // basis a few percent, but gradeThesis buckets on coarse thresholds
  // (0%, 2%) so the approximation almost never crosses a boundary.
  const updateStmt = db.prepare(`
    UPDATE trader_verdicts
    SET bench_return = ?,
        hold_drawdown = ?,
        thesis_grade = ?,
        returns_backfilled = 1
    WHERE id = ? AND returns_backfilled = 0
  `)

  for (const row of pending) {
    try {
      const result = await fetchReturnsForDecision(engine, {
        asset: row.asset,
        assetClass: row.asset_class,
        decidedAtMs: row.decided_at,
        closedAtMs: row.closed_at,
      })
      if (!result.success) {
        logger.info(
          { verdictId: row.verdict_id, asset: row.asset },
          'Backfill: skipping (no prices available)',
        )
        summary.skipped += 1
        continue
      }
      const pnlPct = row.size_usd > 0 ? row.pnl_gross / row.size_usd : 0
      const newGrade = gradeThesis(pnlPct, result.benchReturn)
      if (opts.dryRun) {
        logger.info(
          {
            verdictId: row.verdict_id,
            asset: row.asset,
            bench_return: result.benchReturn,
            hold_drawdown: result.holdDrawdown,
            thesis_grade: newGrade,
          },
          'Backfill: DRY-RUN would update',
        )
        summary.updated += 1
        continue
      }
      const info = updateStmt.run(
        result.benchReturn,
        result.holdDrawdown,
        newGrade,
        row.verdict_id,
      )
      // info.changes == 0 means another process already flipped the flag; do
      // not double-count.
      if (info.changes > 0) {
        summary.updated += 1
      } else {
        summary.skipped += 1
      }
    } catch (err) {
      logger.warn(
        { err, verdictId: row.verdict_id, asset: row.asset },
        'Backfill: row failed; will retry on next run',
      )
      summary.errors += 1
    }
  }

  return summary
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run')

  initDatabase()
  const db = getDb()
  // getEngineClient() reads the engine URL + token from the credential
  // store, which must be initialized after the DB is up.
  initCredentialStore(db)
  const engine = getEngineClient()

  logger.info({ dryRun }, 'Backfill: starting verdict returns backfill')
  const summary = await runBackfill(db, engine, { dryRun })
  logger.info(summary, 'Backfill: done')
  // Print a human-readable summary regardless of log level.
  const noun = summary.total === 1 ? 'verdict' : 'verdicts'
  const action = dryRun ? 'would update' : 'updated'
  process.stdout.write(
    `Backfill ${dryRun ? '(DRY-RUN) ' : ''}finished: ${summary.total} ${noun} pending, ` +
      `${summary.updated} ${action}, ${summary.skipped} skipped, ${summary.errors} errors.\n`,
  )
}

const isMain = import.meta.url === `file://${process.argv[1]}`
if (isMain) {
  main().catch(err => {
    logger.error({ err }, 'Backfill: fatal error')
    process.exit(1)
  })
}
