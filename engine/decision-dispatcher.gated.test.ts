import { describe, it, expect, vi } from 'vitest'
import Database from 'better-sqlite3'
import { initTraderTables } from './db.js'
// Pin the equity session check open so this suite does not change after 16:00 ET.
vi.mock('./signal-poller.js', async () => {
  const actual = await vi.importActual<typeof import('./signal-poller.js')>('./signal-poller.js')
  return { ...actual, isEquityMarketHours: vi.fn(() => true) }
})
import { autoDispatchPendingSignals } from './decision-dispatcher.js'
import { CommitteeGatedError, runCommittee as runRealCommittee, type CommitteeResult } from './committee.js'

/**
 * Regression for the Jun 8-11 2026 dashboard outage: runAgent refused every
 * call (kill switch fail-closed), the committee recorded the refusal text as
 * a specialist parse failure, abstained on quorum, and the dispatcher
 * suppressed real signals as committee_abstain for 24h -- 78/78 on Jun 10.
 *
 * Contract now: a CommitteeGatedError leaves the signal PENDING (no
 * suppression row, no transcript) and halts the dispatch loop for the tick.
 */

const NOW = Date.now()

function makeDb() {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  initTraderTables(db)
  db.prepare(`INSERT INTO trader_strategies (id,name,asset_class,tier,status,params_json,created_at,updated_at)
    VALUES ('momentum-stocks','Momentum','equity',1,'active','{}',?,?)`).run(NOW, NOW)
  return db
}

function seedPending(db: Database.Database, id: string, asset: string) {
  db.prepare(`INSERT INTO trader_signals (id,strategy_id,asset,side,raw_score,horizon_days,generated_at,status)
    VALUES (?,?,?,'buy',0.9,20,?,'pending')`).run(id, 'momentum-stocks', asset, NOW)
}

describe('autoDispatchPendingSignals under a gate refusal', () => {
  it('leaves signals pending, records no suppression, and halts the loop', async () => {
    const db = makeDb()
    seedPending(db, 'sig-a', 'SPY')
    seedPending(db, 'sig-b', 'QQQ')

    const runCommittee = vi.fn().mockRejectedValue(new CommitteeGatedError('kill-switch active'))
    const engine = {getPositions: vi.fn().mockResolvedValue([])} as never
    const results = await autoDispatchPendingSignals(db, {
      send: vi.fn().mockResolvedValue(undefined),
      alertOnReject: false,
      runCommittee: runCommittee as unknown as (...args: unknown[]) => Promise<CommitteeResult>,
      runAgent: vi.fn() as never,
    } as never, engine)

    // Loop halted after the FIRST gated refusal -- not one call per signal.
    expect(runCommittee).toHaveBeenCalledTimes(1)
    expect(results).toEqual([])

    // Both signals are pending again (none suppressed, none failed).
    const statuses = db.prepare('SELECT id, status FROM trader_signals ORDER BY id').all() as Array<{ id: string; status: string }>
    expect(statuses.every((s) => s.status === 'pending')).toBe(true)

    // No suppression rows were recorded.
    const sup = db.prepare('SELECT COUNT(*) AS c FROM trader_signal_suppressions').get() as { c: number }
    expect(sup.c).toBe(0)
  })

  it('a signal held pending past the max age is suppressed as stale, not dispatched', async () => {
    const db = makeDb()
    seedPending(db, 'sig-old', 'SPY')
    db.prepare('UPDATE trader_signals SET generated_at = ? WHERE id = ?').run(NOW - 25 * 3600_000, 'sig-old')

    const runCommittee = vi.fn()
    const engine = {getPositions: vi.fn().mockResolvedValue([])} as never
    await autoDispatchPendingSignals(db, {
      send: vi.fn().mockResolvedValue(undefined),
      alertOnReject: false,
      runCommittee: runCommittee as unknown as (...args: unknown[]) => Promise<CommitteeResult>,
      runAgent: vi.fn() as never,
    } as never, engine)

    expect(runCommittee).not.toHaveBeenCalled()
    const row = db.prepare('SELECT status FROM trader_signals WHERE id = ?').get('sig-old') as { status: string }
    expect(row.status).toBe('suppressed_stale')
  })

  it('a non-gated committee throw still re-queues just that signal and continues', async () => {
    const db = makeDb()
    seedPending(db, 'sig-a', 'SPY')
    seedPending(db, 'sig-b', 'QQQ')

    const runCommittee = vi.fn().mockRejectedValue(new Error('LLM timeout'))
    const engine = {getPositions: vi.fn().mockResolvedValue([])} as never
    await autoDispatchPendingSignals(db, {
      send: vi.fn().mockResolvedValue(undefined),
      alertOnReject: false,
      runCommittee: runCommittee as unknown as (...args: unknown[]) => Promise<CommitteeResult>,
      runAgent: vi.fn() as never,
    } as never, engine)

    // Plain errors keep iterating: both signals attempted.
    expect(runCommittee).toHaveBeenCalledTimes(2)
    const statuses = db.prepare('SELECT status FROM trader_signals').all() as Array<{ status: string }>
    expect(statuses.every((s) => s.status === 'pending')).toBe(true)
  })

  it('a committee that throws twice for one signal marks it failed instead of rerunning every tick', async () => {
    const db = makeDb()
    seedPending(db, 'sig-a', 'SPY')
    const runCommittee = vi.fn().mockRejectedValue(new Error('LLM timeout'))
    const engine = {getPositions: vi.fn().mockResolvedValue([])} as never
    const deps = {
      send: vi.fn().mockResolvedValue(undefined),
      alertOnReject: false,
      runCommittee: runCommittee as unknown as (...args: unknown[]) => Promise<CommitteeResult>,
      runAgent: vi.fn() as never,
    } as never

    for (let tick = 0; tick < 4; tick++) await autoDispatchPendingSignals(db, deps, engine)

    expect(runCommittee).toHaveBeenCalledTimes(2)
    const row = db.prepare('SELECT status FROM trader_signals WHERE id = ?').get('sig-a') as { status: string }
    expect(row.status).toBe('failed')
    const ev = db.prepare("SELECT metadata_json FROM trader_operational_events WHERE signal_id = ? AND event_type = 'committee.run.failed' LIMIT 1").get('sig-a') as { metadata_json: string }
    expect(JSON.parse(ev.metadata_json).reason).toBe('LLM-timeout')
  })
})

describe('runCommittee surfaces gate refusals as CommitteeGatedError', () => {
  it('throws (instead of recording a parse failure) when runAgent refused', async () => {
    const refused = {
      text: 'System is paused. Kill switch tripped: dashboard unreachable.',
      emptyReason: 'kill-switch active: dashboard unreachable',
      resultSubtype: 'refused',
      eventCount: 0,
      assistantTurns: 0,
      toolUses: 0,
      durationSec: 0,
    }
    const runAgent = vi.fn().mockResolvedValue(refused)
    await expect(
      runRealCommittee(
        // Non-index asset -> full specialist path (no deterministic gate).
        { id: 'sig-1', asset: 'XYZ', side: 'buy', raw_score: 0.9, horizon_days: 20, enrichment_json: null },
        { runAgent: runAgent as never, defaultSizeUsd: 200, maxSizeUsd: 2500, loadPrompt: () => 'prompt' },
      ),
    ).rejects.toBeInstanceOf(CommitteeGatedError)
  })
})
