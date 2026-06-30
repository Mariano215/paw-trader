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
})
