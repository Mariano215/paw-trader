import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Database from "better-sqlite3";
import { initTraderTables } from "./db.js";

describe("trader DB tables", () => {
  let db: Database.Database;

  beforeAll(() => {
    db = new Database(":memory:");
    initTraderTables(db);
  });

  afterAll(() => db.close());

  const expectedTables = [
    "trader_strategies",
    "trader_signals",
    "trader_decisions",
    "trader_committee_transcripts",
    "trader_approvals",
    "trader_verdicts",
    "trader_strategy_track_record",
    "trader_circuit_breakers",
    "trader_pnl_snapshots",
  ];

  it.each(expectedTables)("table %s exists", (table) => {
    const row = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
      .get(table);
    expect(row).toBeTruthy();
  });

  it("idx_signals_status index exists", () => {
    const idx = db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_signals_status'")
      .get();
    expect(idx).toBeTruthy();
  });

  it("trader_strategies insert round-trips", () => {
    const now = Date.now();
    db.prepare(
      "INSERT INTO trader_strategies (id, name, asset_class, tier, status, params_json, created_at, updated_at) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    ).run("momentum", "Momentum", "stocks", 0, "active", "{}", now, now);

    const row = db
      .prepare("SELECT * FROM trader_strategies WHERE id = ?")
      .get("momentum") as { tier: number };
    expect(row).toBeTruthy();
    expect(row.tier).toBe(0);
  });

  it("all timestamps stored as integers (ms epoch)", () => {
    const row = db
      .prepare("SELECT created_at FROM trader_strategies WHERE id = 'momentum'")
      .get() as { created_at: number };
    expect(row.created_at).toBeGreaterThan(1_700_000_000_000);
  });

  // Phase 5 Task 1 -- per-strategy live cap. max_size_usd column carries
  // a hard ceiling that overrides autonomy ladder + committee output.
  // NULL means "use the default NAV-based cap". Migration must be
  // idempotent because initTraderTables runs every boot.
  it('adds max_size_usd column on re-run without erroring', () => {
    const db = new Database(':memory:')
    initTraderTables(db)
    initTraderTables(db)  // idempotent
    const cols = db.prepare("PRAGMA table_info(trader_strategies)").all() as any[]
    const col = cols.find((c) => c.name === 'max_size_usd')
    expect(col).toBeDefined()
    expect(col.type).toBe('REAL')
  })

  // Phase 5 Task 2 -- monitor alert state table. Holds one row per
  // alert_id with the last_alerted_at timestamp (ms) for dedup.
  // Overloaded for the per-strategy sharpe flip alert where the
  // last_alerted_at column stores a sign marker (+1 / -1) instead of
  // a timestamp. See monitor.ts for the quirk explanation.
  it('creates trader_alert_state table with alert_id + last_alerted_at columns', () => {
    const db = new Database(':memory:')
    initTraderTables(db)

    const tableRow = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='trader_alert_state'")
      .get()
    expect(tableRow).toBeTruthy()

    const cols = db.prepare("PRAGMA table_info(trader_alert_state)").all() as any[]
    const colNames = cols.map(c => c.name).sort()
    expect(colNames).toEqual(['alert_id', 'last_alerted_at'])
    const alertIdCol = cols.find(c => c.name === 'alert_id')
    expect(alertIdCol.pk).toBe(1)
  })

  // trader_approvals FK must point at trader_signals(id), NOT
  // trader_decisions(id). The column is historically named decision_id
  // but stores a signal id (approval cards are raised BEFORE the
  // committee produces a decision, so no trader_decisions row exists
  // when createPendingApproval runs). Trader unit tests disable FK
  // enforcement, so a wrong FK would pass every test and still fail
  // every production insert because src/db.ts enables FKs globally.
  it('trader_approvals.decision_id references trader_signals, not trader_decisions', () => {
    const db = new Database(':memory:')
    initTraderTables(db)
    const fks = db.prepare('PRAGMA foreign_key_list(trader_approvals)').all() as any[]
    const decisionFk = fks.find(r => r.from === 'decision_id')
    expect(decisionFk).toBeDefined()
    expect(decisionFk.table).toBe('trader_signals')
    expect(decisionFk.to).toBe('id')
  })

  it('migrates a legacy trader_approvals FK from trader_decisions to trader_signals', () => {
    const db = new Database(':memory:')
    // Simulate the pre-fix schema by hand: create the dependency tables,
    // then the legacy trader_approvals with the wrong FK, and seed a
    // realistic row (FKs OFF so the seed itself is not rejected).
    db.pragma('foreign_keys = OFF')
    db.exec(`
      CREATE TABLE trader_strategies (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, asset_class TEXT NOT NULL,
        tier INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'active',
        params_json TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE TABLE trader_signals (
        id TEXT PRIMARY KEY, strategy_id TEXT NOT NULL REFERENCES trader_strategies(id),
        asset TEXT NOT NULL, side TEXT NOT NULL, raw_score REAL NOT NULL,
        horizon_days INTEGER NOT NULL, enrichment_json TEXT,
        generated_at INTEGER NOT NULL, status TEXT NOT NULL
      );
      CREATE TABLE trader_decisions (
        id TEXT PRIMARY KEY, signal_id TEXT NOT NULL REFERENCES trader_signals(id),
        action TEXT NOT NULL, asset TEXT NOT NULL, size_usd REAL,
        entry_type TEXT, entry_price REAL, stop_loss REAL, take_profit REAL,
        thesis TEXT NOT NULL, confidence REAL NOT NULL,
        committee_transcript_id TEXT, decided_at INTEGER NOT NULL, status TEXT NOT NULL
      );
      -- Legacy wrong FK: points at trader_decisions(id).
      CREATE TABLE trader_approvals (
        id TEXT PRIMARY KEY,
        decision_id TEXT NOT NULL REFERENCES trader_decisions(id),
        sent_at INTEGER NOT NULL, responded_at INTEGER, response TEXT,
        override_size REAL
      );
      INSERT INTO trader_approvals (id, decision_id, sent_at) VALUES ('apx-1', 'sig-1', 1776000000000);
    `)

    // initTraderTables runs the migration. It should swap the FK without
    // losing the seeded row.
    initTraderTables(db)

    const fks = db.prepare('PRAGMA foreign_key_list(trader_approvals)').all() as any[]
    const decisionFk = fks.find(r => r.from === 'decision_id')
    expect(decisionFk.table).toBe('trader_signals')

    const row = db.prepare('SELECT id, decision_id, sent_at FROM trader_approvals WHERE id=?').get('apx-1') as any
    expect(row).toBeTruthy()
    expect(row.decision_id).toBe('sig-1')
    expect(row.sent_at).toBe(1776000000000)
  })

  it('rejects inserting two pending signals for the same asset+side', () => {
    const testDb = new Database(':memory:')
    initTraderTables(testDb)

    // Insert a strategy first (required by FK)
    testDb.prepare(
      'INSERT INTO trader_strategies (id, name, asset_class, tier, status, params_json, created_at, updated_at) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).run('momentum-stocks', 'Momentum', 'stocks', 0, 'active', '{}', Date.now(), Date.now())

    const insert = testDb.prepare(`
      INSERT INTO trader_signals (id, strategy_id, asset, side, raw_score, horizon_days, generated_at, status)
      VALUES (?, 'momentum-stocks', 'MSFT', 'buy', 0.8, 3, ?, 'pending')
    `)
    insert.run('idx-sig-1', Date.now())
    expect(() => insert.run('idx-sig-2', Date.now())).toThrow()
  })
});
