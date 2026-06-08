import { describe, it, expect } from 'vitest'
import Database from 'better-sqlite3'
import {
  TRADER_SCHEMA_VERSION,
  TRADER_MIGRATIONS,
  applyTraderSchema,
  getTraderSchemaVersion,
  EXPECTED_TRADER_COLUMNS,
  assertTraderSchema,
  TraderSchemaError,
} from './schema.js'

function freshDb(): Database.Database {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  return db
}

describe('trader schema migration', () => {
  it('migration versions are strictly increasing and start at 1', () => {
    const versions = TRADER_MIGRATIONS.map((m) => m.version)
    expect(versions[0]).toBe(1)
    for (let i = 1; i < versions.length; i++) {
      expect(versions[i]).toBe(versions[i - 1] + 1)
    }
  })

  it('TRADER_SCHEMA_VERSION equals the highest migration version', () => {
    const max = Math.max(...TRADER_MIGRATIONS.map((m) => m.version))
    expect(TRADER_SCHEMA_VERSION).toBe(max)
  })

  it('applyTraderSchema stamps the schema version', () => {
    const db = freshDb()
    expect(getTraderSchemaVersion(db)).toBe(0)
    applyTraderSchema(db)
    expect(getTraderSchemaVersion(db)).toBe(TRADER_SCHEMA_VERSION)
  })

  it('getTraderSchemaVersion is read-only: does NOT create trader_schema_version on a bare DB', () => {
    const db = freshDb()
    // Must return 0 without creating the table.
    expect(getTraderSchemaVersion(db)).toBe(0)
    const tableRow = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='trader_schema_version'")
      .get()
    expect(tableRow).toBeUndefined()
  })

  it('assertTraderSchema on a never-initialized DB does not leave a half-created version table', () => {
    const db = new Database(':memory:')
    // assertTraderSchema should throw (schema missing), but must NOT leave
    // trader_schema_version behind as a partial side effect.
    expect(() => assertTraderSchema(db)).toThrow(TraderSchemaError)
    const tableRow = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='trader_schema_version'")
      .get()
    expect(tableRow).toBeUndefined()
  })

  it('applyTraderSchema is idempotent (second run is a no-op, no throw)', () => {
    const db = freshDb()
    applyTraderSchema(db)
    expect(() => applyTraderSchema(db)).not.toThrow()
    expect(getTraderSchemaVersion(db)).toBe(TRADER_SCHEMA_VERSION)
  })

  it('creates every expected column on every expected table', () => {
    const db = freshDb()
    applyTraderSchema(db)
    for (const [table, cols] of Object.entries(EXPECTED_TRADER_COLUMNS)) {
      const present = (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>)
        .map((c) => c.name)
      for (const col of cols) {
        expect(present, `${table}.${col} must exist`).toContain(col)
      }
    }
  })

  it('engine_order_id exists on trader_decisions (the column that broke the dispatch loop)', () => {
    const db = freshDb()
    applyTraderSchema(db)
    const cols = (db.prepare(`PRAGMA table_info(trader_decisions)`).all() as Array<{ name: string }>)
      .map((c) => c.name)
    expect(cols).toContain('engine_order_id')
  })

  it('upgrades a legacy DB built with addColumnIfMissing gaps (engine_order_id missing)', () => {
    const db = freshDb()
    db.pragma('foreign_keys = OFF')
    // Simulate the exact pre-fix shape: trader_decisions WITHOUT engine_order_id,
    // and no trader_schema_version table.
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
    `)
    db.pragma('foreign_keys = ON')

    applyTraderSchema(db)

    const cols = (db.prepare(`PRAGMA table_info(trader_decisions)`).all() as Array<{ name: string }>)
      .map((c) => c.name)
    expect(cols).toContain('engine_order_id')
    expect(getTraderSchemaVersion(db)).toBe(TRADER_SCHEMA_VERSION)
  })

  it('EXPECTED_TRADER_COLUMNS covers trader_signal_suppressions', () => {
    expect(EXPECTED_TRADER_COLUMNS).toHaveProperty('trader_signal_suppressions')
    const cols = EXPECTED_TRADER_COLUMNS.trader_signal_suppressions
    expect(cols).toContain('id')
    expect(cols).toContain('strategy_id')
    expect(cols).toContain('asset')
    expect(cols).toContain('side')
    expect(cols).toContain('reason')
    expect(cols).toContain('raw_score')
    expect(cols).toContain('suppressed_at')
  })

  it('EXPECTED_TRADER_COLUMNS covers trader_reasoning_bank', () => {
    expect(EXPECTED_TRADER_COLUMNS).toHaveProperty('trader_reasoning_bank')
    const cols = EXPECTED_TRADER_COLUMNS.trader_reasoning_bank
    expect(cols).toContain('id')
    expect(cols).toContain('asset')
    expect(cols).toContain('side')
    expect(cols).toContain('strategy')
    expect(cols).toContain('summary')
    expect(cols).toContain('created_at')
  })
})

describe('assertTraderSchema', () => {
  it('passes on a fully migrated DB', () => {
    const db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    applyTraderSchema(db)
    expect(() => assertTraderSchema(db)).not.toThrow()
  })

  it('throws TraderSchemaError when a required column is missing', () => {
    const db = new Database(':memory:')
    db.pragma('foreign_keys = OFF')
    // Build trader_decisions WITHOUT engine_order_id, stamp the head version
    // to simulate a drifted DB that "thinks" it is current (schema drift).
    // The version must match TRADER_SCHEMA_VERSION so the version check passes
    // and the column assertion fires.
    db.exec(`
      CREATE TABLE trader_strategies (id TEXT PRIMARY KEY, name TEXT NOT NULL, asset_class TEXT NOT NULL,
        tier INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'active', params_json TEXT NOT NULL,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE trader_signals (id TEXT PRIMARY KEY, strategy_id TEXT NOT NULL, asset TEXT NOT NULL,
        side TEXT NOT NULL, raw_score REAL NOT NULL, horizon_days INTEGER NOT NULL, enrichment_json TEXT,
        generated_at INTEGER NOT NULL, status TEXT NOT NULL);
      CREATE TABLE trader_decisions (id TEXT PRIMARY KEY, signal_id TEXT NOT NULL, action TEXT NOT NULL,
        asset TEXT NOT NULL, size_usd REAL, entry_type TEXT, entry_price REAL, stop_loss REAL,
        take_profit REAL, thesis TEXT NOT NULL, confidence REAL NOT NULL, committee_transcript_id TEXT,
        decided_at INTEGER NOT NULL, status TEXT NOT NULL);
      CREATE TABLE trader_schema_version (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL);
    `)
    db.prepare('INSERT INTO trader_schema_version (id, version) VALUES (1, ?)').run(TRADER_SCHEMA_VERSION)
    expect(() => assertTraderSchema(db)).toThrow(TraderSchemaError)
    try {
      assertTraderSchema(db)
    } catch (err) {
      expect((err as Error).message).toContain('trader_decisions.engine_order_id')
    }
  })

  it('throws when the version stamp is behind head', () => {
    const db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    applyTraderSchema(db)
    db.prepare('UPDATE trader_schema_version SET version = 0 WHERE id = 1').run()
    expect(() => assertTraderSchema(db)).toThrow(TraderSchemaError)
  })
})
