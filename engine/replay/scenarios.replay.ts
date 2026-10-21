import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import bars from './fixtures/bars-2026.json' with { type: 'json' }
import aapl from './fixtures/signals-2026-07-aapl.json' with { type: 'json' }
import { FakeEngine } from './fake-engine.js'
import { replay, freshReplayDb } from './runner.js'
import { recoverAfterRestart } from '../trader-scheduler.js'
import type { Candidate } from '../types.js'

// vi.mock is hoisted per test file, so every *.replay.ts file declares it.
vi.mock('../earnings.js', async (orig) => ({ ...(await orig<typeof import('../earnings.js')>()), daysToEarnings: async () => null }))

beforeEach(() => vi.useFakeTimers({ toFake: ['Date'] }))
afterEach(() => vi.useRealTimers())
const engineFor = (signals: Candidate[]) => new FakeEngine({ bars: bars as never, signals, startingCash: 100_000, now: () => Date.now() })

describe('replay: bug scenarios', () => {
  it('stacking: July AAPL holds at most one position', async () => {
    const db = freshReplayDb(['momentum-stocks'])
    const e = engineFor(aapl as Candidate[])
    // The first submit fails, so that decision sits in retry_pending while later AAPL signals arrive.
    e.faults.submitThrows = 1
    const r = await replay({ db, engine: e, from: '2026-07-20', to: '2026-07-31' })
    expect(r.errors).toEqual(['warn: Engine submit transient failure, parking retry_pending: fake-engine: transient submit failure'])
    expect(r.maxOpenPerAsset.AAPL ?? 0).toBeLessThanOrEqual(1)
    // Broker side: every AAPL buy fill comes after the previous lot was sold.
    const sides = e.fills.filter(f => f.asset === 'AAPL').map(f => f.side)
    expect(sides.length).toBeGreaterThan(0)
    expect(sides.join(',')).not.toMatch(/buy,buy/)
  })

  it('late-day: a 15:56 signal is suppressed_stale the next morning and never ordered', async () => {
    const db = freshReplayDb(['momentum-stocks'])
    const sig = { id: 'late', strategy: 'momentum', asset: 'XLE', side: 'buy', raw_score: 0.9, horizon_days: 20,
      generated_at: Date.parse('2026-09-15T19:56:00Z') } as Candidate
    const e = engineFor([sig])
    const r = await replay({ db, engine: e, from: '2026-09-15', to: '2026-09-16' })
    expect(r.errors).toEqual([])
    const row = db.prepare("SELECT status FROM trader_signals WHERE id='late'").get() as { status: string } | undefined
    expect(row).toBeDefined()
    expect(row!.status).toBe('suppressed_stale')
    expect(e.fills.filter(f => f.asset === 'XLE')).toHaveLength(0)
  })

  // 2026-09-16: XLE and DBC trade through the prior close, so the bot's limit entries fill that day.
  it('cross-strategy: momentum and ibs on XLE the same day open one position', async () => {
    const db = freshReplayDb(['momentum-stocks', 'ibs-stocks'])
    const t = Date.parse('2026-09-16T13:41:00Z')
    const e = engineFor([
      { id: 'm', strategy: 'momentum', asset: 'XLE', side: 'buy', raw_score: 0.9, horizon_days: 20, generated_at: t },
      { id: 'i', strategy: 'ibs', asset: 'XLE', side: 'buy', raw_score: 0.5, horizon_days: 3, generated_at: t + 5000 },
    ] as Candidate[])
    // The momentum submit fails once, so its decision sits in retry_pending while the ibs signal is dispatched.
    e.faults.submitThrows = 1
    const r = await replay({ db, engine: e, from: '2026-09-16', to: '2026-09-16' })
    expect(r.errors).toEqual(['warn: Engine submit transient failure, parking retry_pending: fake-engine: transient submit failure'])
    expect(e.fills.filter(f => f.asset === 'XLE' && f.side === 'buy')).toHaveLength(1)
    expect(r.maxOpenPerAsset.XLE).toBe(1)
  })

  it('restart mid-submit: an order the broker took before the crash is tracked, not lost or resent', async () => {
    const db = freshReplayDb(['momentum-stocks'])
    const t = Date.parse('2026-09-16T13:41:00Z')
    const e = engineFor([{ id: 'r', strategy: 'momentum', asset: 'DBC', side: 'buy', raw_score: 0.9, horizon_days: 20, generated_at: t }] as Candidate[])
    let crashed = false
    const r = await replay({ db, engine: e, from: '2026-09-16', to: '2026-09-17', beforeTick: () => {
      // The broker took the order but the process died before the ACK was stored: the row is still 'submitting'.
      if (crashed || e.fills.length === 0) return
      crashed = true
      db.prepare("UPDATE trader_decisions SET status='submitting', engine_order_id=NULL WHERE signal_id='r'").run()
      db.prepare("UPDATE trader_signals SET status='dispatching' WHERE id='r'").run()
      recoverAfterRestart(db)
    } })
    expect(crashed).toBe(true)
    expect(r.errors).toEqual([])
    const buys = e.fills.filter(f => f.asset === 'DBC' && f.side === 'buy')
    expect(buys).toHaveLength(1)
    const d = db.prepare("SELECT id, status FROM trader_decisions WHERE signal_id='r'").all() as Array<{ id: string; status: string }>
    expect(d).toEqual([{ id: buys[0].decision_id, status: 'executed' }])
  })

  // s1 (1-bar horizon) fills 07-06 and its time stop sells at the 07-08 open. GET /orders then fails until
  // 07-09 09:44 ET, so no close-out sweep closes s1's parent: it stays 'executed' next to its filled exit.
  // s2 rebuilds AAPL on 07-09, the day after the exit fill, before the next close-out sweep runs.
  it('stale exit: a parent whose exit filled never exits a rebuilt position', async () => {
    const db = freshReplayDb(['momentum-stocks'])
    const sigs = [
      { id: 's1', strategy: 'momentum', asset: 'AAPL', side: 'buy', raw_score: 0.9, horizon_days: 1, generated_at: Date.parse('2026-07-06T13:41:00Z') },
      { id: 's2', strategy: 'momentum', asset: 'AAPL', side: 'buy', raw_score: 0.9, horizon_days: 20, generated_at: Date.parse('2026-07-09T13:41:00Z') },
    ] as Candidate[]
    const e = engineFor(sigs)
    const getOrders = e.getOrders.bind(e)
    e.getOrders = async () => {
      const now = Date.now()
      if (now >= Date.parse('2026-07-08T13:45:00Z') && now < Date.parse('2026-07-09T13:44:00Z')) throw new Error('fake-engine: orders unavailable')
      return getOrders()
    }
    const r = await replay({ db, engine: e, from: '2026-07-06', to: '2026-07-17' })
    expect(r.errors.length).toBeGreaterThan(0)
    expect(r.errors.filter(x => !x.includes('fake-engine: orders unavailable'))).toEqual([])
    const buys = e.fills.filter(f => f.asset === 'AAPL' && f.side === 'buy')
    expect(buys.map(f => f.date)).toEqual(['2026-07-06', '2026-07-09'])
    const sells = e.fills.filter(f => f.asset === 'AAPL' && f.side === 'sell')
    expect(sells.map(f => f.date)).toEqual(['2026-07-08']) // only s1's time stop; the 20-bar rebuild is still held on 07-17
    expect((await e.getPositions()).find(p => p.asset === 'AAPL')?.qty).toBe(buys[1].qty)
  })

  // Same s1 round trip; s2 arrives the morning s1's exit filled.
  it('same-day re-entry: a buy the day an exit filled is suppressed_same_day_reentry', async () => {
    const db = freshReplayDb(['momentum-stocks'])
    const sigs = [
      { id: 's1', strategy: 'momentum', asset: 'AAPL', side: 'buy', raw_score: 0.9, horizon_days: 1, generated_at: Date.parse('2026-07-06T13:41:00Z') },
      { id: 's2', strategy: 'momentum', asset: 'AAPL', side: 'buy', raw_score: 0.9, horizon_days: 20, generated_at: Date.parse('2026-07-08T13:41:00Z') },
    ] as Candidate[]
    const e = engineFor(sigs)
    const r = await replay({ db, engine: e, from: '2026-07-06', to: '2026-07-08' })
    expect(r.errors).toEqual([])
    expect(e.fills.filter(f => f.asset === 'AAPL').map(f => `${f.side} ${f.date}`)).toEqual(['buy 2026-07-06', 'sell 2026-07-08'])
    const row = db.prepare("SELECT status FROM trader_signals WHERE id='s2'").get() as { status: string } | undefined
    expect(row?.status).toBe('suppressed_same_day_reentry')
  })
})
