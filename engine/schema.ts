// src/trader/schema.ts
// Authoritative, ordered trader-schema migration.
//
// This is the single source of truth for the Paw Trader SQLite schema. It runs
// on BOTH the bot process (src/trader/db.ts -> initTraderTables) AND the
// dashboard server process (server/src/db.ts -> getBotDbWrite). Both processes
// open the SAME bot DB file, so the schema must be applied + asserted in both
// boot paths to prevent column drift (the engine_order_id "added three times"
// failure).
//
// Version tracking uses a dedicated trader_schema_version table, NOT the global
// PRAGMA user_version (which the generic runner in src/migrations.ts already
// owns). Keeping a separate counter lets the server apply ONLY the trader
// schema without dragging in the full generic migration set.
//
// HOW TO ADD A MIGRATION:
//   1. Append an entry with version = current max + 1.
//   2. Make it additive (CREATE TABLE IF NOT EXISTS / addColumn). Never drop.
//   3. Never edit or reorder a shipped entry.
//   4. Bump nothing else: TRADER_SCHEMA_VERSION is derived from the list.

import type Database from 'better-sqlite3'

export interface TraderMigration {
  version: number
  description: string
  up: (db: Database.Database) => void
}

/**
 * Idempotent ADD COLUMN. SQLite has no ALTER TABLE ... ADD COLUMN IF NOT EXISTS,
 * so on re-run it throws "duplicate column name" which we swallow. Any other
 * error propagates. Identical semantics to the old addColumnIfMissing in db.ts.
 */
function addColumn(db: Database.Database, table: string, column: string, typeDecl: string): void {
  try {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${typeDecl}`)
  } catch (err) {
    const msg = (err as Error).message ?? ''
    if (!/duplicate column name/i.test(msg)) throw err
  }
}

export const TRADER_MIGRATIONS: TraderMigration[] = [
  {
    version: 1,
    description: 'v0 baseline: full trader schema as of the pre-migration ad-hoc build',
    up: (db) => {
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

        CREATE UNIQUE INDEX IF NOT EXISTS idx_trader_signals_pending_asset_side
          ON trader_signals (asset, side)
          WHERE status IN ('pending', 'dispatching');

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
        -- with FOREIGN KEY constraint in production. migrateTraderApprovalsFk()
        -- in db.ts rebuilds pre-existing tables that still have the broken FK.
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

        CREATE TABLE IF NOT EXISTS trader_alert_state (
          alert_id        TEXT PRIMARY KEY,
          last_alerted_at INTEGER NOT NULL
        );
      `)

      // Columns added post-v0 via addColumnIfMissing in the old db.ts. Folded
      // into the baseline so a brand-new DB lands the complete shape, and a
      // legacy DB missing any of them gets it backfilled here.
      addColumn(db, 'trader_verdicts', 'returns_backfilled', 'INTEGER NOT NULL DEFAULT 0')
      addColumn(db, 'trader_strategies', 'max_size_usd', 'REAL')
      addColumn(db, 'trader_decisions', 'engine_order_id', 'TEXT')
    },
  },
  // Append future trader migrations below, version = previous + 1.
  {
    version: 2,
    description: 'Order-lifecycle: fill confirmation + transient retry bookkeeping columns',
    up: (db) => {
      // submit_attempts counts engine submit tries (for MAX_SUBMIT_RETRIES).
      // next_retry_at (ms) is when a retry_pending decision becomes eligible.
      // filled_qty / filled_avg_price cache the engine-confirmed fill so the
      // verdict path can read them without a second engine round-trip.
      addColumn(db, 'trader_decisions', 'submit_attempts', 'INTEGER NOT NULL DEFAULT 0')
      addColumn(db, 'trader_decisions', 'next_retry_at', 'INTEGER')
      addColumn(db, 'trader_decisions', 'filled_qty', 'REAL')
      addColumn(db, 'trader_decisions', 'filled_avg_price', 'REAL')
    },
  },
  {
    version: 3,
    description: 'P&L truthfulness: separate open-position unrealized MTM and account NAV columns in trader_pnl_snapshots',
    up: (db) => {
      // open_unrealized_pnl: mark-to-market on OPEN positions (live engine).
      // account_nav: broker account equity (NAV) at snapshot time.
      // Both are stored separately from pnl_day (realized, closed trades only)
      // so the dashboard and report can display the three distinct money lines
      // without conflating account drift with strategy performance.
      addColumn(db, 'trader_pnl_snapshots', 'open_unrealized_pnl', 'REAL NOT NULL DEFAULT 0')
      addColumn(db, 'trader_pnl_snapshots', 'account_nav', 'REAL NOT NULL DEFAULT 0')
    },
  },
  {
    version: 4,
    description: 'Phase E Task 2 -- immutable per-fill audit log + derived realized P&L',
    up: (db) => {
      db.exec(`
        -- Phase E Task 2 -- immutable per-fill audit log. APPEND ONLY.
        -- One row per actual broker fill. Never UPDATE a row; corrections
        -- are new rows. P&L lives in trader_realized_pnl (derived), never
        -- here. fee_usd is broken out; slippage_usd is computed at write
        -- time as (fill_price - intended_price) * fill_qty * sign(side).
        CREATE TABLE IF NOT EXISTS trader_fills (
          id               TEXT PRIMARY KEY,
          decision_id      TEXT NOT NULL REFERENCES trader_decisions(id),
          client_order_id  TEXT NOT NULL,
          broker_order_id  TEXT,
          asset            TEXT NOT NULL,
          side             TEXT NOT NULL,
          fill_qty         REAL NOT NULL,
          fill_price       REAL NOT NULL,
          intended_price   REAL,
          intended_ts_ms   INTEGER,
          fill_ts_ms       INTEGER NOT NULL,
          fee_usd          REAL NOT NULL DEFAULT 0,
          slippage_usd     REAL NOT NULL DEFAULT 0,
          entry_thesis     TEXT,
          exit_reason      TEXT,
          recorded_at      INTEGER NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_trader_fills_decision
          ON trader_fills(decision_id, fill_ts_ms);

        -- Phase E Task 2 -- derived realized P&L per closed lot. Recomputed
        -- from trader_fills with a recorded lot-matching rule (FIFO in v1).
        -- pnl_net is gross minus the fees attributed to both legs.
        CREATE TABLE IF NOT EXISTS trader_realized_pnl (
          id              TEXT PRIMARY KEY,
          decision_id     TEXT NOT NULL REFERENCES trader_decisions(id),
          asset           TEXT NOT NULL,
          qty             REAL NOT NULL,
          entry_price     REAL NOT NULL,
          exit_price      REAL NOT NULL,
          entry_ts_ms     INTEGER NOT NULL,
          exit_ts_ms      INTEGER NOT NULL,
          fees_usd        REAL NOT NULL,
          pnl_gross       REAL NOT NULL,
          pnl_net         REAL NOT NULL,
          lot_match_rule  TEXT NOT NULL,
          computed_at     INTEGER NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_trader_realized_pnl_decision
          ON trader_realized_pnl(decision_id, exit_ts_ms);
      `)
    },
  },
  {
    version: 5,
    description:
      'Exit rows: parent_decision_id linkage. signal_id must stay a real trader_signals.id (FK is enforced in prod); the old convention of stuffing the entry decision id into signal_id made every exit INSERT throw SQLITE_CONSTRAINT_FOREIGNKEY, so no position ever closed (May-Jun 2026).',
    up: (db) => {
      addColumn(db, 'trader_decisions', 'parent_decision_id', 'TEXT REFERENCES trader_decisions(id)')
      db.exec(`CREATE INDEX IF NOT EXISTS idx_trader_decisions_parent
        ON trader_decisions(parent_decision_id, status)`)
    },
  },
]

if (TRADER_MIGRATIONS.length === 0) {
  throw new Error('TRADER_MIGRATIONS is empty -- at least one migration is required')
}
export const TRADER_SCHEMA_VERSION = Math.max(...TRADER_MIGRATIONS.map((m) => m.version))

/**
 * The column set assertTraderSchema and tests check. Derived from the union of
 * the CREATE TABLE blocks above and the server-sync column lists in
 * server/src/trader-routes/sync.ts. Keep this in lockstep when a migration
 * adds a column that the dashboard sync reads or writes.
 */
export const EXPECTED_TRADER_COLUMNS: Record<string, string[]> = {
  trader_strategies: ['id', 'name', 'asset_class', 'tier', 'status', 'params_json', 'created_at', 'updated_at', 'max_size_usd'],
  trader_signals: ['id', 'strategy_id', 'asset', 'side', 'raw_score', 'horizon_days', 'enrichment_json', 'generated_at', 'status'],
  trader_decisions: ['id', 'signal_id', 'action', 'asset', 'size_usd', 'entry_type', 'entry_price', 'stop_loss', 'take_profit', 'thesis', 'confidence', 'committee_transcript_id', 'decided_at', 'status', 'engine_order_id', 'submit_attempts', 'next_retry_at', 'filled_qty', 'filled_avg_price', 'parent_decision_id'],
  trader_committee_transcripts: ['id', 'signal_id', 'transcript_json', 'rounds', 'total_tokens', 'total_cost_usd', 'created_at'],
  trader_approvals: ['id', 'decision_id', 'sent_at', 'responded_at', 'response', 'override_size'],
  trader_verdicts: ['id', 'decision_id', 'pnl_gross', 'pnl_net', 'bench_return', 'hold_drawdown', 'thesis_grade', 'agent_attribution_json', 'embedding_id', 'closed_at', 'returns_backfilled'],
  trader_strategy_track_record: ['strategy_id', 'trade_count', 'win_count', 'rolling_sharpe', 'avg_winner_pct', 'avg_loser_pct', 'max_dd_pct', 'net_pnl_usd', 'computed_at'],
  trader_circuit_breakers: ['id', 'rule', 'tripped_at', 'reason', 'cleared_at', 'cleared_by'],
  trader_pnl_snapshots: ['date', 'nav_open', 'nav_close', 'pnl_day', 'trades_count', 'bench_return', 'cumulative_pnl', 'open_unrealized_pnl', 'account_nav'],
  trader_signal_suppressions: ['id', 'signal_id', 'strategy_id', 'asset', 'side', 'reason', 'raw_score', 'enrichment_fingerprint', 'suppressed_at'],
  trader_reasoning_bank: ['id', 'decision_id', 'signal_id', 'asset', 'side', 'strategy', 'summary', 'thesis_grade', 'outcome', 'pnl_net', 'embedding_id', 'created_at'],
  trader_alert_state: ['alert_id', 'last_alerted_at'],
  trader_fills: ['id', 'decision_id', 'client_order_id', 'broker_order_id', 'asset', 'side', 'fill_qty', 'fill_price', 'intended_price', 'intended_ts_ms', 'fill_ts_ms', 'fee_usd', 'slippage_usd', 'entry_thesis', 'exit_reason', 'recorded_at'],
  trader_realized_pnl: ['id', 'decision_id', 'asset', 'qty', 'entry_price', 'exit_price', 'entry_ts_ms', 'exit_ts_ms', 'fees_usd', 'pnl_gross', 'pnl_net', 'lot_match_rule', 'computed_at'],
}

/**
 * Create the trader_schema_version table if it does not exist. Called only
 * from applyTraderSchema so the table is never created as a read side effect.
 */
function ensureVersionTable(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS trader_schema_version (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    version INTEGER NOT NULL
  )`)
}

/**
 * Return the current trader schema version, or 0 if the version table does not
 * exist. Pure read: never creates or modifies any table.
 */
export function getTraderSchemaVersion(db: Database.Database): number {
  const tableExists = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='trader_schema_version'")
    .get()
  if (!tableExists) return 0
  const row = db.prepare('SELECT version FROM trader_schema_version WHERE id = 1').get() as
    | { version: number }
    | undefined
  return row?.version ?? 0
}

function setTraderSchemaVersion(db: Database.Database, version: number): void {
  db.prepare(`
    INSERT INTO trader_schema_version (id, version) VALUES (1, ?)
    ON CONFLICT(id) DO UPDATE SET version = excluded.version
  `).run(version)
}

/**
 * Apply every pending trader migration in order, each in its own transaction,
 * stamping trader_schema_version after each. Idempotent: a DB already at the
 * head version does nothing. Throws (does not swallow) on a real migration
 * error so boot fails loudly rather than running on a half-built schema.
 */
export function applyTraderSchema(db: Database.Database): void {
  ensureVersionTable(db)
  const current = getTraderSchemaVersion(db)
  const pending = TRADER_MIGRATIONS.filter((m) => m.version > current)
  for (const m of pending) {
    const apply = db.transaction(() => {
      m.up(db)
      setTraderSchemaVersion(db, m.version)
    })
    apply()
  }
}

export class TraderSchemaError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TraderSchemaError'
  }
}

/**
 * Hard-assert the trader schema is at head version and every expected column
 * exists. Throws TraderSchemaError listing the first missing table/column or a
 * version mismatch. Call this at boot AFTER applyTraderSchema and BEFORE the
 * scheduler is allowed to tick, so a drifted DB fails loudly instead of arming
 * the engine_order_id re-dispatch loop.
 */
export function assertTraderSchema(db: Database.Database): void {
  const version = getTraderSchemaVersion(db)
  if (version !== TRADER_SCHEMA_VERSION) {
    throw new TraderSchemaError(
      `trader schema version mismatch: db=${version} expected=${TRADER_SCHEMA_VERSION}. ` +
        `Run applyTraderSchema before the scheduler starts.`,
    )
  }

  const missing: string[] = []
  for (const [table, cols] of Object.entries(EXPECTED_TRADER_COLUMNS)) {
    const info = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
    if (info.length === 0) {
      missing.push(`${table} (table missing)`)
      continue
    }
    const present = new Set(info.map((c) => c.name))
    for (const col of cols) {
      if (!present.has(col)) missing.push(`${table}.${col}`)
    }
  }

  if (missing.length > 0) {
    throw new TraderSchemaError(
      `trader schema is missing required columns: ${missing.join(', ')}. ` +
        `Re-run applyTraderSchema or check for a stale DB file.`,
    )
  }
}
