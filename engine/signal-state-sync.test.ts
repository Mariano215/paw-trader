import { describe, it, expect } from 'vitest'
import Database from 'better-sqlite3'
import { initTraderTables } from './db.js'
import { syncSignalStatuses } from './signal-state-sync.js'

/**
 * Regression suite for the Jun 9 2026 pipeline freeze: a transient engine
 * failure parked a decision at retry_pending and left its signal at
 * 'dispatching' (by design). The retry sweep later resubmitted and the
 * reconciler promoted the DECISION to executed, but nothing ever flipped the
 * SIGNAL -- and the partial unique index on (asset, side) WHERE status IN
 * ('pending','dispatching') then blocked every new signal for that asset+side
 * until the next bot reboot. syncSignalStatuses heals that every tick.
 */

const NOW = 1_900_000_000_000
const OLD = NOW - 60 * 60 * 1000 // 1h ago, past the reclaim grace

function makeDb() {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON') // prod parity
  initTraderTables(db)
  db.prepare(`INSERT INTO trader_strategies (id,name,asset_class,tier,status,params_json,created_at,updated_at)
    VALUES ('momentum-stocks','M','equity',1,'active','{}',?,?)`).run(NOW, NOW)
  return db
}

function seedSignal(db: Database.Database, id: string, status: string, asset = 'SPY', generatedAt = OLD) {
  db.prepare(`INSERT INTO trader_signals (id,strategy_id,asset,side,raw_score,horizon_days,generated_at,status)
    VALUES (?,?,?,?,0.8,20,?,?)`).run(id, 'momentum-stocks', asset, 'buy', generatedAt, status)
}

function seedDecision(db: Database.Database, id: string, signalId: string, status: string, parent: string | null = null) {
  db.prepare(`INSERT INTO trader_decisions
    (id,signal_id,parent_decision_id,action,asset,size_usd,entry_type,thesis,confidence,decided_at,status)
    VALUES (?,?,?,?,'SPY',100,'market','t',0.7,?,?)`).run(id, signalId, parent, 'buy', OLD, status)
}

function status(db: Database.Database, id: string): string {
  return (db.prepare('SELECT status FROM trader_signals WHERE id=?').get(id) as { status: string }).status
}

describe('syncSignalStatuses', () => {
  it('promotes dispatching -> executed when the decision is executed (the Jun 9 freeze)', () => {
    const db = makeDb()
    seedSignal(db, 's1', 'dispatching')
    seedDecision(db, 'd1', 's1', 'executed')
    const out = syncSignalStatuses(db, NOW)
    expect(status(db, 's1')).toBe('executed')
    expect(out.toExecuted).toBe(1)
    // The asset+side slot is freed: a new pending signal can be inserted.
    expect(() => seedSignal(db, 's1b', 'pending', 'SPY', NOW)).not.toThrow()
  })

  it('promotes submitted/pending_fill decisions to signal submitted', () => {
    const db = makeDb()
    seedSignal(db, 's1', 'dispatching')
    seedDecision(db, 'd1', 's1', 'submitted')
    seedSignal(db, 's2', 'dispatching', 'QQQ')
    seedDecision(db, 'd2', 's2', 'pending_fill')
    const out = syncSignalStatuses(db, NOW)
    expect(status(db, 's1')).toBe('submitted')
    expect(status(db, 's2')).toBe('submitted')
    expect(out.toSubmitted).toBe(2)
  })

  it('promotes signal submitted -> executed once the decision fills', () => {
    const db = makeDb()
    seedSignal(db, 's1', 'submitted')
    seedDecision(db, 'd1', 's1', 'executed')
    const out = syncSignalStatuses(db, NOW)
    expect(status(db, 's1')).toBe('executed')
    expect(out.toExecuted).toBe(1)
  })

  it('fails the signal when every decision failed', () => {
    const db = makeDb()
    seedSignal(db, 's1', 'dispatching')
    seedDecision(db, 'd1', 's1', 'failed')
    const out = syncSignalStatuses(db, NOW)
    expect(status(db, 's1')).toBe('failed')
    expect(out.toFailed).toBe(1)
  })

  it('leaves dispatching alone while the decision is retry_pending or engine_down (in-flight block is correct)', () => {
    const db = makeDb()
    seedSignal(db, 's1', 'dispatching')
    seedDecision(db, 'd1', 's1', 'retry_pending')
    seedSignal(db, 's2', 'dispatching', 'QQQ')
    seedDecision(db, 'd2', 's2', 'engine_down')
    syncSignalStatuses(db, NOW)
    expect(status(db, 's1')).toBe('dispatching')
    expect(status(db, 's2')).toBe('dispatching')
  })

  it('reclaims dispatching -> pending when no decision row exists and the grace period passed', () => {
    const db = makeDb()
    seedSignal(db, 's1', 'dispatching') // OLD, no decision row: crashed mid-claim
    const out = syncSignalStatuses(db, NOW)
    expect(status(db, 's1')).toBe('pending')
    expect(out.reclaimedPending).toBe(1)
  })

  it('does NOT reclaim a freshly claimed dispatching signal (inside grace)', () => {
    const db = makeDb()
    seedSignal(db, 's1', 'dispatching', 'SPY', NOW - 1000)
    syncSignalStatuses(db, NOW)
    expect(status(db, 's1')).toBe('dispatching')
  })

  it('ignores exit rows (parent_decision_id set) when judging the entry decision state', () => {
    const db = makeDb()
    seedSignal(db, 's1', 'dispatching')
    seedDecision(db, 'd1', 's1', 'executed')
    // Exit row shares signal_id but must not confuse the mapping.
    seedDecision(db, 'd1-exit', 's1', 'exit_submitted', 'd1')
    const out = syncSignalStatuses(db, NOW)
    expect(status(db, 's1')).toBe('executed')
    expect(out.toExecuted).toBe(1)
  })

  it('is a no-op on terminal signal states', () => {
    const db = makeDb()
    seedSignal(db, 's1', 'executed')
    seedDecision(db, 'd1', 's1', 'failed')
    const out = syncSignalStatuses(db, NOW)
    expect(status(db, 's1')).toBe('executed')
    expect(out.toFailed).toBe(0)
  })
})
