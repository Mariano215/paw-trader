import type Database from "better-sqlite3";

export function initTraderTables(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS trader_strategies (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      asset_class TEXT NOT NULL,
      tier        INTEGER NOT NULL DEFAULT 0,
      status      TEXT NOT NULL DEFAULT 'active',
      params_json TEXT NOT NULL,
      created_at  INTEGER NOT NULL,
      updated_at  INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS trader_signals (
      id              TEXT PRIMARY KEY,
      strategy_id     TEXT NOT NULL REFERENCES trader_strategies(id),
      asset           TEXT NOT NULL,
      side            TEXT NOT NULL,
      raw_score       REAL NOT NULL,
      horizon_days    INTEGER NOT NULL,
      enrichment_json TEXT,
      generated_at    INTEGER NOT NULL,
      status          TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_signals_status
      ON trader_signals(status, generated_at);

    CREATE TABLE IF NOT EXISTS trader_decisions (
      id                      TEXT PRIMARY KEY,
      signal_id               TEXT NOT NULL REFERENCES trader_signals(id),
      action                  TEXT NOT NULL,
      asset                   TEXT NOT NULL,
      size_usd                REAL,
      entry_type              TEXT,
      entry_price             REAL,
      stop_loss               REAL,
      take_profit             REAL,
      thesis                  TEXT NOT NULL,
      confidence              REAL NOT NULL,
      committee_transcript_id TEXT,
      decided_at              INTEGER NOT NULL,
      status                  TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS trader_committee_transcripts (
      id              TEXT PRIMARY KEY,
      signal_id       TEXT NOT NULL REFERENCES trader_signals(id),
      transcript_json TEXT NOT NULL,
      rounds          INTEGER NOT NULL,
      total_tokens    INTEGER NOT NULL,
      total_cost_usd  REAL NOT NULL,
      created_at      INTEGER NOT NULL
    );

    -- Note: the column is named decision_id for historical reasons, but it
    -- stores the trader_signals.id (the approval card is raised BEFORE the
    -- committee runs, so no trader_decisions row exists yet). The old FK
    -- pointed at trader_decisions(id) which made every approval insert fail
    -- with FOREIGN KEY constraint in production (trader tests all disable
    -- FK enforcement so this stayed hidden). migrateTraderApprovalsFk()
    -- below rebuilds pre-existing tables that still have the broken FK.
    CREATE TABLE IF NOT EXISTS trader_approvals (
      id            TEXT PRIMARY KEY,
      decision_id   TEXT NOT NULL REFERENCES trader_signals(id),
      sent_at       INTEGER NOT NULL,
      responded_at  INTEGER,
      response      TEXT,
      override_size REAL
    );

    CREATE TABLE IF NOT EXISTS trader_signal_suppressions (
      id                     TEXT PRIMARY KEY,
      signal_id              TEXT REFERENCES trader_signals(id),
      strategy_id            TEXT NOT NULL REFERENCES trader_strategies(id),
      asset                  TEXT NOT NULL,
      side                   TEXT NOT NULL,
      reason                 TEXT NOT NULL,
      raw_score              REAL NOT NULL,
      enrichment_fingerprint TEXT,
      suppressed_at          INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_trader_signal_suppressions_lookup
      ON trader_signal_suppressions(strategy_id, asset, side, suppressed_at);

    CREATE TABLE IF NOT EXISTS trader_verdicts (
      id                     TEXT PRIMARY KEY,
      decision_id            TEXT NOT NULL REFERENCES trader_decisions(id),
      pnl_gross              REAL NOT NULL,
      pnl_net                REAL NOT NULL,
      bench_return           REAL NOT NULL,
      hold_drawdown          REAL NOT NULL,
      thesis_grade           TEXT NOT NULL,
      agent_attribution_json TEXT NOT NULL,
      embedding_id           TEXT,
      closed_at              INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS trader_strategy_track_record (
      strategy_id    TEXT PRIMARY KEY REFERENCES trader_strategies(id),
      trade_count    INTEGER NOT NULL,
      win_count      INTEGER NOT NULL,
      rolling_sharpe REAL NOT NULL,
      avg_winner_pct REAL NOT NULL,
      avg_loser_pct  REAL NOT NULL,
      max_dd_pct     REAL NOT NULL,
      net_pnl_usd    REAL NOT NULL,
      computed_at    INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS trader_circuit_breakers (
      id          TEXT PRIMARY KEY,
      rule        TEXT NOT NULL,
      tripped_at  INTEGER NOT NULL,
      reason      TEXT NOT NULL,
      cleared_at  INTEGER,
      cleared_by  TEXT
    );

    CREATE TABLE IF NOT EXISTS trader_pnl_snapshots (
      date           TEXT PRIMARY KEY,
      nav_open       REAL NOT NULL,
      nav_close      REAL NOT NULL,
      pnl_day        REAL NOT NULL,
      trades_count   INTEGER NOT NULL,
      bench_return   REAL NOT NULL,
      cumulative_pnl REAL NOT NULL
    );

    -- Phase 2 Task 5 -- ReasoningBank (Layer 5)
    -- Stores distilled summaries of closed trades so the committee
    -- coordinator can retrieve similar past cases at inference time.
    -- The verdicts pipeline that populates this table is Phase 3; the
    -- table ships empty so the retrieval path is a no-op in Phase 2.
    CREATE TABLE IF NOT EXISTS trader_reasoning_bank (
      id               TEXT PRIMARY KEY,
      decision_id      TEXT,
      signal_id        TEXT,
      asset            TEXT NOT NULL,
      side             TEXT NOT NULL,
      strategy         TEXT NOT NULL,
      summary          TEXT NOT NULL,
      thesis_grade     TEXT,
      outcome          TEXT,
      pnl_net          REAL,
      embedding_id     TEXT,
      created_at       INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_reasoning_bank_asset_strategy
      ON trader_reasoning_bank(asset, strategy, created_at);
  `);

  // Phase 4 Task B -- returns_backfilled flag on trader_verdicts.
  // 0 = bench_return + hold_drawdown are placeholder zeros that still
  // need to be filled in from /prices. 1 = values reflect real price
  // data (or intentionally computed zeros). The backfill migration
  // script and close-out-watcher both flip this to 1 when they
  // populate the fields; floating-point zero detection cannot tell
  // "not yet computed" from "legitimately zero return".
  //
  // Wrapped in try/catch because SQLite ALTER TABLE ADD COLUMN has no
  // IF NOT EXISTS form -- on re-run it throws "duplicate column name"
  // which we swallow so initTraderTables stays idempotent. Any other
  // error bubbles up.
  addColumnIfMissing(db, 'trader_verdicts', 'returns_backfilled', 'INTEGER NOT NULL DEFAULT 0')

  // Phase 5 Task 1 -- per-strategy live cap. NULL means "use default
  // NAV-based cap"; a numeric value is a hard ceiling that overrides
  // the autonomy ladder + committee output. Rolled out before the
  // cap lift so partially trained strategies stay at $200.
  addColumnIfMissing(db, 'trader_strategies', 'max_size_usd', 'REAL')

  // Phase 5 Task 2 -- monitor alert state. Holds one row per alert_id
  // with the last_alerted_at timestamp (ms) so the monitor can dedup
  // alerts that otherwise fire every tick. The sharpe-flip alert
  // overloads last_alerted_at to store a sign marker (+1 or -1)
  // instead of a timestamp. See src/trader/monitor.ts for the
  // explanation. One table, two storage conventions, documented.
  db.exec(`
    CREATE TABLE IF NOT EXISTS trader_alert_state (
      alert_id        TEXT PRIMARY KEY,
      last_alerted_at INTEGER NOT NULL
    );
  `);

  // Fix the trader_approvals FK for any DB created before the intent
  // correction. See the comment on the CREATE TABLE above. Idempotent:
  // no-op when the FK is already correct or the table is empty-and-new.
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
 * Idempotent ALTER TABLE ... ADD COLUMN helper. No-op when the column
 * already exists (swallows the SQLite "duplicate column name" error).
 * Any other error propagates.
 */
function addColumnIfMissing(
  db: Database.Database,
  table: string,
  column: string,
  typeDecl: string,
): void {
  try {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${typeDecl}`)
  } catch (err) {
    const msg = (err as Error).message ?? ''
    if (!/duplicate column name/i.test(msg)) {
      throw err
    }
  }
}
