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
});
