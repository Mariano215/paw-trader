import { describe, it, expect } from 'vitest'
import { computeExits, type ExitInputs } from './exit-calculator.js'

const base: ExitInputs = {
  side: 'buy',
  entryPrice: 100,
  horizonDays: 20,
  enrichment: null,
}

describe('computeExits', () => {
  it('uses the fixed percent band when enrichment is null (buy)', () => {
    const r = computeExits(base)
    // Default stop 8% below, target 16% above (2R), for a long.
    expect(r.stopLoss).toBeCloseTo(92, 5)
    expect(r.takeProfit).toBeCloseTo(116, 5)
    expect(r.timeStopDays).toBe(20)
    expect(r.basis).toBe('percent')
  })

  it('mirrors the band for a short (sell)', () => {
    const r = computeExits({ ...base, side: 'sell' })
    expect(r.stopLoss).toBeCloseTo(108, 5)
    expect(r.takeProfit).toBeCloseTo(84, 5)
    expect(r.basis).toBe('percent')
  })

  it('uses a wider, volatility-scaled stop when window range is present', () => {
    // window range 80..120 around price 100 -> rangePct = 40/100 = 0.40
    // volStopPct = clamp(0.40 * 0.5, 0.06, 0.20) = 0.20 (wide, not tight)
    const r = computeExits({
      ...base,
      enrichment: JSON.stringify({
        price_current: 100,
        window_high: 120,
        window_low: 80,
      }),
    })
    expect(r.stopLoss).toBeCloseTo(80, 5)   // 100 * (1 - 0.20)
    expect(r.takeProfit).toBeCloseTo(140, 5) // 2R: 100 + 2*20
    expect(r.basis).toBe('volatility')
  })

  it('floors the volatility stop so a flat window never produces a tight stop', () => {
    // window range 99..101 -> rangePct 0.02 -> 0.02*0.5=0.01 -> floored to 0.06
    const r = computeExits({
      ...base,
      enrichment: JSON.stringify({ price_current: 100, window_high: 101, window_low: 99 }),
    })
    expect(r.stopLoss).toBeCloseTo(94, 5)   // floored 6%
    expect(r.takeProfit).toBeCloseTo(112, 5) // 2R
    expect(r.basis).toBe('volatility')
  })

  it('caps the volatility stop at 20% so a blown-out range never risks the book', () => {
    const r = computeExits({
      ...base,
      enrichment: JSON.stringify({ price_current: 100, window_high: 300, window_low: 10 }),
    })
    expect(r.stopLoss).toBeCloseTo(80, 5)   // capped 20%
    expect(r.basis).toBe('volatility')
  })

  it('falls back to percent when entryPrice is not positive', () => {
    const r = computeExits({ ...base, entryPrice: 0 })
    expect(r.stopLoss).toBeNull()
    expect(r.takeProfit).toBeNull()
    expect(r.timeStopDays).toBe(20)
    expect(r.basis).toBe('none')
  })

  it('falls back to percent band when enrichment JSON is malformed', () => {
    const r = computeExits({ ...base, enrichment: '{not json' })
    expect(r.stopLoss).toBeCloseTo(92, 5)
    expect(r.basis).toBe('percent')
  })

  it('rounds prices to the penny', () => {
    const r = computeExits({ ...base, entryPrice: 33.333 })
    expect(r.stopLoss).toBe(30.67)   // 33.333*0.92 = 30.66636 -> 30.67
    expect(r.takeProfit).toBe(38.67) // 33.333*1.16 = 38.66628 -> 38.67
  })

  it('defaults a missing/zero horizon to the fallback time stop', () => {
    const r = computeExits({ ...base, horizonDays: 0 })
    expect(r.timeStopDays).toBe(10)
  })
})
