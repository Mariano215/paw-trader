/**
 * trader-routes.test.ts
 *
 * Permission and response-shape tests for the Phase 2 Task 8 trader routes:
 *   GET /api/v1/trader/decisions
 *   GET /api/v1/trader/decisions/:id/transcript
 *
 * The engine-fronted routes (status/positions/orders/risk/halt) are not
 * exercised here -- they are thin proxies already covered by live-engine
 * smoke tests. This file focuses on the new DB-backed endpoints that read
 * trader_decisions and trader_committee_transcripts from the bot DB.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import express from 'express'
import { createServer } from 'node:http'
import { request as nodeRequest } from 'node:http'
import type { IncomingMessage } from 'node:http'
import {
  initUserStore,
  createUser,
  createUserToken,
} from './users.js'
import { authenticate, scopeProjects } from './auth.js'

const wsMock = vi.hoisted(() => ({
  broadcastToMac: vi.fn(),
  isBotConnected: vi.fn(() => true),
}))

// ---------------------------------------------------------------------------
// In-memory DB used by both the users module and the mocked db.js module
// ---------------------------------------------------------------------------

let testDb: Database.Database
let botDbAvailable = true

function makeSchema(db: Database.Database) {
  db.prepare(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      global_role TEXT NOT NULL DEFAULT 'member' CHECK(global_role IN ('admin','member','bot')),
      created_at INTEGER NOT NULL,
      last_seen_at INTEGER
    )
  `).run()
  db.prepare(`
    CREATE TABLE IF NOT EXISTS user_tokens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token_hash TEXT NOT NULL UNIQUE,
      label TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL,
      last_used_at INTEGER,
      revoked_at INTEGER
    )
  `).run()
  db.prepare(`
    CREATE TABLE IF NOT EXISTS project_members (
      project_id TEXT NOT NULL,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role TEXT NOT NULL CHECK(role IN ('owner','editor','viewer')),
      granted_by_user_id INTEGER,
      granted_at INTEGER NOT NULL,
      PRIMARY KEY (project_id, user_id)
    )
  `).run()
  db.prepare(`
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL DEFAULT '',
      slug TEXT NOT NULL DEFAULT '',
      display_name TEXT NOT NULL DEFAULT '',
      icon TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      auto_archive_days INTEGER,
      created_at INTEGER NOT NULL DEFAULT 0
    )
  `).run()
  // Trader-side tables -- the bot DB owns these in production; we mirror
  // the shape here so the route SQL runs against a real schema.
  db.prepare(`
    CREATE TABLE IF NOT EXISTS trader_decisions (
      id                      TEXT PRIMARY KEY,
      signal_id               TEXT NOT NULL,
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
    )
  `).run()
  db.prepare(`
    CREATE TABLE IF NOT EXISTS trader_committee_transcripts (
      id              TEXT PRIMARY KEY,
      signal_id       TEXT NOT NULL,
      transcript_json TEXT NOT NULL,
      rounds          INTEGER NOT NULL,
      total_tokens    INTEGER NOT NULL,
      total_cost_usd  REAL NOT NULL,
      created_at      INTEGER NOT NULL
    )
  `).run()
  db.prepare(`
    CREATE TABLE IF NOT EXISTS trader_strategy_track_record (
      strategy_id    TEXT PRIMARY KEY,
      trade_count    INTEGER NOT NULL,
      win_count      INTEGER NOT NULL,
      rolling_sharpe REAL NOT NULL,
      avg_winner_pct REAL NOT NULL,
      avg_loser_pct  REAL NOT NULL,
      max_dd_pct     REAL NOT NULL,
      net_pnl_usd    REAL NOT NULL,
      computed_at    INTEGER NOT NULL
    )
  `).run()
  // Phase 4 Task D -- strategies + signals + verdicts for drill-down routes.
  db.prepare(`
    CREATE TABLE IF NOT EXISTS trader_strategies (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      asset_class TEXT NOT NULL,
      tier        INTEGER NOT NULL DEFAULT 0,
      status      TEXT NOT NULL DEFAULT 'active',
      params_json TEXT NOT NULL,
      created_at  INTEGER NOT NULL,
      updated_at  INTEGER NOT NULL
    )
  `).run()
  db.prepare(`
    CREATE TABLE IF NOT EXISTS trader_signals (
      id              TEXT PRIMARY KEY,
      strategy_id     TEXT NOT NULL,
      asset           TEXT NOT NULL,
      side            TEXT NOT NULL,
      raw_score       REAL NOT NULL,
      horizon_days    INTEGER NOT NULL,
      enrichment_json TEXT,
      generated_at    INTEGER NOT NULL,
      status          TEXT NOT NULL
    )
  `).run()
  db.prepare(`
    CREATE TABLE IF NOT EXISTS trader_approvals (
      id            TEXT PRIMARY KEY,
      decision_id   TEXT NOT NULL,
      sent_at       INTEGER NOT NULL,
      responded_at  INTEGER,
      response      TEXT,
      override_size REAL
    )
  `).run()
  db.prepare(`
    CREATE TABLE IF NOT EXISTS trader_verdicts (
      id                     TEXT PRIMARY KEY,
      decision_id            TEXT NOT NULL,
      pnl_gross              REAL NOT NULL,
      pnl_net                REAL NOT NULL,
      bench_return           REAL NOT NULL,
      hold_drawdown          REAL NOT NULL,
      thesis_grade           TEXT NOT NULL,
      agent_attribution_json TEXT NOT NULL,
      embedding_id           TEXT,
      closed_at              INTEGER NOT NULL,
      returns_backfilled     INTEGER NOT NULL DEFAULT 0
    )
  `).run()
  // Phase 5 Task 3 -- kill-switch log for the read endpoint test.
  db.prepare(`
    CREATE TABLE IF NOT EXISTS kill_switch_log (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      toggled_at_ms  INTEGER NOT NULL,
      new_state      TEXT NOT NULL CHECK (new_state IN ('tripped', 'active')),
      reason         TEXT,
      set_by         TEXT
    )
  `).run()
}

// ---------------------------------------------------------------------------
// Mock db.js so getBotDb returns our in-memory DB (or null when we want
// to simulate bot DB unavailability).
// ---------------------------------------------------------------------------

vi.mock('./db.js', async () => {
  const getTestDb = () => testDb
  return {
    getDb: vi.fn(() => getTestDb()),
    getBotDb: vi.fn(() => (botDbAvailable ? getTestDb() : null)),
    getBotDbWrite: vi.fn(() => getTestDb()),
    getServerDb: vi.fn(() => getTestDb()),
    getTelemetryDb: vi.fn(() => null),
    credDecryptForVerify: vi.fn(() => null),
    // Minimal stubs needed by auth.ts transitively -- none of these are hit
    // by the trader-routes tests, but the module surface must resolve.
    getAllAgents: vi.fn(() => []),
    getAgent: vi.fn(() => null),
    updateAgentStatus: vi.fn(),
    upsertAgent: vi.fn(),
    deleteAgent: vi.fn(),
    sendMessage: vi.fn(),
    getMessagesForAgent: vi.fn(() => []),
    markDelivered: vi.fn(),
    markCompleted: vi.fn(),
    getRecentMessages: vi.fn(() => []),
    addFeedItem: vi.fn(),
    getRecentFeed: vi.fn(() => []),
  }
})

vi.mock('./ws.js', async () => ({
  broadcastToMac: wsMock.broadcastToMac,
  isBotConnected: wsMock.isBotConnected,
}))

// ---------------------------------------------------------------------------
// Import routes after mocks
// ---------------------------------------------------------------------------

const { default: traderRoutes } = await import('./trader-routes/index.js')

// ---------------------------------------------------------------------------
// App factory and HTTP helpers (same pattern as cost-gate-routes.test.ts)
// ---------------------------------------------------------------------------

function makeApp(): express.Express {
  const app = express()
  app.use(express.json())
  app.use('/api/v1', (req, res, next) => authenticate(req, res, next))
  app.use('/api/v1', (req, res, next) => scopeProjects(req, res, next))
  // trader-routes declares full paths starting with /api/v1/, so mount at root
  app.use(traderRoutes)
  return app
}

type ServerHandle = { server: ReturnType<typeof createServer>; stop: () => Promise<void> }

function startServer(app: express.Express): Promise<ServerHandle> {
  return new Promise((resolve, reject) => {
    const s = createServer(app)
    s.listen(0, '127.0.0.1', () => {
      resolve({ server: s, stop: () => new Promise(res => s.close(() => res())) })
    })
    s.on('error', reject)
  })
}

type ReqResult = { status: number; body: unknown }

function httpReq(
  server: ReturnType<typeof createServer>,
  method: string,
  path: string,
  opts: { headers?: Record<string, string>; body?: unknown } = {},
): Promise<ReqResult> {
  const addr = server.address() as { port: number }
  return new Promise((resolve, reject) => {
    const bodyStr = opts.body !== undefined ? JSON.stringify(opts.body) : undefined
    const headers: Record<string, string> = { 'Content-Type': 'application/json', ...opts.headers }
    if (bodyStr !== undefined) headers['Content-Length'] = String(Buffer.byteLength(bodyStr))
    const r = nodeRequest(
      { hostname: '127.0.0.1', port: addr.port, path, method, headers },
      (res: IncomingMessage) => {
        let raw = ''
        res.on('data', (c: Buffer) => { raw += c.toString() })
        res.on('end', () => {
          try { resolve({ status: res.statusCode ?? 0, body: JSON.parse(raw) }) }
          catch { resolve({ status: res.statusCode ?? 0, body: raw }) }
        })
      },
    )
    r.on('error', reject)
    if (bodyStr !== undefined) r.write(bodyStr)
    r.end()
  })
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let srv: ReturnType<typeof createServer>
let adminToken: string
let memberToken: string

const DECISION_WITH_TRANSCRIPT = 'dec-with-transcript'
const DECISION_NO_TRANSCRIPT = 'dec-no-transcript'
const TRANSCRIPT_ID = 'tr-test-1'

const SAMPLE_TRANSCRIPT = {
  signal_id: 'sig-1',
  started_at: 1_700_000_000_000,
  finished_at: 1_700_000_015_000,
  rounds_executed: 2,
  round_1: [
    { role: 'quant', opinion: 'strong breakout', confidence: 0.72, concerns: [] },
    { role: 'fundamentalist', opinion: 'earnings solid', confidence: 0.66, concerns: ['valuation'] },
  ],
  coordinator: {
    role: 'coordinator',
    consensus_direction: 'buy',
    avg_confidence: 0.69,
    skip_round_2: false,
    challenges: [],
  },
  round_2: [
    { role: 'quant', response: 'still long', updated_confidence: 0.74 },
  ],
  risk_officer: { role: 'risk_officer', veto: false, reason: 'sized under cap', concerns: [] },
  trader: { role: 'trader', action: 'buy', thesis: 'breakout with good risk', confidence: 0.7, size_multiplier: 1 },
  errors: [],
}

beforeAll(async () => {
  testDb = new Database(':memory:')
  testDb.pragma('journal_mode = WAL')
  makeSchema(testDb)

  initUserStore(testDb)

  const admin = createUser({ email: 'admin@trader.test', name: 'Admin', global_role: 'admin' })
  adminToken = createUserToken({ user_id: admin.id }).token

  const member = createUser({ email: 'member@trader.test', name: 'Member', global_role: 'member' })
  memberToken = createUserToken({ user_id: member.id }).token

  // Seed one transcript and two decisions (one linked, one unlinked)
  testDb.prepare(`
    INSERT INTO trader_committee_transcripts
      (id, signal_id, transcript_json, rounds, total_tokens, total_cost_usd, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    TRANSCRIPT_ID,
    'sig-1',
    JSON.stringify(SAMPLE_TRANSCRIPT),
    2,
    1200,
    0.04,
    1_700_000_020_000,
  )

  testDb.prepare(`
    INSERT INTO trader_decisions
      (id, signal_id, action, asset, size_usd, entry_type, thesis, confidence,
       committee_transcript_id, decided_at, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    DECISION_WITH_TRANSCRIPT, 'sig-1', 'buy', 'AAPL', 150, 'market',
    'breakout approval', 0.7, TRANSCRIPT_ID, 1_700_000_020_000, 'executed',
  )

  testDb.prepare(`
    INSERT INTO trader_decisions
      (id, signal_id, action, asset, size_usd, entry_type, thesis, confidence,
       committee_transcript_id, decided_at, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    DECISION_NO_TRANSCRIPT, 'sig-2', 'buy', 'MSFT', 0, null,
    'abstained before transcript wired', 0, null, 1_700_000_010_000, 'abstain',
  )

  const app = makeApp()
  ;({ server: srv } = await startServer(app))
}, 30000)

function tok(t: string): Record<string, string> {
  return { 'x-dashboard-token': t }
}

beforeEach(() => {
  wsMock.broadcastToMac.mockClear()
  wsMock.isBotConnected.mockReset()
  wsMock.isBotConnected.mockReturnValue(true)
})

// ===========================================================================
// Tests
// ===========================================================================

// Phase 5 Task 2c -- /api/v1/trader/status passes coinbase_connected through
// from the engine /health body. Stubs global fetch to simulate the engine
// response so we can exercise the proxy without a live engine.
describe('GET /api/v1/trader/status (Phase 5 Task 2c coinbase pass-through)', () => {
  const ORIGINAL_FETCH = globalThis.fetch
  const ORIGINAL_URL = process.env.TRADER_ENGINE_URL
  const ORIGINAL_TOKEN = process.env.TRADER_ENGINE_TOKEN

  beforeAll(() => {
    process.env.TRADER_ENGINE_URL = 'http://127.0.0.1:9999'
    process.env.TRADER_ENGINE_TOKEN = 'fake-engine-token'
  })

  afterAll(() => {
    globalThis.fetch = ORIGINAL_FETCH
    if (ORIGINAL_URL === undefined) delete process.env.TRADER_ENGINE_URL
    else process.env.TRADER_ENGINE_URL = ORIGINAL_URL
    if (ORIGINAL_TOKEN === undefined) delete process.env.TRADER_ENGINE_TOKEN
    else process.env.TRADER_ENGINE_TOKEN = ORIGINAL_TOKEN
  })

  it('forwards coinbase_connected from the engine /health response', async () => {
    globalThis.fetch = vi.fn(async (url: string | URL | Request) => {
      const href = typeof url === 'string' ? url : url instanceof URL ? url.href : String(url)
      if (href.endsWith('/health')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            status: 'ok',
            version: '0.1.0',
            alpaca_connected: true,
            alpaca_mode: 'paper',
            reconciler_halted: false,
            halt_reason: null,
            coinbase_connected: true,
          }),
        } as unknown as Response
      }
      // /reconcile/last allowed to fail quietly
      return { ok: false, status: 404, json: async () => ({}) } as unknown as Response
    }) as typeof fetch

    const res = await httpReq(srv, 'GET', '/api/v1/trader/status', { headers: tok(adminToken) })
    expect(res.status).toBe(200)
    const body = res.body as {
      engine_connected: boolean
      alpaca_connected: boolean
      coinbase_connected: boolean | null
    }
    expect(body.engine_connected).toBe(true)
    expect(body.alpaca_connected).toBe(true)
    expect(body.coinbase_connected).toBe(true)
  })
})

describe('GET /api/v1/trader/decisions', () => {
  it('returns the seeded decisions newest-first', async () => {
    const res = await httpReq(srv, 'GET', '/api/v1/trader/decisions', { headers: tok(adminToken) })
    expect(res.status).toBe(200)
    const body = res.body as { decisions: Array<{ id: string; decided_at: number }> }
    expect(Array.isArray(body.decisions)).toBe(true)
    expect(body.decisions.length).toBe(2)
    // DECISION_WITH_TRANSCRIPT has the newer decided_at; must be first
    expect(body.decisions[0].id).toBe(DECISION_WITH_TRANSCRIPT)
    expect(body.decisions[1].id).toBe(DECISION_NO_TRANSCRIPT)
  })

  it('honours the limit query parameter', async () => {
    const res = await httpReq(srv, 'GET', '/api/v1/trader/decisions?limit=1', { headers: tok(adminToken) })
    expect(res.status).toBe(200)
    const body = res.body as { decisions: unknown[] }
    expect(body.decisions.length).toBe(1)
  })

  it('rejects unauthenticated callers with 401', async () => {
    const res = await httpReq(srv, 'GET', '/api/v1/trader/decisions')
    expect(res.status).toBe(401)
  })
})

describe('GET /api/v1/trader/decisions/:id/transcript', () => {
  it('returns the parsed transcript and decision for a linked decision', async () => {
    const res = await httpReq(
      srv, 'GET', `/api/v1/trader/decisions/${DECISION_WITH_TRANSCRIPT}/transcript`,
      { headers: tok(adminToken) },
    )
    expect(res.status).toBe(200)
    const body = res.body as {
      decision: { id: string; action: string; asset: string; committee_transcript_id: string }
      transcript: { id: string; rounds: number; total_tokens: number; body: typeof SAMPLE_TRANSCRIPT }
    }
    expect(body.decision.id).toBe(DECISION_WITH_TRANSCRIPT)
    expect(body.decision.asset).toBe('AAPL')
    expect(body.decision.committee_transcript_id).toBe(TRANSCRIPT_ID)
    expect(body.transcript.id).toBe(TRANSCRIPT_ID)
    expect(body.transcript.rounds).toBe(2)
    expect(body.transcript.total_tokens).toBe(1200)
    expect(body.transcript.body.round_1.length).toBe(2)
    expect(body.transcript.body.trader.action).toBe('buy')
  })

  it('returns 404 for an unknown decision id', async () => {
    const res = await httpReq(
      srv, 'GET', '/api/v1/trader/decisions/does-not-exist/transcript',
      { headers: tok(adminToken) },
    )
    expect(res.status).toBe(404)
  })

  it('returns 404 when the decision exists but has no linked transcript', async () => {
    const res = await httpReq(
      srv, 'GET', `/api/v1/trader/decisions/${DECISION_NO_TRANSCRIPT}/transcript`,
      { headers: tok(adminToken) },
    )
    expect(res.status).toBe(404)
  })

  it('returns 503 when the bot DB is unavailable', async () => {
    botDbAvailable = false
    try {
      const res = await httpReq(
        srv, 'GET', `/api/v1/trader/decisions/${DECISION_WITH_TRANSCRIPT}/transcript`,
        { headers: tok(adminToken) },
      )
      expect(res.status).toBe(503)
    } finally {
      botDbAvailable = true
    }
  })
})

describe('GET /api/v1/trader/track-records', () => {
  it('returns an empty list when no records have been computed', async () => {
    testDb.prepare('DELETE FROM trader_strategy_track_record').run()
    const res = await httpReq(srv, 'GET', '/api/v1/trader/track-records', { headers: tok(adminToken) })
    expect(res.status).toBe(200)
    const body = res.body as { track_records: unknown[] }
    expect(body.track_records).toEqual([])
  })

  it('returns seeded records ordered by strategy_id', async () => {
    testDb.prepare('DELETE FROM trader_strategy_track_record').run()
    testDb.prepare(`
      INSERT INTO trader_strategy_track_record
        (strategy_id, trade_count, win_count, rolling_sharpe, avg_winner_pct,
         avg_loser_pct, max_dd_pct, net_pnl_usd, computed_at)
      VALUES
        ('momentum-stocks',       12, 7, 1.4,  0.04, -0.02, -0.05, 142.50, 1700000000000),
        ('mean-reversion-stocks',  5, 3, 0.8,  0.02, -0.01, -0.02,  18.20, 1700000000000)
    `).run()

    const res = await httpReq(srv, 'GET', '/api/v1/trader/track-records', { headers: tok(adminToken) })
    expect(res.status).toBe(200)
    const body = res.body as { track_records: Array<{ strategy_id: string; trade_count: number; net_pnl_usd: number }> }
    expect(body.track_records.length).toBe(2)
    expect(body.track_records[0].strategy_id).toBe('mean-reversion-stocks')
    expect(body.track_records[1].strategy_id).toBe('momentum-stocks')
    expect(body.track_records[1].trade_count).toBe(12)
    expect(body.track_records[1].net_pnl_usd).toBeCloseTo(142.5, 2)
  })

  it('returns 401 when unauthenticated', async () => {
    const res = await httpReq(srv, 'GET', '/api/v1/trader/track-records')
    expect(res.status).toBe(401)
  })

  it('returns 503 when the bot DB is unavailable', async () => {
    botDbAvailable = false
    try {
      const res = await httpReq(srv, 'GET', '/api/v1/trader/track-records', { headers: tok(adminToken) })
      expect(res.status).toBe(503)
    } finally {
      botDbAvailable = true
    }
  })
})

describe('POST /api/v1/trader/signals/:id/action', () => {
  function seedPendingSignal(signalId: string, approvalId?: string): void {
    testDb.prepare(`DELETE FROM trader_approvals WHERE decision_id = ?`).run(signalId)
    testDb.prepare(`DELETE FROM trader_signals WHERE id = ?`).run(signalId)
    testDb.prepare(`DELETE FROM trader_strategies WHERE id = 'signal-action-strategy'`).run()
    testDb.prepare(`
      INSERT INTO trader_strategies (id, name, asset_class, tier, status, params_json, created_at, updated_at)
      VALUES ('signal-action-strategy', 'Signal Action', 'stocks', 0, 'active', '{}', 1, 1)
    `).run()
    testDb.prepare(`
      INSERT INTO trader_signals (id, strategy_id, asset, side, raw_score, horizon_days, enrichment_json, generated_at, status)
      VALUES (?, 'signal-action-strategy', 'BTC/USD', 'buy', 0.81, 5, NULL, ?, 'pending')
    `).run(signalId, 1_700_000_300_000)
    if (approvalId) {
      testDb.prepare(`
        INSERT INTO trader_approvals (id, decision_id, sent_at, responded_at, response, override_size)
        VALUES (?, ?, ?, NULL, NULL, NULL)
      `).run(approvalId, signalId, 1_700_000_301_000)
    }
  }

  it('accepts an admin action and relays it to the Mac bot', async () => {
    seedPendingSignal('sig-action-1', 'ap-action-1')
    const res = await httpReq(
      srv,
      'POST',
      '/api/v1/trader/signals/sig-action-1/action',
      { headers: tok(adminToken), body: { action: 'approve' } },
    )
    expect(res.status).toBe(202)
    expect(res.body).toEqual({ accepted: true })
    expect(wsMock.broadcastToMac).toHaveBeenCalledWith(expect.objectContaining({
      type: 'trader-signal-action',
      signalId: 'sig-action-1',
      action: 'approve',
    }))
  })

  it('returns 503 when the Mac bot is offline', async () => {
    seedPendingSignal('sig-action-offline')
    wsMock.isBotConnected.mockReturnValue(false)
    const res = await httpReq(
      srv,
      'POST',
      '/api/v1/trader/signals/sig-action-offline/action',
      { headers: tok(adminToken), body: { action: 'skip' } },
    )
    expect(res.status).toBe(503)
    expect((res.body as { error: string }).error).toMatch(/offline/i)
    expect(wsMock.broadcastToMac).not.toHaveBeenCalled()
  })

  it('returns 409 when the latest approval was already claimed', async () => {
    seedPendingSignal('sig-action-claimed', 'ap-action-claimed')
    testDb.prepare(`
      UPDATE trader_approvals
      SET responded_at = ?, response = 'approve'
      WHERE id = 'ap-action-claimed'
    `).run(1_700_000_302_000)
    const res = await httpReq(
      srv,
      'POST',
      '/api/v1/trader/signals/sig-action-claimed/action',
      { headers: tok(adminToken), body: { action: 'approve' } },
    )
    expect(res.status).toBe(409)
    expect((res.body as { error: string }).error).toMatch(/claimed/i)
  })

  it('returns 403 for a non-admin caller', async () => {
    seedPendingSignal('sig-action-member')
    const res = await httpReq(
      srv,
      'POST',
      '/api/v1/trader/signals/sig-action-member/action',
      { headers: tok(memberToken), body: { action: 'approve' } },
    )
    expect(res.status).toBe(403)
    expect(wsMock.broadcastToMac).not.toHaveBeenCalled()
  })
})

// ===========================================================================
// Phase 4 Task D -- per-strategy drill-down routes
// ===========================================================================
//
// Fixtures seeded lazily in a beforeAll block so the earlier track-record
// tests (which wipe trader_strategy_track_record) do not interact with
// drill-down fixtures. We use strategy_id='drill-demo' plus three verdicts
// that exercise pagination cursor, attribution aggregation, and decision
// filtering.

const DRILL_STRATEGY_ID = 'drill-demo'
const DRILL_ABSENT_STRATEGY_ID = 'no-such-strategy'

function seedDrillDownFixtures(): void {
  testDb.exec(`DELETE FROM trader_verdicts;
               DELETE FROM trader_decisions;
               DELETE FROM trader_signals;
               DELETE FROM trader_strategies;`)

  testDb.prepare(`
    INSERT INTO trader_strategies (id, name, asset_class, tier, status, params_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(DRILL_STRATEGY_ID, 'Drill Demo', 'stocks', 0, 'active', '{}', 1_699_000_000_000, 1_699_000_000_000)

  testDb.prepare(`
    INSERT INTO trader_strategies (id, name, asset_class, tier, status, params_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run('other-strategy', 'Other', 'stocks', 0, 'active', '{}', 1_699_000_000_000, 1_699_000_000_000)

  const signals: Array<[string, string, string, string, number]> = [
    ['drill-sig-1', DRILL_STRATEGY_ID, 'AAPL', 'buy', 1_700_000_100_000],
    ['drill-sig-2', DRILL_STRATEGY_ID, 'MSFT', 'buy', 1_700_000_200_000],
    ['drill-sig-3', DRILL_STRATEGY_ID, 'TSLA', 'sell', 1_700_000_300_000],
    ['other-sig-1', 'other-strategy', 'NVDA', 'buy', 1_700_000_400_000],
  ]
  const insertSig = testDb.prepare(`
    INSERT INTO trader_signals (id, strategy_id, asset, side, raw_score, horizon_days, enrichment_json, generated_at, status)
    VALUES (?, ?, ?, ?, 0.5, 5, NULL, ?, 'routed')
  `)
  for (const sig of signals) insertSig.run(sig[0], sig[1], sig[2], sig[3], sig[4])

  const decisions: Array<[string, string, string, string, number, number]> = [
    ['drill-dec-1', 'drill-sig-1', 'buy', 'AAPL', 100, 1_700_000_110_000],
    ['drill-dec-2', 'drill-sig-2', 'buy', 'MSFT', 120, 1_700_000_210_000],
    ['drill-dec-3', 'drill-sig-3', 'sell', 'TSLA', 80, 1_700_000_310_000],
    ['other-dec-1', 'other-sig-1', 'buy', 'NVDA', 200, 1_700_000_410_000],
  ]
  const insertDec = testDb.prepare(`
    INSERT INTO trader_decisions (id, signal_id, action, asset, size_usd, entry_type, thesis, confidence,
                                  committee_transcript_id, decided_at, status)
    VALUES (?, ?, ?, ?, ?, 'market', 'demo thesis', 0.7, NULL, ?, 'closed')
  `)
  for (const d of decisions) insertDec.run(d[0], d[1], d[2], d[3], d[4], d[5])

  // Link drill-dec-1 to the seeded transcript so one decision shows the
  // transcript modal flow in the frontend. The transcript row was seeded
  // earlier in beforeAll.
  testDb.prepare(`UPDATE trader_decisions SET committee_transcript_id = ? WHERE id = ?`).run(TRANSCRIPT_ID, 'drill-dec-1')

  // Attribution JSON shapes mirror verdict-engine attributeAgents output.
  // Verdict 1: winner (pnl_gross=5). Verdict 2: loser (pnl_gross=-3).
  // Verdict 3: break-even (pnl_gross=0) so right/wrong skip cleanly.
  const attrWinner = JSON.stringify([
    { role: 'quant',          data: { confidence: 0.75, concerns_count: 0 } },
    { role: 'fundamentalist', data: { confidence: 0.60, concerns_count: 1 } },
    { role: 'risk_officer',   data: { vetoed: false, right: true } },
    { role: 'trader',         data: { action: 'buy', confidence: 0.72, size_multiplier: 1, right: true } },
  ])
  const attrLoser = JSON.stringify([
    { role: 'quant',        data: { confidence: 0.50, concerns_count: 2 } },
    { role: 'risk_officer', data: { vetoed: false, right: false } },
    { role: 'trader',       data: { action: 'buy', confidence: 0.55, size_multiplier: 1, right: false } },
  ])
  const attrNeutral = JSON.stringify([
    { role: 'quant',        data: { confidence: 0.40, concerns_count: 0 } },
    { role: 'risk_officer', data: { vetoed: false } },
    { role: 'trader',       data: { action: 'sell', confidence: 0.45, size_multiplier: 1 } },
  ])
  const insertVer = testDb.prepare(`
    INSERT INTO trader_verdicts (id, decision_id, pnl_gross, pnl_net, bench_return, hold_drawdown,
                                 thesis_grade, agent_attribution_json, embedding_id, closed_at,
                                 returns_backfilled)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, 1)
  `)
  insertVer.run('drill-ver-1', 'drill-dec-1',  5.0,  4.8, 0.005, -0.01, 'B', attrWinner,  1_700_000_120_000)
  insertVer.run('drill-ver-2', 'drill-dec-2', -3.0, -3.2, 0.002, -0.02, 'D', attrLoser,   1_700_000_220_000)
  insertVer.run('drill-ver-3', 'drill-dec-3',  0.0, -0.1, 0.001,  0.00, 'D', attrNeutral, 1_700_000_320_000)
}

describe('GET /api/v1/trader/strategies/:id/verdicts', () => {
  beforeAll(() => { seedDrillDownFixtures() })

  it('returns 404 for an unknown strategy id', async () => {
    const res = await httpReq(
      srv, 'GET', `/api/v1/trader/strategies/${DRILL_ABSENT_STRATEGY_ID}/verdicts`,
      { headers: tok(adminToken) },
    )
    expect(res.status).toBe(404)
  })

  it('returns verdicts newest-first scoped to the strategy', async () => {
    const res = await httpReq(
      srv, 'GET', `/api/v1/trader/strategies/${DRILL_STRATEGY_ID}/verdicts`,
      { headers: tok(adminToken) },
    )
    expect(res.status).toBe(200)
    const body = res.body as {
      verdicts: Array<{ id: string; asset: string; side: string; closed_at: number; pnl_net: number }>
      nextBeforeClosedAt?: number
    }
    expect(body.verdicts.length).toBe(3)
    expect(body.verdicts[0].id).toBe('drill-ver-3')
    expect(body.verdicts[2].id).toBe('drill-ver-1')
    expect(body.verdicts[0].asset).toBe('TSLA')
    expect(body.verdicts[0].side).toBe('sell')
    // Fewer than limit rows -> no cursor included
    expect(body.nextBeforeClosedAt).toBeUndefined()
  })

  it('paginates with limit + compound (closed_at, id) cursor', async () => {
    const first = await httpReq(
      srv, 'GET', `/api/v1/trader/strategies/${DRILL_STRATEGY_ID}/verdicts?limit=2`,
      { headers: tok(adminToken) },
    )
    expect(first.status).toBe(200)
    const firstBody = first.body as {
      verdicts: Array<{ id: string; closed_at: number }>
      nextBeforeClosedAt?: number
      nextBeforeId?: string
    }
    expect(firstBody.verdicts.length).toBe(2)
    expect(firstBody.verdicts[0].id).toBe('drill-ver-3')
    expect(firstBody.verdicts[1].id).toBe('drill-ver-2')
    expect(firstBody.nextBeforeClosedAt).toBe(firstBody.verdicts[1].closed_at)
    expect(firstBody.nextBeforeId).toBe(firstBody.verdicts[1].id)

    const second = await httpReq(
      srv, 'GET',
      `/api/v1/trader/strategies/${DRILL_STRATEGY_ID}/verdicts?limit=2` +
        `&before_closed_at=${firstBody.nextBeforeClosedAt}` +
        `&before_id=${firstBody.nextBeforeId}`,
      { headers: tok(adminToken) },
    )
    expect(second.status).toBe(200)
    const secondBody = second.body as {
      verdicts: Array<{ id: string }>
      nextBeforeClosedAt?: number
      nextBeforeId?: string
    }
    expect(secondBody.verdicts.length).toBe(1)
    expect(secondBody.verdicts[0].id).toBe('drill-ver-1')
    expect(secondBody.nextBeforeClosedAt).toBeUndefined()
    expect(secondBody.nextBeforeId).toBeUndefined()
  })

  it('handles verdicts sharing the same closed_at (no silent drops)', async () => {
    // Two verdicts with identical closed_at must both appear across
    // paginated fetches. A naive before_closed_at<T cursor would drop
    // the same-ms sibling when it straddles the page boundary.
    // Seed a dedicated strategy on the shared testDb so the usual
    // drill-down fixtures are untouched.
    testDb.prepare(
      `INSERT OR REPLACE INTO trader_strategies (id, name, asset_class, params_json, status, created_at, updated_at)
       VALUES ('tie-strategy', 'Tie', 'stocks', '{}', 'active', 1, 1)`,
    ).run()
    const TIE_MS = 2_000_000_000_000
    for (let i = 1; i <= 3; i++) {
      testDb.prepare(
        `INSERT INTO trader_signals (id, strategy_id, asset, side, raw_score, horizon_days, generated_at, status)
         VALUES (?, 'tie-strategy', 'AAPL', 'buy', 0.5, 5, ?, 'closed')`,
      ).run(`tie-sig-${i}`, TIE_MS - 1000)
      testDb.prepare(
        `INSERT INTO trader_decisions
           (id, signal_id, action, asset, size_usd, entry_type, thesis, confidence,
            committee_transcript_id, decided_at, status)
         VALUES (?, ?, 'buy', 'AAPL', 100, 'limit', 'thesis', 0.6, NULL, ?, 'closed')`,
      ).run(`tie-dec-${i}`, `tie-sig-${i}`, TIE_MS - 500)
      testDb.prepare(
        `INSERT INTO trader_verdicts
           (id, decision_id, pnl_gross, pnl_net, bench_return, hold_drawdown,
            thesis_grade, agent_attribution_json, embedding_id, closed_at, returns_backfilled)
         VALUES (?, ?, ?, ?, 0, 0, 'B', '[]', NULL, ?, 1)`,
      ).run(`tie-ver-${i}`, `tie-dec-${i}`, 10 * i, 10 * i, TIE_MS)
    }

    const first = await httpReq(
      srv, 'GET', `/api/v1/trader/strategies/tie-strategy/verdicts?limit=2`,
      { headers: tok(adminToken) },
    )
    expect(first.status).toBe(200)
    const firstBody = first.body as {
      verdicts: Array<{ id: string }>
      nextBeforeClosedAt?: number
      nextBeforeId?: string
    }
    expect(firstBody.verdicts.length).toBe(2)
    expect(firstBody.nextBeforeClosedAt).toBe(TIE_MS)
    expect(firstBody.nextBeforeId).toBeDefined()

    const second = await httpReq(
      srv, 'GET',
      `/api/v1/trader/strategies/tie-strategy/verdicts?limit=2` +
        `&before_closed_at=${firstBody.nextBeforeClosedAt}` +
        `&before_id=${firstBody.nextBeforeId}`,
      { headers: tok(adminToken) },
    )
    expect(second.status).toBe(200)
    const secondBody = second.body as { verdicts: Array<{ id: string }> }
    expect(secondBody.verdicts.length).toBe(1)

    const allIds = firstBody.verdicts.concat(secondBody.verdicts).map(v => v.id).sort()
    expect(allIds).toEqual(['tie-ver-1', 'tie-ver-2', 'tie-ver-3'])

    // Clean up the tie fixtures so later beforeAll(seedDrillDownFixtures)
    // runs are not polluted by the extra strategy.
    testDb.prepare(`DELETE FROM trader_verdicts WHERE id LIKE 'tie-ver-%'`).run()
    testDb.prepare(`DELETE FROM trader_decisions WHERE id LIKE 'tie-dec-%'`).run()
    testDb.prepare(`DELETE FROM trader_signals WHERE id LIKE 'tie-sig-%'`).run()
    testDb.prepare(`DELETE FROM trader_strategies WHERE id = 'tie-strategy'`).run()
  })

  it('returns 401 when unauthenticated', async () => {
    const res = await httpReq(srv, 'GET', `/api/v1/trader/strategies/${DRILL_STRATEGY_ID}/verdicts`)
    expect(res.status).toBe(401)
  })
})

describe('GET /api/v1/trader/strategies/:id/equity-curve', () => {
  beforeAll(() => { seedDrillDownFixtures() })

  it('returns 404 for an unknown strategy id', async () => {
    const res = await httpReq(
      srv, 'GET', `/api/v1/trader/strategies/${DRILL_ABSENT_STRATEGY_ID}/equity-curve`,
      { headers: tok(adminToken) },
    )
    expect(res.status).toBe(404)
  })

  it('returns points oldest-first with cumulative pnl_net', async () => {
    const res = await httpReq(
      srv, 'GET', `/api/v1/trader/strategies/${DRILL_STRATEGY_ID}/equity-curve`,
      { headers: tok(adminToken) },
    )
    expect(res.status).toBe(200)
    const body = res.body as {
      points: Array<{ closed_at: number; cumulative_pnl_net: number }>
    }
    expect(body.points.length).toBe(3)
    expect(body.points[0].closed_at).toBe(1_700_000_120_000)
    expect(body.points[0].cumulative_pnl_net).toBeCloseTo(4.8, 4)
    expect(body.points[1].cumulative_pnl_net).toBeCloseTo(4.8 - 3.2, 4)
    expect(body.points[2].cumulative_pnl_net).toBeCloseTo(4.8 - 3.2 - 0.1, 4)
  })

  it('returns an empty points array for a strategy with no verdicts', async () => {
    const res = await httpReq(
      srv, 'GET', '/api/v1/trader/strategies/other-strategy/equity-curve',
      { headers: tok(adminToken) },
    )
    expect(res.status).toBe(200)
    const body = res.body as { points: unknown[] }
    expect(body.points).toEqual([])
  })

  it('returns 401 when unauthenticated', async () => {
    const res = await httpReq(srv, 'GET', `/api/v1/trader/strategies/${DRILL_STRATEGY_ID}/equity-curve`)
    expect(res.status).toBe(401)
  })
})

describe('GET /api/v1/trader/strategies/:id/attribution', () => {
  beforeAll(() => { seedDrillDownFixtures() })

  it('returns 404 for an unknown strategy id', async () => {
    const res = await httpReq(
      srv, 'GET', `/api/v1/trader/strategies/${DRILL_ABSENT_STRATEGY_ID}/attribution`,
      { headers: tok(adminToken) },
    )
    expect(res.status).toBe(404)
  })

  it('aggregates per-role right/wrong/veto + confidence averages', async () => {
    const res = await httpReq(
      srv, 'GET', `/api/v1/trader/strategies/${DRILL_STRATEGY_ID}/attribution`,
      { headers: tok(adminToken) },
    )
    expect(res.status).toBe(200)
    const body = res.body as {
      verdict_count: number
      roles: Array<{
        role: string
        appearances: number
        right_count: number
        wrong_count: number
        extras: { veto_count?: number; confidence_avg?: number }
      }>
    }
    expect(body.verdict_count).toBe(3)
    const byRole = Object.fromEntries(body.roles.map(r => [r.role, r]))

    // Trader appears in all three verdicts; right in 1, wrong in 1,
    // neutral in 1 (no `right` field). right_count=1, wrong_count=1.
    expect(byRole.trader.appearances).toBe(3)
    expect(byRole.trader.right_count).toBe(1)
    expect(byRole.trader.wrong_count).toBe(1)
    expect(byRole.trader.extras.confidence_avg).toBeCloseTo((0.72 + 0.55 + 0.45) / 3, 4)

    // Risk officer: right in verdict 1, wrong in verdict 2, neutral in 3.
    // None were vetoed, so veto_count is not present.
    expect(byRole.risk_officer.appearances).toBe(3)
    expect(byRole.risk_officer.right_count).toBe(1)
    expect(byRole.risk_officer.wrong_count).toBe(1)
    expect(byRole.risk_officer.extras.veto_count).toBeUndefined()

    // Quant appears in all three (no right/wrong field, just confidence).
    expect(byRole.quant.appearances).toBe(3)
    expect(byRole.quant.right_count).toBe(0)
    expect(byRole.quant.wrong_count).toBe(0)

    // Fundamentalist only appears in the winner verdict.
    expect(byRole.fundamentalist.appearances).toBe(1)
  })

  it('returns an empty roles array for a strategy with no verdicts', async () => {
    const res = await httpReq(
      srv, 'GET', '/api/v1/trader/strategies/other-strategy/attribution',
      { headers: tok(adminToken) },
    )
    expect(res.status).toBe(200)
    const body = res.body as { roles: unknown[]; verdict_count: number }
    expect(body.roles).toEqual([])
    expect(body.verdict_count).toBe(0)
  })

  it('returns 401 when unauthenticated', async () => {
    const res = await httpReq(srv, 'GET', `/api/v1/trader/strategies/${DRILL_STRATEGY_ID}/attribution`)
    expect(res.status).toBe(401)
  })
})

describe('GET /api/v1/trader/strategies/:id/decisions', () => {
  beforeAll(() => { seedDrillDownFixtures() })

  it('returns 404 for an unknown strategy id', async () => {
    const res = await httpReq(
      srv, 'GET', `/api/v1/trader/strategies/${DRILL_ABSENT_STRATEGY_ID}/decisions`,
      { headers: tok(adminToken) },
    )
    expect(res.status).toBe(404)
  })

  it('returns decisions scoped to the strategy, newest-first', async () => {
    const res = await httpReq(
      srv, 'GET', `/api/v1/trader/strategies/${DRILL_STRATEGY_ID}/decisions`,
      { headers: tok(adminToken) },
    )
    expect(res.status).toBe(200)
    const body = res.body as {
      decisions: Array<{ id: string; asset: string; decided_at: number }>
    }
    expect(body.decisions.length).toBe(3)
    expect(body.decisions[0].id).toBe('drill-dec-3')
    expect(body.decisions[2].id).toBe('drill-dec-1')
    expect(body.decisions.every(d => ['AAPL', 'MSFT', 'TSLA'].includes(d.asset))).toBe(true)
  })

  it('honours the limit query parameter', async () => {
    const res = await httpReq(
      srv, 'GET', `/api/v1/trader/strategies/${DRILL_STRATEGY_ID}/decisions?limit=1`,
      { headers: tok(adminToken) },
    )
    expect(res.status).toBe(200)
    const body = res.body as { decisions: unknown[] }
    expect(body.decisions.length).toBe(1)
  })

  it('returns 401 when unauthenticated', async () => {
    const res = await httpReq(srv, 'GET', `/api/v1/trader/strategies/${DRILL_STRATEGY_ID}/decisions`)
    expect(res.status).toBe(401)
  })
})

// ===========================================================================
// Phase 4 Task E -- global committee report card
// ===========================================================================
//
// Global counterpart of the per-strategy attribution route. Reuses the
// drill-down fixtures (three verdicts on `drill-demo`) and adds a
// dedicated malformed-JSON verdict to prove the aggregator is tolerant
// of bad rows. Since `seedDrillDownFixtures` wipes verdicts on every
// call, each describe block uses its own beforeAll.

describe('GET /api/v1/trader/committee-report', () => {
  beforeAll(() => { seedDrillDownFixtures() })

  it('aggregates per-role tallies across every verdict in the DB', async () => {
    const res = await httpReq(
      srv, 'GET', '/api/v1/trader/committee-report',
      { headers: tok(adminToken) },
    )
    expect(res.status).toBe(200)
    const body = res.body as {
      verdict_count: number
      window_start_ms: number | null
      window_end_ms: number | null
      roles: Array<{
        role: string
        appearances: number
        right_count: number
        wrong_count: number
        extras: { veto_count?: number; confidence_avg?: number }
      }>
    }
    // All three drill-demo verdicts land in the global aggregate. No
    // strategy filter means the count matches the full trader_verdicts
    // table for this test session.
    expect(body.verdict_count).toBe(3)
    expect(body.window_start_ms).toBeNull()
    expect(body.window_end_ms).toBeNull()

    const byRole = Object.fromEntries(body.roles.map(r => [r.role, r]))
    // Identical shape to the per-strategy route because the three
    // verdicts are all scoped to `drill-demo` in this fixture set.
    expect(byRole.trader.appearances).toBe(3)
    expect(byRole.trader.right_count).toBe(1)
    expect(byRole.trader.wrong_count).toBe(1)
    expect(byRole.risk_officer.appearances).toBe(3)
    expect(byRole.risk_officer.right_count).toBe(1)
    expect(byRole.risk_officer.wrong_count).toBe(1)
    expect(byRole.quant.appearances).toBe(3)
    expect(byRole.fundamentalist.appearances).toBe(1)
  })

  it('returns an empty report when trader_verdicts is empty', async () => {
    // Snapshot the drill-down fixtures, wipe, and restore after.
    testDb.exec(`
      CREATE TEMP TABLE _verdict_backup AS SELECT * FROM trader_verdicts;
      DELETE FROM trader_verdicts;
    `)
    try {
      const res = await httpReq(
        srv, 'GET', '/api/v1/trader/committee-report',
        { headers: tok(adminToken) },
      )
      expect(res.status).toBe(200)
      const body = res.body as { roles: unknown[]; verdict_count: number }
      expect(body.verdict_count).toBe(0)
      expect(body.roles).toEqual([])
    } finally {
      testDb.exec(`
        INSERT INTO trader_verdicts SELECT * FROM _verdict_backup;
        DROP TABLE _verdict_backup;
      `)
    }
  })

  it('honours since_ms and until_ms time-window filters', async () => {
    // Drill-demo verdicts close at 120_000, 220_000, and 320_000 after
    // the 1_700_000_000_000 epoch anchor. A since_ms at 200_000 keeps
    // the last two; a matching until_ms drops the final one.
    const sinceOnly = await httpReq(
      srv, 'GET', '/api/v1/trader/committee-report?since_ms=1700000200000',
      { headers: tok(adminToken) },
    )
    expect(sinceOnly.status).toBe(200)
    const sinceBody = sinceOnly.body as {
      verdict_count: number
      window_start_ms: number | null
      window_end_ms: number | null
    }
    expect(sinceBody.verdict_count).toBe(2)
    expect(sinceBody.window_start_ms).toBe(1_700_000_200_000)
    expect(sinceBody.window_end_ms).toBeNull()

    const windowed = await httpReq(
      srv, 'GET', '/api/v1/trader/committee-report?since_ms=1700000200000&until_ms=1700000300000',
      { headers: tok(adminToken) },
    )
    expect(windowed.status).toBe(200)
    const winBody = windowed.body as {
      verdict_count: number
      window_start_ms: number | null
      window_end_ms: number | null
    }
    // since is inclusive, until is exclusive -> only the middle verdict
    // (closed_at = 1_700_000_220_000) falls inside [200_000, 300_000).
    expect(winBody.verdict_count).toBe(1)
    expect(winBody.window_start_ms).toBe(1_700_000_200_000)
    expect(winBody.window_end_ms).toBe(1_700_000_300_000)
  })

  it('skips malformed agent_attribution_json rows instead of failing', async () => {
    // Seed a fourth verdict whose attribution blob is invalid JSON. The
    // aggregator must ignore it and the endpoint must still return a
    // correct count for the other rows.
    testDb.prepare(`
      INSERT INTO trader_decisions (id, signal_id, action, asset, size_usd, entry_type,
                                    thesis, confidence, committee_transcript_id, decided_at, status)
      VALUES ('drill-dec-bad', 'drill-sig-1', 'buy', 'AAPL', 100, 'market',
              'malformed fixture', 0.5, NULL, 1700000500000, 'closed')
    `).run()
    testDb.prepare(`
      INSERT INTO trader_verdicts (id, decision_id, pnl_gross, pnl_net, bench_return,
                                   hold_drawdown, thesis_grade, agent_attribution_json,
                                   embedding_id, closed_at, returns_backfilled)
      VALUES ('drill-ver-bad', 'drill-dec-bad', 1.0, 0.8, 0, 0, 'C',
              'not valid json {{{', NULL, 1700000500000, 1)
    `).run()
    try {
      const res = await httpReq(
        srv, 'GET', '/api/v1/trader/committee-report',
        { headers: tok(adminToken) },
      )
      expect(res.status).toBe(200)
      const body = res.body as {
        verdict_count: number
        roles: Array<{ role: string; appearances: number }>
      }
      // Row count still includes the malformed verdict -- the filter is
      // applied at aggregation time, not at SELECT time.
      expect(body.verdict_count).toBe(4)
      // Tallies are unchanged -- the malformed row contributes nothing.
      const byRole = Object.fromEntries(body.roles.map(r => [r.role, r]))
      expect(byRole.trader.appearances).toBe(3)
      expect(byRole.risk_officer.appearances).toBe(3)
    } finally {
      testDb.prepare(`DELETE FROM trader_verdicts WHERE id = 'drill-ver-bad'`).run()
      testDb.prepare(`DELETE FROM trader_decisions WHERE id = 'drill-dec-bad'`).run()
    }
  })

  it('returns 503 when the bot DB is unavailable', async () => {
    botDbAvailable = false
    try {
      const res = await httpReq(
        srv, 'GET', '/api/v1/trader/committee-report', { headers: tok(adminToken) },
      )
      expect(res.status).toBe(503)
    } finally {
      botDbAvailable = true
    }
  })

  it('returns 401 when unauthenticated', async () => {
    const res = await httpReq(srv, 'GET', '/api/v1/trader/committee-report')
    expect(res.status).toBe(401)
  })
})

// ===========================================================================
// Phase 7 Task 1 -- GET /api/v1/trader/committee-trend
// ===========================================================================
//
// Reuses the drill-down fixtures (three verdicts with closed_at around
// 2023-11-14).  vi.setSystemTime pins Date.now() to a moment shortly
// after those closes so all three land inside a small-days window and
// the UTC day buckets are deterministic.

describe('GET /api/v1/trader/committee-trend (Phase 7 Task 1)', () => {
  beforeAll(() => { seedDrillDownFixtures() })

  // 2023-11-15 00:00:00 UTC -- day after the drill-demo closes.  Makes
  // the fresh today-bucket empty and drops the three verdicts into the
  // previous UTC day (2023-11-14).
  const PINNED_NOW = Date.UTC(2023, 10, 15, 0, 0, 0)

  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(PINNED_NOW) })
  afterEach(() => { vi.useRealTimers() })

  it('buckets verdicts by UTC day and rolls up per-role counts', async () => {
    const res = await httpReq(
      srv, 'GET', '/api/v1/trader/committee-trend?days=3',
      { headers: tok(adminToken) },
    )
    expect(res.status).toBe(200)
    const body = res.body as {
      days: Array<{
        date: string
        day_start_ms: number
        by_role: Record<string, { appearances: number; right_count: number; wrong_count: number }>
      }>
      roles: string[]
      window_days: number
      window_start_ms: number
      window_end_ms: number
    }
    expect(body.window_days).toBe(3)
    // All three drill-demo verdicts close on 2023-11-14 so they land
    // in a single day bucket (no zero-fill -- empty days are omitted).
    expect(body.days.length).toBe(1)
    expect(body.days[0].date).toBe('2023-11-14')
    expect(body.days[0].day_start_ms).toBe(Date.UTC(2023, 10, 14, 0, 0, 0))
    // Roles aggregate per day exactly like committee-report does for
    // the whole window.  Reconciles against the drill-demo fixture.
    const trader = body.days[0].by_role.trader
    expect(trader.appearances).toBe(3)
    expect(trader.right_count).toBe(1)
    expect(trader.wrong_count).toBe(1)
    // Sorted role union so the client can render stable chart legends.
    expect(body.roles).toEqual(['fundamentalist', 'quant', 'risk_officer', 'trader'])
  })

  it('returns an empty days array when no verdicts fall in the window', async () => {
    // 1-day window starting at PINNED_NOW drops every drill-demo verdict
    // (they closed on the previous UTC day).  The endpoint returns an
    // empty days array with the window echoed back for the client.
    const res = await httpReq(
      srv, 'GET', '/api/v1/trader/committee-trend?days=1',
      { headers: tok(adminToken) },
    )
    expect(res.status).toBe(200)
    const body = res.body as { days: unknown[]; roles: string[]; window_days: number }
    expect(body.days).toEqual([])
    expect(body.roles).toEqual([])
    expect(body.window_days).toBe(1)
  })

  it('falls back to 30 days when ?days is missing, malformed, or out of range', async () => {
    for (const q of ['', '?days=abc', '?days=-5', '?days=0', '?days=99999', '?days=1.5']) {
      const res = await httpReq(
        srv, 'GET', '/api/v1/trader/committee-trend' + q,
        { headers: tok(adminToken) },
      )
      expect(res.status).toBe(200)
      const body = res.body as { window_days: number }
      expect(body.window_days).toBe(30)
    }
  })

  it('returns 503 when the bot DB is unavailable', async () => {
    botDbAvailable = false
    try {
      const res = await httpReq(
        srv, 'GET', '/api/v1/trader/committee-trend?days=7',
        { headers: tok(adminToken) },
      )
      expect(res.status).toBe(503)
    } finally {
      botDbAvailable = true
    }
  })

  it('returns 401 when unauthenticated', async () => {
    const res = await httpReq(srv, 'GET', '/api/v1/trader/committee-trend?days=7')
    expect(res.status).toBe(401)
  })
})

// ===========================================================================
// Phase 5 Task 3 -- GET /api/v1/trader/kill-switch-log
// ===========================================================================

describe('GET /api/v1/trader/kill-switch-log (Phase 5 Task 3)', () => {
  function seedLog(rows: Array<{ ts: number; state: 'tripped' | 'active'; reason?: string; by?: string }>) {
    testDb.prepare('DELETE FROM kill_switch_log').run()
    for (const r of rows) {
      testDb.prepare(`INSERT INTO kill_switch_log (toggled_at_ms, new_state, reason, set_by) VALUES (?, ?, ?, ?)`)
        .run(r.ts, r.state, r.reason ?? null, r.by ?? null)
    }
  }

  it('returns seeded entries (newest first) for an admin token', async () => {
    seedLog([
      { ts: 1_700_000_001_000, state: 'tripped', reason: 'first',  by: 'Admin' },
      { ts: 1_700_000_002_000, state: 'active',  reason: 'cleared', by: 'Admin' },
    ])
    const res = await httpReq(srv, 'GET', '/api/v1/trader/kill-switch-log', { headers: tok(adminToken) })
    expect(res.status).toBe(200)
    const body = res.body as {
      entries: Array<{ id: number; toggled_at_ms: number; new_state: string; reason: string | null; set_by: string | null }>
    }
    expect(body.entries.length).toBe(2)
    expect(body.entries[0].toggled_at_ms).toBe(1_700_000_002_000)
    expect(body.entries[0].new_state).toBe('active')
    expect(body.entries[1].new_state).toBe('tripped')
    expect(body.entries[1].reason).toBe('first')
    expect(body.entries[1].set_by).toBe('Admin')
  })

  it('returns 403 for a member token (admin-only)', async () => {
    const res = await httpReq(srv, 'GET', '/api/v1/trader/kill-switch-log', { headers: tok(memberToken) })
    expect(res.status).toBe(403)
  })

  it('honours since_ms and until_ms window filters', async () => {
    seedLog([
      { ts: 1_700_000_001_000, state: 'tripped', reason: 'a' },
      { ts: 1_700_000_002_000, state: 'active',  reason: 'b' },
      { ts: 1_700_000_003_000, state: 'tripped', reason: 'c' },
      { ts: 1_700_000_004_000, state: 'active',  reason: 'd' },
    ])
    const res = await httpReq(
      srv,
      'GET',
      '/api/v1/trader/kill-switch-log?since_ms=1700000002000&until_ms=1700000003000',
      { headers: tok(adminToken) },
    )
    expect(res.status).toBe(200)
    const body = res.body as { entries: Array<{ toggled_at_ms: number; reason: string }> }
    expect(body.entries.map(e => e.toggled_at_ms)).toEqual([1_700_000_003_000, 1_700_000_002_000])
  })

  it('returns 400 when since_ms is malformed', async () => {
    const res = await httpReq(
      srv,
      'GET',
      '/api/v1/trader/kill-switch-log?since_ms=not-a-number',
      { headers: tok(adminToken) },
    )
    expect(res.status).toBe(400)
    expect((res.body as { error: string }).error).toMatch(/since_ms.*until_ms.*numbers/i)
  })

  it('returns { entries: [] } when the log is empty', async () => {
    seedLog([])
    const res = await httpReq(srv, 'GET', '/api/v1/trader/kill-switch-log', { headers: tok(adminToken) })
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ entries: [] })
  })

  it('returns 401 when unauthenticated', async () => {
    const res = await httpReq(srv, 'GET', '/api/v1/trader/kill-switch-log')
    expect(res.status).toBe(401)
  })
})

// ===========================================================================
// Phase 6 Task 5 -- GET /api/v1/trader/kill-switch-log client-supplied limit
// ===========================================================================

describe('GET /api/v1/trader/kill-switch-log ?limit (Phase 6 Task 5)', () => {
  function seedN(n: number): void {
    testDb.prepare('DELETE FROM kill_switch_log').run()
    const insert = testDb.prepare(
      `INSERT INTO kill_switch_log (toggled_at_ms, new_state, reason, set_by) VALUES (?, ?, ?, ?)`
    )
    // Ascending timestamps so response (DESC order) has the newest first.
    for (let i = 0; i < n; i++) {
      const ts = 1_700_000_000_000 + i
      insert.run(ts, i % 2 === 0 ? 'tripped' : 'active', 'seed-' + i, 'Admin')
    }
  }

  it('returns at most `limit` entries when client passes a small limit', async () => {
    seedN(20)
    const res = await httpReq(
      srv, 'GET', '/api/v1/trader/kill-switch-log?limit=5',
      { headers: tok(adminToken) },
    )
    expect(res.status).toBe(200)
    const body = res.body as { entries: Array<{ toggled_at_ms: number }> }
    expect(body.entries.length).toBe(5)
    // Newest first, so the last row (ts + 19) is on top.
    expect(body.entries[0].toggled_at_ms).toBe(1_700_000_000_019)
  })

  it('clamps limit above the 500-row cap', async () => {
    // Seed 600 rows so the pre-clamp limit (9999) would otherwise pull
    // all of them. After clamp the response must be exactly 500.
    seedN(600)
    const res = await httpReq(
      srv, 'GET', '/api/v1/trader/kill-switch-log?limit=9999',
      { headers: tok(adminToken) },
    )
    expect(res.status).toBe(200)
    const body = res.body as { entries: unknown[] }
    expect(body.entries.length).toBe(500)
  })

  it('rejects negative, zero, float, and non-numeric limit with 400', async () => {
    // Seed anything -- the route must reject before hitting the DB.
    seedN(3)
    const cases = ['0', '-1', '1.5', 'abc', '']
    for (const bad of cases) {
      const res = await httpReq(
        srv, 'GET', `/api/v1/trader/kill-switch-log?limit=${bad}`,
        { headers: tok(adminToken) },
      )
      expect(res.status, `limit=${bad || '(empty)'} should be 400`).toBe(400)
      expect((res.body as { error: string }).error).toMatch(/limit/i)
    }
  })
})

// ===========================================================================
// Phase 6 Task 5 -- GET /api/v1/trader/kill-switch-log.csv
// ===========================================================================

describe('GET /api/v1/trader/kill-switch-log.csv (Phase 6 Task 5)', () => {
  function seedLog(rows: Array<{ ts: number; state: 'tripped' | 'active'; reason?: string | null; by?: string | null }>): void {
    testDb.prepare('DELETE FROM kill_switch_log').run()
    for (const r of rows) {
      testDb.prepare(`INSERT INTO kill_switch_log (toggled_at_ms, new_state, reason, set_by) VALUES (?, ?, ?, ?)`)
        .run(r.ts, r.state, r.reason ?? null, r.by ?? null)
    }
  }

  it('returns text/csv with an attachment Content-Disposition', async () => {
    seedLog([
      { ts: 1_700_000_001_000, state: 'tripped', reason: 'boom', by: 'Admin' },
    ])
    const addr = (srv.address() as { port: number }).port
    const result: { status: number; headers: Record<string, string | string[] | undefined>; body: string } =
      await new Promise((resolve, reject) => {
        const r = nodeRequest(
          {
            hostname: '127.0.0.1', port: addr,
            path: '/api/v1/trader/kill-switch-log.csv',
            method: 'GET', headers: { 'x-dashboard-token': adminToken },
          },
          (res: IncomingMessage) => {
            let raw = ''
            res.on('data', (c: Buffer) => { raw += c.toString() })
            res.on('end', () => resolve({
              status: res.statusCode ?? 0,
              headers: res.headers as Record<string, string | string[] | undefined>,
              body: raw,
            }))
          },
        )
        r.on('error', reject)
        r.end()
      })
    expect(result.status).toBe(200)
    const ct = String(result.headers['content-type'] ?? '').toLowerCase()
    expect(ct).toContain('text/csv')
    const cd = String(result.headers['content-disposition'] ?? '')
    expect(cd).toContain('attachment')
    expect(cd).toContain('filename="kill-switch-log.csv"')
  })

  it('emits a header row plus one row per log entry (newest first)', async () => {
    seedLog([
      { ts: 1_700_000_001_000, state: 'tripped', reason: 'first',   by: 'Admin' },
      { ts: 1_700_000_002_000, state: 'active',  reason: 'cleared', by: 'Admin' },
    ])
    const addr = (srv.address() as { port: number }).port
    const result: { status: number; body: string } = await new Promise((resolve, reject) => {
      const r = nodeRequest(
        {
          hostname: '127.0.0.1', port: addr,
          path: '/api/v1/trader/kill-switch-log.csv',
          method: 'GET', headers: { 'x-dashboard-token': adminToken },
        },
        (res: IncomingMessage) => {
          let raw = ''
          res.on('data', (c: Buffer) => { raw += c.toString() })
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body: raw }))
        },
      )
      r.on('error', reject)
      r.end()
    })
    expect(result.status).toBe(200)
    const lines = result.body.trim().split('\n')
    expect(lines.length).toBe(3)
    expect(lines[0]).toBe('id,toggled_at_ms,new_state,reason,set_by')
    // Newest first: ts=...002_000 on line 1, ts=...001_000 on line 2.
    expect(lines[1]).toContain('1700000002000')
    expect(lines[1]).toContain('active')
    expect(lines[1]).toContain('cleared')
    expect(lines[2]).toContain('1700000001000')
    expect(lines[2]).toContain('tripped')
    expect(lines[2]).toContain('first')
  })

  it('escapes embedded commas and double quotes in the reason column', async () => {
    // One row carrying `reason` with both a comma and a double quote:
    // the escape branch must wrap in quotes and double the embedded "
    seedLog([
      { ts: 1_700_000_050_000, state: 'tripped', reason: 'spike, "sharp"', by: 'Admin' },
    ])
    const addr = (srv.address() as { port: number }).port
    const result: { status: number; body: string } = await new Promise((resolve, reject) => {
      const r = nodeRequest(
        {
          hostname: '127.0.0.1', port: addr,
          path: '/api/v1/trader/kill-switch-log.csv',
          method: 'GET', headers: { 'x-dashboard-token': adminToken },
        },
        (res: IncomingMessage) => {
          let raw = ''
          res.on('data', (c: Buffer) => { raw += c.toString() })
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body: raw }))
        },
      )
      r.on('error', reject)
      r.end()
    })
    expect(result.status).toBe(200)
    const lines = result.body.trim().split('\n')
    expect(lines.length).toBe(2)
    expect(lines[0]).toBe('id,toggled_at_ms,new_state,reason,set_by')
    // Escaped form: wrapped in quotes, each embedded " doubled.
    expect(lines[1]).toContain('"spike, ""sharp"""')
    expect(lines[1]).toContain('tripped')
    expect(lines[1]).toContain('Admin')
  })

  it('wraps embedded newlines in the reason column in double quotes', async () => {
    // Covers the \n branch of the csvEscape regex (/[",\n\r]/). Without
    // this test the newline arm is untested and could silently regress
    // if someone rewrites the escape as /[",]/ and forgets newlines.
    seedLog([
      { ts: 1_700_000_060_000, state: 'tripped', reason: 'spike\nsharp', by: 'Admin' },
    ])
    const addr = (srv.address() as { port: number }).port
    const result: { status: number; body: string } = await new Promise((resolve, reject) => {
      const r = nodeRequest(
        {
          hostname: '127.0.0.1', port: addr,
          path: '/api/v1/trader/kill-switch-log.csv',
          method: 'GET', headers: { 'x-dashboard-token': adminToken },
        },
        (res: IncomingMessage) => {
          let raw = ''
          res.on('data', (c: Buffer) => { raw += c.toString() })
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body: raw }))
        },
      )
      r.on('error', reject)
      r.end()
    })
    expect(result.status).toBe(200)
    // The embedded \n inside the reason cell must be wrapped in quotes
    // so CSV parsers treat the entry as a single field. The wrapped cell
    // shows up verbatim in the raw body (spanning two physical lines).
    expect(result.body).toContain('"spike\nsharp"')
  })

  it('returns 403 for a member token (admin-only)', async () => {
    seedLog([{ ts: 1_700_000_001_000, state: 'tripped' }])
    const res = await httpReq(
      srv, 'GET', '/api/v1/trader/kill-switch-log.csv',
      { headers: tok(memberToken) },
    )
    expect(res.status).toBe(403)
  })

  it('returns 401 when unauthenticated', async () => {
    const res = await httpReq(srv, 'GET', '/api/v1/trader/kill-switch-log.csv')
    expect(res.status).toBe(401)
  })
})

// ===========================================================================
// Phase 5 Task 7a -- POST /api/v1/trader/strategies/:id/pause
// ===========================================================================
//
// Admin-only mutation that flips trader_strategies.status to 'paused'.
// Idempotent: pausing an already-paused strategy still returns 200 and
// bumps updated_at. 404 when the strategy id is unknown.

describe('POST /api/v1/trader/strategies/:id/pause (Phase 5 Task 7a)', () => {
  // Each test seeds the row it needs because seedDrillDownFixtures (which
  // earlier tests rely on) wipes trader_strategies. Self-contained seeds
  // keep ordering between describe blocks loose.
  function seedActive(id: string): void {
    testDb.prepare(`DELETE FROM trader_strategies WHERE id = ?`).run(id)
    testDb.prepare(`
      INSERT INTO trader_strategies (id, name, asset_class, tier, status, params_json, created_at, updated_at)
      VALUES (?, ?, 'stocks', 0, 'active', '{}', 1, 1)
    `).run(id, id)
  }
  function seedPaused(id: string): void {
    testDb.prepare(`DELETE FROM trader_strategies WHERE id = ?`).run(id)
    testDb.prepare(`
      INSERT INTO trader_strategies (id, name, asset_class, tier, status, params_json, created_at, updated_at)
      VALUES (?, ?, 'stocks', 0, 'paused', '{}', 1, 1)
    `).run(id, id)
  }

  it('admin can pause an active strategy (200, DB row flipped)', async () => {
    seedActive('pause-active-1')
    const res = await httpReq(
      srv, 'POST', '/api/v1/trader/strategies/pause-active-1/pause',
      { headers: tok(adminToken) },
    )
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ status: 'paused' })

    const row = testDb.prepare(`SELECT status, updated_at FROM trader_strategies WHERE id = ?`)
      .get('pause-active-1') as { status: string; updated_at: number }
    expect(row.status).toBe('paused')
    // updated_at should be a recent ms timestamp, not the seed value (1)
    expect(row.updated_at).toBeGreaterThan(1_700_000_000_000)
  })

  it('returns 403 for a non-admin (member) token', async () => {
    seedActive('pause-active-member')
    const res = await httpReq(
      srv, 'POST', '/api/v1/trader/strategies/pause-active-member/pause',
      { headers: tok(memberToken) },
    )
    expect(res.status).toBe(403)
    // Confirm the row was NOT flipped
    const row = testDb.prepare(`SELECT status FROM trader_strategies WHERE id = ?`)
      .get('pause-active-member') as { status: string }
    expect(row.status).toBe('active')
  })

  it('returns 401 for an unauthenticated caller', async () => {
    seedActive('pause-active-unauth')
    const res = await httpReq(
      srv, 'POST', '/api/v1/trader/strategies/pause-active-unauth/pause',
    )
    expect(res.status).toBe(401)
  })

  it('returns 404 for a strategy that does not exist', async () => {
    const res = await httpReq(
      srv, 'POST', '/api/v1/trader/strategies/no-such-strategy-pause/pause',
      { headers: tok(adminToken) },
    )
    expect(res.status).toBe(404)
  })

  it('is idempotent: pausing an already-paused strategy returns 200 and bumps updated_at', async () => {
    seedPaused('pause-already-1')
    const before = testDb.prepare(`SELECT updated_at FROM trader_strategies WHERE id = ?`)
      .get('pause-already-1') as { updated_at: number }

    const res = await httpReq(
      srv, 'POST', '/api/v1/trader/strategies/pause-already-1/pause',
      { headers: tok(adminToken) },
    )
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ status: 'paused' })

    const after = testDb.prepare(`SELECT status, updated_at FROM trader_strategies WHERE id = ?`)
      .get('pause-already-1') as { status: string; updated_at: number }
    expect(after.status).toBe('paused')
    expect(after.updated_at).toBeGreaterThan(before.updated_at)
  })
})

// ===========================================================================
// Phase 5 Task 7b -- GET /api/v1/trader/strategies/:id/verdicts.csv
// ===========================================================================
//
// Streams the entire verdict history for a strategy as CSV. No
// pagination cap. Admin-only after the Phase 5 security audit (was
// viewer-level pre-audit; tightened to match sibling trader routes).
// Tests cover content-type, header row, escaping of embedded commas +
// quotes, 404 unknown strategy, 401 unauthed, 403 non-admin.

describe('GET /api/v1/trader/strategies/:id/verdicts.csv (Phase 5 Task 7b)', () => {
  // Re-seed the drill-down fixtures so the three drill-demo verdicts
  // exist regardless of which earlier tests ran first. A separate
  // strategy with one verdict carrying a tricky thesis_grade pins the
  // CSV escape behaviour.
  beforeAll(() => {
    seedDrillDownFixtures()

    testDb.prepare(`
      INSERT INTO trader_strategies (id, name, asset_class, tier, status, params_json, created_at, updated_at)
      VALUES ('csv-escape-strategy', 'CSV Escape', 'stocks', 0, 'active', '{}', 1, 1)
    `).run()
    testDb.prepare(`
      INSERT INTO trader_signals (id, strategy_id, asset, side, raw_score, horizon_days, generated_at, status)
      VALUES ('csv-sig-1', 'csv-escape-strategy', 'AAPL', 'buy', 0.5, 5, 1700000900000, 'closed')
    `).run()
    testDb.prepare(`
      INSERT INTO trader_decisions (id, signal_id, action, asset, size_usd, entry_type, thesis,
                                    confidence, committee_transcript_id, decided_at, status)
      VALUES ('csv-dec-1', 'csv-sig-1', 'buy', 'AAPL', 100, 'limit',
              'thesis with, comma and "quote"', 0.6, NULL, 1700000910000, 'closed')
    `).run()
    // A thesis_grade containing a comma AND a double quote forces the
    // escape branch (wrap + double the embedded quote).
    testDb.prepare(`
      INSERT INTO trader_verdicts (id, decision_id, pnl_gross, pnl_net, bench_return, hold_drawdown,
                                   thesis_grade, agent_attribution_json, embedding_id, closed_at, returns_backfilled)
      VALUES ('csv-ver-1', 'csv-dec-1', 1.5, 1.4, 0, 0, 'B,"weird"', '[]', NULL, 1700000950000, 1)
    `).run()
  })

  it('returns text/csv with attachment Content-Disposition for a known strategy', async () => {
    // Use raw fetch via httpReq pattern but inspect headers too. The
    // generic helper only returns body+status, so issue a direct
    // request for headers here.
    const addr = (srv.address() as { port: number }).port
    const headers: Record<string, string> = { 'x-dashboard-token': adminToken }
    const result: { status: number; headers: Record<string, string | string[] | undefined>; body: string } =
      await new Promise((resolve, reject) => {
        const r = nodeRequest(
          {
            hostname: '127.0.0.1', port: addr,
            path: `/api/v1/trader/strategies/${DRILL_STRATEGY_ID}/verdicts.csv`,
            method: 'GET', headers,
          },
          (res: IncomingMessage) => {
            let raw = ''
            res.on('data', (c: Buffer) => { raw += c.toString() })
            res.on('end', () => resolve({
              status: res.statusCode ?? 0,
              headers: res.headers as Record<string, string | string[] | undefined>,
              body: raw,
            }))
          },
        )
        r.on('error', reject)
        r.end()
      })

    expect(result.status).toBe(200)
    const ct = String(result.headers['content-type'] ?? '').toLowerCase()
    expect(ct).toContain('text/csv')
    const cd = String(result.headers['content-disposition'] ?? '')
    expect(cd).toContain('attachment')
    expect(cd).toContain(`filename="verdicts-${DRILL_STRATEGY_ID}.csv"`)
  })

  it('emits a header row plus one row per seeded verdict', async () => {
    const addr = (srv.address() as { port: number }).port
    const result: { status: number; body: string } = await new Promise((resolve, reject) => {
      const r = nodeRequest(
        {
          hostname: '127.0.0.1', port: addr,
          path: `/api/v1/trader/strategies/${DRILL_STRATEGY_ID}/verdicts.csv`,
          method: 'GET', headers: { 'x-dashboard-token': adminToken },
        },
        (res: IncomingMessage) => {
          let raw = ''
          res.on('data', (c: Buffer) => { raw += c.toString() })
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body: raw }))
        },
      )
      r.on('error', reject)
      r.end()
    })
    expect(result.status).toBe(200)
    const lines = result.body.trim().split('\n')
    // 1 header + 3 drill-demo verdicts
    expect(lines.length).toBe(4)
    expect(lines[0]).toBe('id,decision_id,closed_at,pnl_gross,pnl_net,bench_return,hold_drawdown,thesis_grade')
    // drill-ver-3 sorts first (newest closed_at)
    expect(lines[1]).toContain('drill-ver-3')
    expect(lines[3]).toContain('drill-ver-1')
  })

  it('escapes embedded commas and double quotes in CSV values', async () => {
    const addr = (srv.address() as { port: number }).port
    const result: { status: number; body: string } = await new Promise((resolve, reject) => {
      const r = nodeRequest(
        {
          hostname: '127.0.0.1', port: addr,
          path: `/api/v1/trader/strategies/csv-escape-strategy/verdicts.csv`,
          method: 'GET', headers: { 'x-dashboard-token': adminToken },
        },
        (res: IncomingMessage) => {
          let raw = ''
          res.on('data', (c: Buffer) => { raw += c.toString() })
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body: raw }))
        },
      )
      r.on('error', reject)
      r.end()
    })
    expect(result.status).toBe(200)
    const lines = result.body.trim().split('\n')
    expect(lines.length).toBe(2)
    // Header row passes through unchanged
    expect(lines[0]).toBe('id,decision_id,closed_at,pnl_gross,pnl_net,bench_return,hold_drawdown,thesis_grade')
    // The thesis_grade `B,"weird"` must be wrapped in quotes with the
    // embedded `"` doubled: `"B,""weird"""`
    expect(lines[1]).toContain('"B,""weird"""')
    // Sanity: the verdict id and decision id pass through without quoting
    expect(lines[1]).toContain('csv-ver-1')
    expect(lines[1]).toContain('csv-dec-1')
  })

  it('returns 404 for an unknown strategy', async () => {
    const res = await httpReq(
      srv, 'GET', '/api/v1/trader/strategies/no-such-csv-strategy/verdicts.csv',
      { headers: tok(adminToken) },
    )
    expect(res.status).toBe(404)
  })

  it('returns 401 when unauthenticated', async () => {
    const res = await httpReq(
      srv, 'GET', `/api/v1/trader/strategies/${DRILL_STRATEGY_ID}/verdicts.csv`,
    )
    expect(res.status).toBe(401)
  })

  it('returns 403 for non-admin callers (security audit fix)', async () => {
    // Phase 5 security audit: CSV export was previously open to any
    // authenticated user, allowing viewers on unrelated projects to
    // download full PnL history. Tightened to requireAdmin on the
    // 2026-04-19 hardening pass. This test pins that gate.
    const res = await httpReq(
      srv, 'GET', `/api/v1/trader/strategies/${DRILL_STRATEGY_ID}/verdicts.csv`,
      { headers: tok(memberToken) },
    )
    expect(res.status).toBe(403)
  })
})

// ===========================================================================
// Phase 5 Task 7a -- verdicts JSON response surfaces strategy_status
// ===========================================================================

describe('GET /api/v1/trader/strategies/:id/verdicts strategy_status (Phase 5 Task 7a)', () => {
  it('returns strategy_status alongside the verdict list', async () => {
    seedDrillDownFixtures()
    // drill-demo seeds as 'active'. Confirm pass-through.
    const res = await httpReq(
      srv, 'GET', `/api/v1/trader/strategies/${DRILL_STRATEGY_ID}/verdicts`,
      { headers: tok(adminToken) },
    )
    expect(res.status).toBe(200)
    const body = res.body as { verdicts: unknown[]; strategy_status?: string | null }
    expect(body.strategy_status).toBe('active')

    // Flip to 'paused' and re-fetch -- the field tracks the row.
    testDb.prepare(`UPDATE trader_strategies SET status = 'paused' WHERE id = ?`).run(DRILL_STRATEGY_ID)
    const res2 = await httpReq(
      srv, 'GET', `/api/v1/trader/strategies/${DRILL_STRATEGY_ID}/verdicts`,
      { headers: tok(adminToken) },
    )
    expect(res2.status).toBe(200)
    const body2 = res2.body as { strategy_status?: string | null }
    expect(body2.strategy_status).toBe('paused')
  })
})

// ===========================================================================
// Task 6 Sub-task B -- GET /api/v1/trader/signals/:id/committee
// ===========================================================================

describe('GET /api/v1/trader/signals/:id/committee', () => {
  const COMMITTEE_SIGNAL_ID = 'committee-sig-1'
  const COMMITTEE_SIGNAL_NO_TR = 'committee-sig-no-tr'
  const COMMITTEE_TRANSCRIPT_ID = 'tr-committee-1'

  beforeAll(() => {
    testDb.prepare(`DELETE FROM trader_committee_transcripts WHERE id = ?`).run(COMMITTEE_TRANSCRIPT_ID)
    testDb.prepare(`DELETE FROM trader_signals WHERE id IN (?, ?)`).run(COMMITTEE_SIGNAL_ID, COMMITTEE_SIGNAL_NO_TR)
    testDb.prepare(`DELETE FROM trader_strategies WHERE id = 'committee-strategy'`).run()

    testDb.prepare(`
      INSERT INTO trader_strategies (id, name, asset_class, tier, status, params_json, created_at, updated_at)
      VALUES ('committee-strategy', 'Committee Test', 'stocks', 0, 'active', '{}', 1, 1)
    `).run()

    testDb.prepare(`
      INSERT INTO trader_signals (id, strategy_id, asset, side, raw_score, horizon_days, enrichment_json, generated_at, status)
      VALUES (?, 'committee-strategy', 'AAPL', 'buy', 0.75, 5, NULL, ?, 'routed')
    `).run(COMMITTEE_SIGNAL_ID, 1_700_000_500_000)

    testDb.prepare(`
      INSERT INTO trader_signals (id, strategy_id, asset, side, raw_score, horizon_days, enrichment_json, generated_at, status)
      VALUES (?, 'committee-strategy', 'MSFT', 'sell', 0.55, 3, NULL, ?, 'routed')
    `).run(COMMITTEE_SIGNAL_NO_TR, 1_700_000_600_000)

    testDb.prepare(`
      INSERT INTO trader_committee_transcripts (id, signal_id, transcript_json, rounds, total_tokens, total_cost_usd, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      COMMITTEE_TRANSCRIPT_ID,
      COMMITTEE_SIGNAL_ID,
      JSON.stringify(SAMPLE_TRANSCRIPT),
      2,
      1100,
      0.03,
      1_700_000_510_000,
    )
  })

  it('returns the parsed transcript for a signal that has one', async () => {
    const res = await httpReq(
      srv, 'GET', `/api/v1/trader/signals/${COMMITTEE_SIGNAL_ID}/committee`,
      { headers: tok(adminToken) },
    )
    expect(res.status).toBe(200)
    const body = res.body as {
      transcript: {
        id: string; signal_id: string; rounds: number; total_tokens: number;
        total_cost_usd: number; body: typeof SAMPLE_TRANSCRIPT
      } | null
    }
    expect(body.transcript).not.toBeNull()
    expect(body.transcript!.id).toBe(COMMITTEE_TRANSCRIPT_ID)
    expect(body.transcript!.signal_id).toBe(COMMITTEE_SIGNAL_ID)
    expect(body.transcript!.rounds).toBe(2)
    expect(body.transcript!.total_tokens).toBe(1100)
    expect(body.transcript!.body.trader.action).toBe('buy')
  })

  it('returns { transcript: null } when the signal has no transcript', async () => {
    const res = await httpReq(
      srv, 'GET', `/api/v1/trader/signals/${COMMITTEE_SIGNAL_NO_TR}/committee`,
      { headers: tok(adminToken) },
    )
    expect(res.status).toBe(200)
    const body = res.body as { transcript: null }
    expect(body.transcript).toBeNull()
  })

  it('returns 404 for an unknown signal id', async () => {
    const res = await httpReq(
      srv, 'GET', '/api/v1/trader/signals/no-such-signal/committee',
      { headers: tok(adminToken) },
    )
    expect(res.status).toBe(404)
  })

  it('returns 401 when unauthenticated', async () => {
    const res = await httpReq(srv, 'GET', `/api/v1/trader/signals/${COMMITTEE_SIGNAL_ID}/committee`)
    expect(res.status).toBe(401)
  })

  it('returns 503 when the bot DB is unavailable', async () => {
    botDbAvailable = false
    try {
      const res = await httpReq(
        srv, 'GET', `/api/v1/trader/signals/${COMMITTEE_SIGNAL_ID}/committee`,
        { headers: tok(adminToken) },
      )
      expect(res.status).toBe(503)
    } finally {
      botDbAvailable = true
    }
  })
})
