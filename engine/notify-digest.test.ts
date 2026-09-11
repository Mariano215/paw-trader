import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import {
  isTraderIssue,
  makeDigestingSend,
  shouldFireDigest,
  renderDigest,
  maybeFireTraderDigest,
  readLastDigestMs,
} from './notify-digest.js'
import { renderProgressReport, type ProgressSnapshot } from './progress-monitor.js'

describe('isTraderIssue', () => {
  it('flags real problems as instant', () => {
    expect(isTraderIssue('TRADER ALERT: Engine reconciler halted. Reason: drift')).toBe(true)
    expect(isTraderIssue('TRADER: Engine unreachable for 10 min. SSH restart issued')).toBe(true)
    expect(isTraderIssue('TRADER ALERT: Signal x rejected by engine and will not retry')).toBe(true)
  })
  it('lets the weekly report through instantly', () => {
    expect(isTraderIssue('Paw Trader Weekly Report\nReport: /tmp/x.html')).toBe(true)
  })
  it('treats trades and recoveries as routine (buffered)', () => {
    expect(isTraderIssue('EXECUTED: BUY QQQ $200 @ market')).toBe(false)
    expect(isTraderIssue('SKIPPED: SELL IWM (committee abstained)')).toBe(false)
    expect(isTraderIssue('TRADER: Reconciler auto-healed. Trading resumed.')).toBe(false)
  })
  it('treats the real daily readiness report as routine (buffered), not an instant issue', () => {
    // Regression for Task 5 fix round 1: the readiness text goes through
    // checkPaperProgress's `send`, which is makeDigestingSend's wrapped
    // function. If a future wording change trips TRADER_ISSUE_RE or
    // isUrgent(), this report would jump the daily/twice-daily digest and
    // page the operator instantly instead.
    const snapshot: ProgressSnapshot = {
      checked_at: Date.now(),
      mode: 'paper',
      broker_connected: false,
      halted: null,
      accounting_fresh: false,
      completed_entries: 234,
      realized_recorded_fees: -966.46,
      uncertain_exits: 0,
      active_strategies: ['mean-reversion-stocks'],
      paused_strategies: ['momentum-crypto'],
      gate_evaluated_at: Date.now(),
      gate_current: false,
      blockers: [
        'Engine/broker connectivity is unknown or unavailable.',
        'Readiness evaluation is missing, stale or belongs to different strategy settings.',
        'positive_expectancy: expectancy -0.01100 (win rate 45.3%, avgWin 0.0161, avgLoss 0.0335)',
      ],
      schedule: 'Health/progress: every 5 minutes while the bot runs. Daily summary: 17:00 America/New_York.',
    }
    const text = renderProgressReport(snapshot, null)
    expect(isTraderIssue(text)).toBe(false)
  })
})

describe('shouldFireDigest', () => {
  const at = (h: number) => new Date(2026, 5, 30, h, 0, 0).getTime()
  it('fires only at the daily slots', () => {
    expect(shouldFireDigest(at(8), null)).toBe(true)
    expect(shouldFireDigest(at(20), null)).toBe(true)
    expect(shouldFireDigest(at(13), null)).toBe(false)
  })
  it('does not double-fire inside the min gap', () => {
    expect(shouldFireDigest(at(8) + 60_000, at(8))).toBe(false)
  })
})

describe('renderDigest', () => {
  it('lists a repeated routine line once', () => {
    const rows = [1, 2, 3].map(id => ({ id, text: 'Go-live gate: 3/8 criteria (234 closed round-trips)\nP&L: x', created_at: id }))
    const out = renderDigest(rows, new Date(2026, 5, 30, 8, 0).getTime())
    expect(out.split('Go-live gate').length - 1).toBe(1)
  })

  it('summarises trades in plain English with no tickers-only jargon', () => {
    const rows = [
      { id: 1, text: 'EXECUTED: BUY QQQ $200 @ market\nStrategy: momentum', created_at: 1 },
      { id: 2, text: 'EXECUTED: SELL IWM $200 @ market', created_at: 2 },
      { id: 3, text: 'SKIPPED: BUY EFA (committee abstained)', created_at: 3 },
      { id: 4, text: 'TRADER: Reconciler auto-healed. Trading resumed.', created_at: 4 },
    ]
    const out = renderDigest(rows, new Date(2026, 5, 30, 8, 0).getTime())
    expect(out).toContain('Bought: 1')
    expect(out).toContain('Nasdaq-100 fund')
    expect(out).toContain('Sold: 1')
    expect(out).toContain('small US companies fund')
    expect(out).toContain('Passed on 1 possible trade')
    expect(out).toContain('auto-healed')
    expect(out).not.toMatch(/—/) // no em-dash
  })
  it('says quiet when nothing buffered', () => {
    const out = renderDigest([], Date.now())
    expect(out).toContain('Quiet stretch')
  })
})

describe('makeDigestingSend + maybeFireTraderDigest', () => {
  let db: Database.Database
  beforeEach(() => {
    db = new Database(':memory:')
  })

  it('routes issues instantly and buffers routine', async () => {
    const sent: string[] = []
    const send = makeDigestingSend(db, async (t) => { sent.push(t) })
    await send('TRADER ALERT: halt')          // instant
    await send('EXECUTED: BUY SPY $200 @ market') // buffered
    expect(sent).toEqual(['TRADER ALERT: halt'])
    const n = db.prepare('SELECT count(*) c FROM trader_digest_buffer').get() as { c: number }
    expect(n.c).toBe(1)
  })

  it('drains the buffer once at a slot and clears it', async () => {
    const raw: string[] = []
    const send = makeDigestingSend(db, async (t) => { raw.push(t) })
    await send('EXECUTED: BUY SPY $200 @ market')
    const slot = new Date(2026, 5, 30, 20, 0).getTime()
    const r = await maybeFireTraderDigest({ db, send: async (t) => { raw.push(t) }, nowMs: slot })
    expect(r.fired).toBe(true)
    expect(r.count).toBe(1)
    expect(raw.some(t => t.includes('Bought: 1'))).toBe(true)
    const n = db.prepare('SELECT count(*) c FROM trader_digest_buffer').get() as { c: number }
    expect(n.c).toBe(0)
    expect(readLastDigestMs(db)).toBe(slot)
    // second fire in the same slot is suppressed by the min-gap guard
    const r2 = await maybeFireTraderDigest({ db, send: async () => {}, nowMs: slot + 1000 })
    expect(r2.fired).toBe(false)
  })

  it('skips the send entirely when the buffer is empty', async () => {
    const raw: string[] = []
    const slot = new Date(2026, 5, 30, 20, 0).getTime()
    const r = await maybeFireTraderDigest({ db, send: async (t) => { raw.push(t) }, nowMs: slot })
    expect(r.fired).toBe(false)
    expect(r.count).toBe(0)
    expect(raw).toEqual([])
    // the slot is still consumed so the tick loop does not re-check all hour
    expect(readLastDigestMs(db)).toBe(slot)
  })
})
