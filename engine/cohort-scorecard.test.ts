import { beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { initTraderTables } from './db.js'
import { createDraftCohort } from './evaluation-cohort.js'
import { evaluateCohort, refreshCohortScorecards } from './cohort-scorecard.js'

function setup() {
  const db = new Database(':memory:')
  db.pragma('foreign_keys=OFF')
  initTraderTables(db)
  const now = 1_000_000
  db.prepare(`INSERT INTO trader_strategies
    (id,name,asset_class,tier,status,params_json,created_at,updated_at,max_size_usd)
    VALUES ('momentum-crypto','Crypto Momentum','crypto',0,'active','{"basket":["BTC/USD"]}',?,?,200)`).run(now,now)
  const cohort = createDraftCohort(db, {
    id:'btc-v1',strategyId:'momentum-crypto',assetClass:'crypto',universe:['BTC/USD'],dataVenue:'coinbase',executionVenue:'alpaca',
    feeBpsPerSide:25,slippageBpsPerSide:10,benchmarkAsset:'BTC/USD',maxPositionUsd:200,dailyTradeCap:5,
    claudepawRevision:'3f9b897',engineRevision:'4656022',
  },'test',now)
  db.prepare("UPDATE trader_evaluation_cohorts SET status='running',started_at=?,legacy_quarantined_at=? WHERE id='btc-v1'").run(now,now)
  return {db,cohort:{...cohort,status:'running' as const,started_at:now,legacy_quarantined_at:now}}
}

function addRoundTrip(db: Database.Database, id: string, buy: number, sell: number, ts: number, cohortId: string | null) {
  db.prepare(`INSERT INTO trader_signals
    (id,strategy_id,asset,side,raw_score,horizon_days,enrichment_json,generated_at,status)
    VALUES (?, 'momentum-crypto','BTC/USD','buy',0.9,7,'{"markov_regime":{"current_state":"crypto-bull"}}',?,'executed')`).run(`s-${id}`,ts)
  db.prepare(`INSERT INTO trader_decisions
    (id,signal_id,action,asset,size_usd,entry_type,thesis,confidence,decided_at,status,cohort_id)
    VALUES (?,?,'buy','BTC/USD',200,'limit','t',0.8,?,'closed',?)`).run(`d-${id}`,`s-${id}`,ts,cohortId)
  db.prepare(`INSERT INTO trader_decisions
    (id,signal_id,parent_decision_id,action,asset,size_usd,entry_type,thesis,confidence,decided_at,status,cohort_id)
    VALUES (?,?,?,'sell','BTC/USD',0,'market','x',1,?,'closed',?)`).run(`x-${id}`,`s-${id}`,`d-${id}`,ts+2,cohortId)
  db.prepare(`INSERT INTO trader_fills
    (id,decision_id,client_order_id,broker_order_id,asset,side,fill_qty,fill_price,intended_price,intended_ts_ms,fill_ts_ms,fee_usd,slippage_usd,entry_thesis,exit_reason,recorded_at)
    VALUES (?,?,?,?,'BTC/USD','buy',1,?,?,?, ?,0,0,NULL,NULL,?)`).run(`fb-${id}`,`d-${id}`,`cb-${id}`,`bb-${id}`,buy,buy,ts,ts,ts)
  db.prepare(`INSERT INTO trader_fills
    (id,decision_id,client_order_id,broker_order_id,asset,side,fill_qty,fill_price,intended_price,intended_ts_ms,fill_ts_ms,fee_usd,slippage_usd,entry_thesis,exit_reason,recorded_at)
    VALUES (?,?,?,?,'BTC/USD','sell',1,?,NULL,NULL,?,0,0,NULL,'target',?)`).run(`fs-${id}`,`x-${id}`,`cs-${id}`,`bs-${id}`,sell,ts+2,ts+2)
  db.prepare(`INSERT INTO trader_verdicts
    (id,decision_id,pnl_gross,pnl_net,bench_return,hold_drawdown,thesis_grade,agent_attribution_json,closed_at,returns_backfilled,excluded_at)
    VALUES (?,?,0,0,0.001,0,'A','[]',?,1,NULL)`).run(`v-${id}`,`d-${id}`,ts+2)
}

describe('cohort scorecard', () => {
  let db: Database.Database
  beforeEach(() => { ({db}=setup()) })

  it('excludes all legacy fills and charges frozen modeled costs', () => {
    addRoundTrip(db,'legacy',100,200,10,null)
    addRoundTrip(db,'cohort',100,101,20,'btc-v1')
    const score = evaluateCohort(db,'btc-v1',100)
    expect(score.tradeCount).toBe(1)
    // Gross $1 less 35bps on each $100/$101 leg = about $0.7035 net.
    expect(score.netPnlUsd).toBeCloseTo(0.2965,4)
    expect(score.benchmarkReturn).toBeCloseTo(0.001)
    expect(score.passed).toBe(false)
    expect(score.criteria.find(c=>c.name==='closed_trades')?.passed).toBe(false)
  })

  it('blocks completeness while matched backtest evidence is absent', () => {
    addRoundTrip(db,'cohort',100,102,20,'btc-v1')
    const score=evaluateCohort(db,'btc-v1',100)
    expect(score.evidenceComplete).toBe(false)
    expect(score.criteria.find(c=>c.name==='matched_backtest')?.passed).toBe(false)
  })

  it('counts regimes only from completed cohort round trips', () => {
    addRoundTrip(db,'cohort',100,102,20,'btc-v1')
    db.prepare(`INSERT INTO trader_signals
      (id,strategy_id,asset,side,raw_score,horizon_days,enrichment_json,generated_at,status)
      VALUES ('s-unused','momentum-crypto','BTC/USD','buy',0.9,7,
      '{"markov_regime":{"current_state":"crypto-bear"}}',30,'executed')`).run()
    db.prepare(`INSERT INTO trader_decisions
      (id,signal_id,action,asset,size_usd,entry_type,thesis,confidence,decided_at,status,cohort_id)
      VALUES ('d-unused','s-unused','buy','BTC/USD',200,'limit','t',0.8,30,'committee_abstain','btc-v1')`).run()

    const score=evaluateCohort(db,'btc-v1',100)
    expect(score.regimes).toEqual(['crypto-bull'])
    expect(score.criteria.find(c=>c.name==='trade_linked_regimes')?.passed).toBe(false)
  })

  it('requires current paper broker, reconcile, data, and NAV evidence', () => {
    const now=2_000_000
    addRoundTrip(db,'cohort',100,102,20,'btc-v1')
    const current=evaluateCohort(db,'btc-v1',now,{
      engineMode:'paper',brokerConnected:true,coinbaseConnected:true,cryptoEnabled:true,
      reconcilerHalted:false,reconcileDriftDetected:false,reconcileRanAt:now-1_000,
      nav:100_000,navRecordedAt:now-1_000,
    })
    expect(current.criteria.find(c=>c.name==='broker_evidence_current')?.passed).toBe(true)

    const stale=evaluateCohort(db,'btc-v1',now,{
      engineMode:'paper',brokerConnected:true,coinbaseConnected:true,cryptoEnabled:true,
      reconcilerHalted:false,reconcileDriftDetected:false,reconcileRanAt:0,
      nav:100_000,navRecordedAt:now-1_000,
    })
    expect(stale.criteria.find(c=>c.name==='broker_evidence_current')?.passed).toBe(false)
    expect(stale.evidenceComplete).toBe(false)
  })

  it('persists a scorecard without changing a failing running cohort', () => {
    addRoundTrip(db,'cohort',100,102,20,'btc-v1')
    const [score]=refreshCohortScorecards(db,100)
    expect(score.passed).toBe(false)
    expect(db.prepare("SELECT trade_count,passed FROM trader_cohort_scorecards WHERE cohort_id='btc-v1'").get())
      .toEqual({trade_count:1,passed:0})
    expect(db.prepare("SELECT status FROM trader_evaluation_cohorts WHERE id='btc-v1'").get()).toEqual({status:'running'})
  })
})
