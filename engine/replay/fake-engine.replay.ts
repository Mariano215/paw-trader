import { describe, it, expect } from 'vitest'
import { FakeEngine, type OhlcBar } from './fake-engine.js'

const bar = (date: string, o: number, h: number, l: number, c: number): OhlcBar => ({ date, open: o, high: h, low: l, close: c })
const ms = (iso: string) => Date.parse(iso)

describe('FakeEngine', () => {
  const bars = { AAPL: [bar('2026-07-20', 100, 102, 99, 101), bar('2026-07-21', 103, 104, 98, 99), bar('2026-07-23', 90, 95, 89, 94)] }
  it('fills a market buy at the submit day open', async () => {
    let now = ms('2026-07-21T15:00:00Z')
    const e = new FakeEngine({ bars, signals: [], startingCash: 100_000, now: () => now })
    await e.submitDecision({ decision_id: 'd1', asset: 'AAPL', side: 'buy', size_usd: 1030, entry_type: 'market', entry_price: 0, strategy: 'momentum', confidence: 1 })
    e.settle()
    expect(e.fills[0]).toMatchObject({ price: 103, qty: 10, date: '2026-07-21' })
    expect((await e.getPositions())[0]).toMatchObject({ asset: 'AAPL', qty: 10 })
  })
  it('skips a gap: an order on a holiday fills at the next bar open', async () => {
    let now = ms('2026-07-22T15:00:00Z')
    const e = new FakeEngine({ bars, signals: [], startingCash: 100_000, now: () => now })
    await e.submitDecision({ decision_id: 'd2', asset: 'AAPL', side: 'buy', size_usd: 900, entry_type: 'market', entry_price: 0, strategy: 'momentum', confidence: 1 })
    e.settle()
    expect(e.fills).toHaveLength(0) // no bar dated 07-22 yet visible; fills when 07-23 opens
    now = ms('2026-07-23T15:00:00Z')
    e.settle()
    expect(e.fills).toHaveLength(1)
    expect(e.fills[0]).toMatchObject({ price: 90, qty: 10, date: '2026-07-23' })
  })
  it('a repeated decision id returns the same order', async () => {
    const e = new FakeEngine({ bars, signals: [], startingCash: 100_000, now: () => ms('2026-07-21T15:00:00Z') })
    const req = { decision_id: 'd3', asset: 'AAPL', side: 'buy' as const, size_usd: 1030, entry_type: 'market' as const, entry_price: 0, strategy: 'momentum', confidence: 1 }
    const a = await e.submitDecision(req); const b = await e.submitDecision(req)
    expect(b.client_order_id).toBe(a.client_order_id)
    expect((await e.getOrders()).length).toBe(1)
  })
  it('an exit with size_usd 0 closes the whole position', async () => {
    let now = ms('2026-07-20T15:00:00Z')
    const e = new FakeEngine({ bars, signals: [], startingCash: 100_000, now: () => now })
    await e.submitDecision({ decision_id: 'b', asset: 'AAPL', side: 'buy', size_usd: 1000, entry_type: 'market', entry_price: 0, strategy: 'momentum', confidence: 1 })
    e.settle(); now = ms('2026-07-21T15:00:00Z')
    await e.submitDecision({ decision_id: 'x', asset: 'AAPL', side: 'sell', size_usd: 0, entry_type: 'market', entry_price: 0, strategy: 'exit', confidence: 1 })
    e.settle()
    expect(await e.getPositions()).toEqual([])
  })
  it('never returns a bar dated after now', async () => {
    const e = new FakeEngine({ bars, signals: [], startingCash: 100_000, now: () => ms('2026-07-21T15:00:00Z') })
    const p = await e.getPrices('AAPL', 0, ms('2026-12-31T00:00:00Z'))
    expect(p.map(x => x.date)).toEqual(['2026-07-20'])
  })
  it('getNav returns the day_open snapshot, not the live mark', async () => {
    let now = ms('2026-07-20T14:00:00Z')
    const e = new FakeEngine({ bars, signals: [], startingCash: 100_000, now: () => now })
    await e.submitDecision({ decision_id: 'n', asset: 'AAPL', side: 'buy', size_usd: 1000, entry_type: 'market', entry_price: 0, strategy: 'momentum', confidence: 1 })
    expect(await e.getNav()).toBeNull()
    e.recordNav('day_open')
    expect(await e.getNav()).toBe(100_000)
    now = ms('2026-07-21T14:00:00Z')
    expect(e.nav()).toBe(100_030)
    expect(await e.getNav()).toBe(100_000)
  })
  it('when unreachable, getHealth and getNav return null and other methods throw', async () => {
    const now = ms('2026-07-21T15:00:00Z')
    const e = new FakeEngine({ bars, signals: [], startingCash: 100_000, now: () => now })
    e.recordNav('day_open')
    e.faults.unreachableUntil = now + 1
    expect(await e.getHealth()).toBeNull()
    expect(await e.getNav()).toBeNull()
    await expect(e.getPositions()).rejects.toThrow('fake-engine: unreachable')
    e.faults.unreachableUntil = 0
    expect(await e.getHealth()).toMatchObject({ status: 'ok' })
    expect(await e.getNav()).toBe(100_000)
  })
  it('a sell larger than the position throws instead of opening a short', async () => {
    let now = ms('2026-07-20T15:00:00Z')
    const e = new FakeEngine({ bars, signals: [], startingCash: 100_000, now: () => now })
    await e.submitDecision({ decision_id: 'b', asset: 'AAPL', side: 'buy', size_usd: 1000, entry_type: 'market', entry_price: 0, strategy: 'momentum', confidence: 1 })
    now = ms('2026-07-21T15:00:00Z')
    await expect(e.submitDecision({ decision_id: 's', asset: 'AAPL', side: 'sell', size_usd: 2060, entry_type: 'market', entry_price: 0, strategy: 'exit', confidence: 1 }))
      .rejects.toThrow('fake-engine: oversize sell')
    expect((await e.getPositions())[0]).toMatchObject({ qty: 10 })
  })
  it('a buy with size_usd 0 throws', async () => {
    const e = new FakeEngine({ bars, signals: [], startingCash: 100_000, now: () => ms('2026-07-21T15:00:00Z') })
    await expect(e.submitDecision({ decision_id: 'z', asset: 'AAPL', side: 'buy', size_usd: 0, entry_type: 'market', entry_price: 0, strategy: 'momentum', confidence: 1 }))
      .rejects.toThrow('fake-engine: buy AAPL needs size_usd > 0')
  })
  it('a buy whose target sits at or below the live price is refused like the engine (invalid_protection_prices)', async () => {
    const e = new FakeEngine({ bars, signals: [], startingCash: 100_000, now: () => ms('2026-07-21T15:00:00Z') })
    await expect(e.submitDecision({ decision_id: 'p', asset: 'AAPL', side: 'buy', size_usd: 1000, entry_type: 'limit', entry_price: 0, stop_loss: 1, take_profit: 2, strategy: 'momentum', confidence: 1 }))
      .rejects.toThrow('Engine API error 422 on /decisions :: invalid_protection_prices')
    expect(e.fills).toHaveLength(0)
  })
  it('a buy limit fills at min(open, limit) when the low touches it', async () => {
    const e = new FakeEngine({ bars, signals: [], startingCash: 100_000, now: () => ms('2026-07-21T15:00:00Z') })
    await e.submitDecision({ decision_id: 'l', asset: 'AAPL', side: 'buy', size_usd: 1000, entry_type: 'limit', entry_price: 100, strategy: 'mr', confidence: 1 })
    expect(e.fills[0]).toMatchObject({ price: 100, qty: 10, date: '2026-07-21' })
  })
  it('a buy limit the low never touches expires after the close', async () => {
    let now = ms('2026-07-21T15:00:00Z')
    const e = new FakeEngine({ bars, signals: [], startingCash: 100_000, now: () => now })
    const r = await e.submitDecision({ decision_id: 'u', asset: 'AAPL', side: 'buy', size_usd: 1000, entry_type: 'limit', entry_price: 95, strategy: 'mr', confidence: 1 })
    expect(r.status).toBe('accepted')
    now = ms('2026-07-21T21:00:00Z')
    e.settle()
    expect((await e.getOrders())[0].status).toBe('expired')
    expect(e.fills).toHaveLength(0)
  })
  it('submitThrows and submit4xx each fail one submit, then submits recover', async () => {
    const e = new FakeEngine({ bars, signals: [], startingCash: 100_000, now: () => ms('2026-07-21T15:00:00Z') })
    const req = { decision_id: 'f', asset: 'AAPL', side: 'buy' as const, size_usd: 1030, entry_type: 'market' as const, entry_price: 0, strategy: 'momentum', confidence: 1 }
    e.faults.submitThrows = 1
    await expect(e.submitDecision(req)).rejects.toThrow('fake-engine: transient submit failure')
    e.faults.submit4xx = 1
    await expect(e.submitDecision(req)).rejects.toThrow('Engine API error 422')
    expect((await e.submitDecision(req)).status).toBe('filled')
    expect(e.fills).toHaveLength(1)
  })
  it('getReconcileLast reports a clean reconcile and throws when unreachable; getMarkovRegime is null', async () => {
    const now = ms('2026-07-21T15:00:00Z')
    const e = new FakeEngine({ bars, signals: [], startingCash: 1, now: () => now })
    expect(await e.getReconcileLast()).toMatchObject({ ran_at: now, drift_detected: false })
    expect(await e.getMarkovRegime('AAPL')).toBeNull()
    e.faults.unreachableUntil = now + 1
    await expect(e.getReconcileLast()).rejects.toThrow('fake-engine: unreachable')
  })
  it('backtest methods return empty evidence, never a Sharpe', async () => {
    const e = new FakeEngine({ bars, signals: [], startingCash: 1, now: () => ms('2026-07-21T15:00:00Z') })
    expect((await e.getBacktestReport()).strategies).toEqual({})
    expect(await e.getMomentumBacktest()).toMatchObject({ n_trades: 0, sharpe: null, warnings: ['fake-engine: replay has no backtest'] })
  })
  it('throws on an unsupported method', () => {
    const e = new FakeEngine({ bars, signals: [], startingCash: 1, now: () => 0 }) as unknown as Record<string, () => unknown>
    expect(() => e.haltEngine()).toThrow('fake-engine: haltEngine not supported')
  })
  it('the proxy stays inspectable: probes return undefined and awaited results resolve', async () => {
    const e = new FakeEngine({ bars, signals: [], startingCash: 1, now: () => ms('2026-07-21T15:00:00Z') })
    const r = e as unknown as Record<string, unknown>
    expect(r.then).toBeUndefined()
    expect(r.toJSON).toBeUndefined()
    expect(r.asymmetricMatch).toBeUndefined()
    expect(await e).toBe(e)
    expect(await e.getHealth()).toMatchObject({ status: 'ok' })
    expect(e).toMatchObject({ fills: [] })
  })
  it('marks visit the bar low then high intraday', async () => {
    const at = (iso: string, b: OhlcBar) => {
      const e = new FakeEngine({ bars: { AAPL: [b] }, signals: [], startingCash: 100_000, now: () => ms(iso) })
      return (e as any).mark('AAPL') as number
    }
    const times = ['14:00', '15:30', '17:30', '19:30', '20:05'].map(t => `2026-07-21T${t}:00Z`)
    const up = bar('2026-07-21', 100, 110, 90, 105)
    const down = bar('2026-07-21', 100, 108, 92, 95)
    const prior = bar('2026-07-20', 97, 99, 96, 98)
    const two = (iso: string) => (new FakeEngine({ bars: { AAPL: [prior, up] }, signals: [], startingCash: 1, now: () => ms(iso) }) as any).mark('AAPL') as number
    expect(two('2026-07-21T13:00:00Z')).toBe(98) // 09:00 ET, previous close
    expect(two('2026-07-21T13:30:00Z')).toBe(100) // 09:30 ET exactly, open
    expect(times.map(t => at(t, up))).toEqual([100, 90, 110, 105, 105])
    expect(times.map(t => at(t, down))).toEqual([100, 92, 108, 95, 95])
  })
})
