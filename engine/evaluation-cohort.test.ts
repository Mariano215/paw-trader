import { beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { initTraderTables } from './db.js'
import {
  COHORT_ENFORCEMENT_KV_KEY,
  activateCohort,
  cohortFingerprint,
  createDraftCohort,
  currentFingerprintMatches,
  guardRunningCohort,
  invalidateCohort,
  recordCohortBacktest,
  type CreateCohortInput,
} from './evaluation-cohort.js'

function makeDb() {
  const db = new Database(':memory:')
  db.pragma('foreign_keys=ON')
  initTraderTables(db)
  const now = Date.now()
  db.prepare(`INSERT INTO trader_strategies
    (id,name,asset_class,tier,status,params_json,created_at,updated_at,max_size_usd)
    VALUES (?,?,?,?,?,?,?,?,?)`).run('momentum-crypto','Crypto Momentum','crypto',0,'paused','{"basket":["BTC/USD"]}',now,now,null)
  db.prepare(`INSERT INTO trader_strategies
    (id,name,asset_class,tier,status,params_json,created_at,updated_at,max_size_usd)
    VALUES (?,?,?,?,?,?,?,?,?)`).run('mean-reversion-stocks','Mean Reversion','stocks',0,'paused','{"basket":["AAPL"]}',now,now,null)
  return db
}

const cryptoDraft: CreateCohortInput = {
  id: 'btc-paper-v1', strategyId: 'momentum-crypto', assetClass: 'crypto', universe: ['BTC/USD'],
  dataVenue: 'coinbase', executionVenue: 'alpaca', feeBpsPerSide: 25, slippageBpsPerSide: 10,
  benchmarkAsset: 'BTC/USD', maxPositionUsd: 200, dailyTradeCap: 5,
  claudepawRevision: '3f9b897', engineRevision: '4656022',
}

const clean = {
  engineMode: 'paper', brokerConnected: true, dataVenueConnected: true, assetClassEnabled: true,
  reconcilerHalted: false, reconcileDriftDetected: false, reconcileFresh: true,
  ordersAvailable: true, positionsAvailable: true, openOrderCount: 0,
  conflictingPositionCount: 0, unknownOrderCount: 0,
  unexpectedShortCount: 0, quarantineLegacyPositions: true,
}

describe('prospective evaluation cohorts', () => {
  let db: Database.Database
  beforeEach(() => { db = makeDb() })

  it('creates an immutable draft with deterministic fingerprint', () => {
    const a = createDraftCohort(db, cryptoDraft, 'test', 100)
    expect(a.status).toBe('draft')
    expect(JSON.parse(a.universe_json)).toEqual(['BTC/USD'])
    expect(cohortFingerprint(JSON.parse(a.config_json))).toBe(a.config_fingerprint)
    expect(() => createDraftCohort(db, {...cryptoDraft, id: 'eth-paper', universe: ['ETH/USD']})).toThrow(/exactly BTC/)
  })

  it('fails closed when activation preflight is incomplete', () => {
    createDraftCohort(db, cryptoDraft)
    expect(() => activateCohort(db, cryptoDraft.id, {...clean, brokerConnected: null}, 'admin')).toThrow(/broker/)
    expect(() => activateCohort(db, cryptoDraft.id, {...clean, unknownOrderCount: 1}, 'admin')).toThrow(/unresolved/)
    expect(() => activateCohort(db, cryptoDraft.id, {...clean, openOrderCount: 1}, 'admin')).toThrow(/open broker orders/)
    expect(() => activateCohort(db, cryptoDraft.id, {...clean, conflictingPositionCount: 1}, 'admin')).toThrow(/must be flat/)
    expect(() => activateCohort(db, cryptoDraft.id, {...clean, engineMode: 'live'}, 'admin')).toThrow(/paper/)
  })

  it('atomically starts one paper cohort and pauses every other strategy', () => {
    createDraftCohort(db, cryptoDraft)
    const started = activateCohort(db, cryptoDraft.id, clean, 'admin', 200)
    expect(started.status).toBe('running')
    expect(started.legacy_quarantined_at).toBe(200)
    expect(db.prepare("SELECT status,max_size_usd FROM trader_strategies WHERE id='momentum-crypto'").get())
      .toEqual({status: 'active', max_size_usd: 200})
    expect(db.prepare("SELECT status FROM trader_strategies WHERE id='mean-reversion-stocks'").get())
      .toEqual({status: 'paused'})
    expect((db.prepare('SELECT value FROM kv_settings WHERE key=?').get(COHORT_ENFORCEMENT_KV_KEY) as {value: string}).value).toBe('1')
    expect(currentFingerprintMatches(db, started)).toBe(true)
  })

  it('allows one running cohort per strategy and several per asset-class sleeve', () => {
    createDraftCohort(db, cryptoDraft)
    activateCohort(db, cryptoDraft.id, clean, 'admin')
    const now=Date.now()
    db.prepare(`INSERT INTO trader_strategies
      (id,name,asset_class,tier,status,params_json,created_at,updated_at,max_size_usd)
      VALUES ('alternate-crypto','Alternate Crypto','crypto',0,'paused','{"basket":["BTC/USD"]}',?,?,NULL)`).run(now,now)
    createDraftCohort(db, {...cryptoDraft,id:'btc-paper-v2',strategyId:'alternate-crypto'})

    // A sibling strategy starts alongside; the first cohort's strategy stays active.
    activateCohort(db,'btc-paper-v2',clean,'admin')
    expect(db.prepare("SELECT status FROM trader_strategies WHERE id='momentum-crypto'").get()).toEqual({status:'active'})
    expect(db.prepare("SELECT status FROM trader_strategies WHERE id='alternate-crypto'").get()).toEqual({status:'active'})

    // A second cohort for a strategy that already has one running is refused.
    createDraftCohort(db, {...cryptoDraft,id:'btc-paper-v3'})
    expect(() => activateCohort(db,'btc-paper-v3',clean,'admin')).toThrow(/strategy already has running cohort/)
    expect(db.prepare("SELECT status FROM trader_evaluation_cohorts WHERE id='btc-paper-v3'").get())
      .toEqual({status:'draft'})
  })

  it('guards universe and invalidates configuration drift', () => {
    createDraftCohort(db, cryptoDraft)
    activateCohort(db, cryptoDraft.id, clean, 'admin')
    expect(guardRunningCohort(db, 'momentum-crypto', 'BTC/USD').ok).toBe(true)
    expect(guardRunningCohort(db, 'momentum-crypto', 'ETH/USD').reason).toMatch(/outside/)
    db.prepare("UPDATE trader_strategies SET params_json='{}' WHERE id='momentum-crypto'").run()
    expect(guardRunningCohort(db, 'momentum-crypto', 'BTC/USD').reason).toMatch(/invalidated/)
    expect(db.prepare("SELECT status FROM trader_evaluation_cohorts WHERE id='btc-paper-v1'").get()).toEqual({status: 'invalidated'})
    expect(db.prepare("SELECT status FROM trader_strategies WHERE id='momentum-crypto'").get()).toEqual({status: 'paused'})
  })

  it('invalidates and audits in one operation', () => {
    createDraftCohort(db, cryptoDraft)
    invalidateCohort(db, cryptoDraft.id, 'operator stopped', 'admin', 300)
    expect(db.prepare("SELECT status,invalidation_reason FROM trader_evaluation_cohorts WHERE id=?").get(cryptoDraft.id))
      .toEqual({status: 'invalidated', invalidation_reason: 'operator stopped'})
    expect((db.prepare('SELECT count(*) n FROM trader_cohort_events WHERE cohort_id=?').get(cryptoDraft.id) as {n:number}).n).toBe(2)
  })

  it('accepts only bounded backtest evidence tied to the exact cohort fingerprint', () => {
    const cohort = createDraftCohort(db, cryptoDraft, 'test', 100)
    expect(() => recordCohortBacktest(db, cohort.id, {
      configFingerprint:'wrong', sharpe:1, tradeCount:100, maxDrawdownPct:0.1, report:{method:'walk-forward'},
    })).toThrow(/fingerprint/)
    recordCohortBacktest(db, cohort.id, {
      configFingerprint:cohort.config_fingerprint, sharpe:1.2, tradeCount:140,
      maxDrawdownPct:0.12, report:{method:'walk-forward', outOfSample:true},
    }, 'test', 200)
    expect(db.prepare(`SELECT backtest_sharpe,backtest_trade_count,backtest_max_drawdown_pct,
      backtest_fingerprint,backtest_evaluated_at FROM trader_evaluation_cohorts WHERE id=?`).get(cohort.id))
      .toEqual({backtest_sharpe:1.2,backtest_trade_count:140,backtest_max_drawdown_pct:0.12,
        backtest_fingerprint:cohort.config_fingerprint,backtest_evaluated_at:200})
  })
})
