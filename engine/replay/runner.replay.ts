import { describe, it, expect, vi, afterEach } from 'vitest'
import { FakeEngine, type OhlcBar } from './fake-engine.js'
import { replay, freshReplayDb } from './runner.js'
import { isEquityMarketHours } from '../signal-poller.js'

// vi.mock is hoisted per test file, so every *.replay.ts file declares it.
vi.mock('../earnings.js', async (orig) => ({ ...(await orig<typeof import('../earnings.js')>()), daysToEarnings: async () => null }))

const nyDate = (ms: number) => new Date(ms).toLocaleDateString('en-CA', { timeZone: 'America/New_York' })

// 40 weekdays of gently rising bars ending 2026-07-24, enough history for enrichment and exit lookbacks.
function bars(base: number): OhlcBar[] {
  const out: OhlcBar[] = []
  for (let t = Date.parse('2026-05-25T12:00:00Z'); t <= Date.parse('2026-07-24T12:00:00Z'); t += 86_400_000) {
    const d = new Date(t)
    if (d.getUTCDay() === 0 || d.getUTCDay() === 6) continue
    const p = base + out.length * 0.5
    out.push({ date: d.toISOString().slice(0, 10), open: p, high: p + 1, low: p - 1, close: p + 0.3 })
  }
  return out
}

// AAPL near $300: the bot must size the order so whole-share fills still happen.
describe('replay runner', () => {
  afterEach(() => { vi.useRealTimers() })

  it('drives the real tick through a week and fills a momentum buy', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(Date.parse('2026-07-20T04:00:00Z'))
    const db = freshReplayDb(['momentum-stocks'])
    const engine = new FakeEngine({
      bars: { AAPL: bars(300), SPY: bars(600) },
      signals: [{ id: 'sig-aapl-1', strategy: 'momentum', asset: 'AAPL', side: 'buy', raw_score: 0.83, horizon_days: 20,
        generated_at: Date.parse('2026-07-21T13:41:00Z') }],
      startingCash: 100_000,
      now: () => Date.now(),
    })
    const tickTimes: number[] = []
    const r = await replay({ db, engine, from: '2026-07-20', to: '2026-07-25', beforeTick: (t) => { tickTimes.push(t) } })

    expect(r.ticks).toBeGreaterThan(0)
    expect(r.ticks).toBe(tickTimes.length)
    expect(r.errors).toEqual([])
    // Every tick is in session, or the single after-close tick of a trading day.
    const closeTicks = tickTimes.filter(t => !isEquityMarketHours(t))
    expect(closeTicks.map(nyDate)).toEqual(['2026-07-20', '2026-07-21', '2026-07-22', '2026-07-23', '2026-07-24'])
    expect(tickTimes.some(t => nyDate(t) === '2026-07-25')).toBe(false)

    const aapl = r.decisions.filter(d => d.asset === 'AAPL' && d.action === 'buy')
    expect(aapl.length).toBeGreaterThan(0)
    expect(r.decisions.some(d => nyDate(d.decided_at) === '2026-07-25')).toBe(false)
    expect(engine.fills.some(f => f.asset === 'AAPL' && f.side === 'buy')).toBe(true)
    expect(engine.fills.find(f => f.asset === 'AAPL')!.price).toBeGreaterThan(300)
    expect(r.maxOpenPerAsset.AAPL).toBe(1)
  })
})
