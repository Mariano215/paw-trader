import type Database from "better-sqlite3";
import { applyTraderSchema } from "./schema.js";

export function initTraderTables(db: Database.Database): void {
  // Authoritative ordered schema (tables, indexes, post-v0 columns, version stamp).
  applyTraderSchema(db)
  // Repair the legacy trader_approvals FK (decision_id -> trader_decisions) on
  // any DB built before the intent correction. Idempotent; no-op when correct.
  migrateTraderApprovalsFk(db)
}

/**
 * Rebuild trader_approvals with the correct FK when the legacy schema is
 * detected (decision_id -> trader_decisions). The column stores a
 * trader_signals.id in practice, so the FK must point there to let
 * createPendingApproval succeed in production (where FKs are ON).
 *
 * The rebuild preserves existing rows. Safe to call on every boot because
 * it short-circuits when the FK is already correct.
 */
function migrateTraderApprovalsFk(db: Database.Database): void {
  const fks = db
    .prepare('PRAGMA foreign_key_list(trader_approvals)')
    .all() as Array<{ table: string; from: string; to: string }>

  const decisionFk = fks.find(
    (r) => r.from === 'decision_id' && r.table === 'trader_decisions',
  )
  if (!decisionFk) return  // already on trader_signals, or no FK row yet

  // SQLite cannot ALTER a FK in place. Rebuild with the correct one and
  // copy every row across. Wrapped in a transaction so a partial rename
  // never leaves the schema half-migrated. foreign_keys must be OFF
  // during the swap -- enable flag is restored by the caller's
  // initialization, which re-runs `db.pragma('foreign_keys = ON')`.
  const priorPragma = db.pragma('foreign_keys', { simple: true })
  db.pragma('foreign_keys = OFF')
  try {
    db.exec(`
      BEGIN;
      CREATE TABLE trader_approvals__new (
        id            TEXT PRIMARY KEY,
        decision_id   TEXT NOT NULL REFERENCES trader_signals(id),
        sent_at       INTEGER NOT NULL,
        responded_at  INTEGER,
        response      TEXT,
        override_size REAL
      );
      INSERT INTO trader_approvals__new (id, decision_id, sent_at, responded_at, response, override_size)
      SELECT id, decision_id, sent_at, responded_at, response, override_size
      FROM trader_approvals;
      DROP TABLE trader_approvals;
      ALTER TABLE trader_approvals__new RENAME TO trader_approvals;
      COMMIT;
    `)
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  } finally {
    if (priorPragma === 1) db.pragma('foreign_keys = ON')
  }
}

/**
 * Upsert a daily PnL snapshot row.
 *
 * Uses INSERT OR REPLACE so re-running at end-of-day with updated
 * numbers (e.g. after a late fill) overwrites the stale row. The date
 * key is always 'YYYY-MM-DD' in America/New_York -- callers must pass
 * the correct local-calendar date, not UTC.
 *
 * nav_open / nav_close are sourced from engine NavSnapshots; when the
 * engine is unreachable pass 0 and the row still records trade activity
 * for the day. cumulative_pnl is the running sum of all pnl_day values
 * up to and including this date -- callers should compute it from the
 * prior row rather than summing the full history each call.
 */
export function insertPnlSnapshot(
  db: Database.Database,
  args: {
    date: string         // 'YYYY-MM-DD'
    navOpen: number
    navClose: number
    pnlDay: number
    tradesCount: number
    benchReturn: number
    cumulativePnl: number
    openUnrealizedPnl?: number
    accountNav?: number
  },
): void {
  db.prepare(`
    INSERT OR REPLACE INTO trader_pnl_snapshots
      (date, nav_open, nav_close, pnl_day, trades_count, bench_return, cumulative_pnl, open_unrealized_pnl, account_nav)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    args.date,
    args.navOpen,
    args.navClose,
    args.pnlDay,
    args.tradesCount,
    args.benchReturn,
    args.cumulativePnl,
    args.openUnrealizedPnl ?? 0,
    args.accountNav ?? 0,
  )
}

/**
 * Return the cumulative_pnl from the most recent snapshot row, or 0 if
 * the table is empty. Used by insertPnlSnapshot callers to carry the
 * running total forward without summing the full history.
 */
export function getLastCumulativePnl(db: Database.Database): number {
  const row = db.prepare(
    `SELECT cumulative_pnl FROM trader_pnl_snapshots ORDER BY date DESC LIMIT 1`,
  ).get() as { cumulative_pnl: number } | undefined
  return row?.cumulative_pnl ?? 0
}

