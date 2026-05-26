/**
 * Tests for GET /api/v1/trader/verdicts (cross-strategy endpoint)
 *
 * Run: cd server && npx vitest run src/trader-routes/verdicts.test.ts
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import Database from 'better-sqlite3'
import http from 'node:http'
import express from 'express'
import traderRouter from './index.js'

// ---- in-memory DB fixture -----------------------------------------------

let testDb: Database.Database

function makeSchema(db: Database.Database) {
  db.exec(`
    CREATE TABLE trader_strategies (
      id TEXT PRIMARY KEY, name TEXT, status TEXT DEFAULT 'active'
    );
    CREATE TABLE trader_signals (
      id TEXT PRIMARY KEY, strategy_id TEXT, asset TEXT, side TEXT,
      raw_score REAL, created_at INTEGER
    );
    CREATE TABLE trader_decisions (
      id TEXT PRIMARY KEY, signal_id TEXT, asset TEXT,
      status TEXT DEFAULT 'closed', created_at INTEGER
    );
    CREATE TABLE trader_verdicts (
      id TEXT PRIMARY KEY, decision_id TEXT,
      pnl_gross REAL, pnl_net REAL, bench_return REAL,
      hold_drawdown REAL, thesis_grade TEXT, closed_at INTEGER
    );
  `)
}

function seedVerdicts(db: Database.Database) {
  db.exec(`
    INSERT INTO trader_strategies VALUES ('strat-a', 'Momentum', 'active');
    INSERT INTO trader_strategies VALUES ('strat-b', 'MeanRev',  'active');

    INSERT INTO trader_signals VALUES ('sig-1', 'strat-a', 'AAPL', 'buy',  0.8, 1000);
    INSERT INTO trader_signals VALUES ('sig-2', 'strat-b', 'SPY',  'sell', 0.6, 1001);
    INSERT INTO trader_signals VALUES ('sig-3', 'strat-a', 'NVDA', 'buy',  0.9, 1002);

    INSERT INTO trader_decisions VALUES ('dec-1', 'sig-1', 'AAPL', 'closed', 1000);
    INSERT INTO trader_decisions VALUES ('dec-2', 'sig-2', 'SPY',  'closed', 1001);
    INSERT INTO trader_decisions VALUES ('dec-3', 'sig-3', 'NVDA', 'closed', 1002);

    INSERT INTO trader_verdicts VALUES ('v-3', 'dec-3', 200, 185, 0.02, 0.03, 'A', 3000);
    INSERT INTO trader_verdicts VALUES ('v-2', 'dec-2', -50, -55, 0.01, 0.05, 'C', 2000);
    INSERT INTO trader_verdicts VALUES ('v-1', 'dec-1', 100, 90,  0.01, 0.02, 'B', 1000);
  `)
}

// ---- mock db.js ---------------------------------------------------------

vi.mock('../db.js', async () => {
  return {
    getBotDb: vi.fn(() => testDb ?? null),
    getBotDbWrite: vi.fn(() => testDb ?? null),
  }
})

// ---- HTTP test server ---------------------------------------------------

let server: http.Server
let baseUrl: string
const AUTH = 'Bearer test-token-admin'

vi.mock('../auth.js', async () => ({
  authenticate: (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
  requireAdmin: (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
  requireBotOrAdmin: (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
  requireProjectRead: () => (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
}))

beforeAll(async () => {
  testDb = new Database(':memory:')
  makeSchema(testDb)
  seedVerdicts(testDb)

  const app = express()
  app.use(express.json())
  app.use(traderRouter)

  await new Promise<void>((resolve) => {
    server = app.listen(0, resolve)
  })
  const addr = server.address() as { port: number }
  baseUrl = `http://127.0.0.1:${addr.port}`
})

afterAll(() => {
  server.close()
  testDb.close()
})

// ---- tests --------------------------------------------------------------

function get(path: string): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    http.get(`${baseUrl}${path}`, { headers: { Authorization: AUTH } }, (res) => {
      let raw = ''
      res.on('data', (c) => { raw += c })
      res.on('end', () => {
        resolve({ status: res.statusCode ?? 0, body: JSON.parse(raw) })
      })
    }).on('error', reject)
  })
}

describe('GET /api/v1/trader/verdicts', () => {
  it('returns all verdicts newest-first across all strategies', async () => {
    const { status, body } = await get('/api/v1/trader/verdicts') as { status: number; body: { verdicts: Array<{ id: string; asset: string; side: string }> } }
    expect(status).toBe(200)
    expect(body.verdicts).toHaveLength(3)
    expect(body.verdicts[0].id).toBe('v-3')  // closed_at=3000
    expect(body.verdicts[1].id).toBe('v-2')  // closed_at=2000
    expect(body.verdicts[2].id).toBe('v-1')  // closed_at=1000
  })

  it('respects the limit parameter', async () => {
    const { status, body } = await get('/api/v1/trader/verdicts?limit=2') as { status: number; body: { verdicts: unknown[]; nextBeforeClosedAt: number; nextBeforeId: string } }
    expect(status).toBe(200)
    expect(body.verdicts).toHaveLength(2)
    expect(body.nextBeforeClosedAt).toBe(2000)
    expect(body.nextBeforeId).toBe('v-2')
  })

  it('paginates with compound cursor', async () => {
    const p1 = await get('/api/v1/trader/verdicts?limit=2') as { status: number; body: { verdicts: Array<{ id: string }>; nextBeforeClosedAt: number; nextBeforeId: string } }
    const { nextBeforeClosedAt, nextBeforeId } = p1.body
    const p2 = await get(`/api/v1/trader/verdicts?limit=2&before_closed_at=${nextBeforeClosedAt}&before_id=${nextBeforeId}`) as { status: number; body: { verdicts: Array<{ id: string }> } }
    expect(p2.status).toBe(200)
    expect(p2.body.verdicts).toHaveLength(1)
    expect(p2.body.verdicts[0].id).toBe('v-1')
  })

  it('returns verdict fields including asset, side, thesis_grade', async () => {
    const { body } = await get('/api/v1/trader/verdicts?limit=1') as { status: number; body: { verdicts: Array<{ asset: string; side: string; thesis_grade: string; pnl_net: number }> } }
    const v = body.verdicts[0]
    expect(v.asset).toBe('NVDA')
    expect(v.side).toBe('buy')
    expect(v.thesis_grade).toBe('A')
    expect(typeof v.pnl_net).toBe('number')
  })

  it('returns 503 when bot DB unavailable', async () => {
    const orig = testDb
    // @ts-expect-error — force null for this test
    testDb = null
    const { status } = await get('/api/v1/trader/verdicts')
    expect(status).toBe(503)
    testDb = orig
  })
})
