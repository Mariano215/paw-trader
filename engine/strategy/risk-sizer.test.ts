import { describe, it, expect } from 'vitest'
import { sizePosition } from './risk-sizer.js'

describe('fixed-fractional risk sizer', () => {
  it('sizes so stop distance * shares ~= 1% NAV', () => {
    // NAV 100k, 1% = $1000 risk. stop $0.2 => 5000 shares. entry $10 => $50k notional.
    // hardCeiling 1M and no-leverage clamp NAV (100k) -> 50k stands.
    const r = sizePosition({
      navUsd: 100_000, entryPrice: 10, stopDistanceDollars: 0.2,
      openRiskUsd: 0, hardCeilingUsd: 1_000_000,
    })
    expect(r.allow).toBe(true)
    expect(r.sizeUsd).toBeCloseTo(50_000, 2)
    expect(r.riskUsd).toBeCloseTo(1_000, 2)
  })

  it('clamps notional to the hard ceiling and lowers realized risk accordingly', () => {
    const r = sizePosition({
      navUsd: 100_000, entryPrice: 10, stopDistanceDollars: 0.2,
      openRiskUsd: 0, hardCeilingUsd: 1_000,
    })
    expect(r.sizeUsd).toBe(1_000)
    // realized shares = 100; realized risk = 100 * 0.2 = 20
    expect(r.riskUsd).toBeCloseTo(20, 2)
  })

  it('never uses leverage: notional capped at NAV', () => {
    const r = sizePosition({
      navUsd: 500, entryPrice: 10, stopDistanceDollars: 0.05,
      openRiskUsd: 0, hardCeilingUsd: 1_000_000,
    })
    expect(r.sizeUsd).toBeLessThanOrEqual(500)
  })

  it('refuses a new trade when portfolio heat budget is exhausted', () => {
    const r = sizePosition({
      navUsd: 100_000, entryPrice: 50, stopDistanceDollars: 5,
      openRiskUsd: 6_000, heatCapPct: 0.06, hardCeilingUsd: 1_000_000,
    })
    expect(r.allow).toBe(false)
    expect(r.sizeUsd).toBe(0)
    expect(r.reason).toContain('heat cap')
  })

  it('shrinks the trade to the remaining heat budget', () => {
    // budget 6000, open 5500 -> only 500 of risk left. entry 10, stop 0.2
    // shares = 500/0.2 = 2500, notional = 25000, clamp by NAV (100k)/ceiling (1M).
    const r = sizePosition({
      navUsd: 100_000, entryPrice: 10, stopDistanceDollars: 0.2,
      openRiskUsd: 5_500, heatCapPct: 0.06, hardCeilingUsd: 1_000_000,
    })
    expect(r.allow).toBe(true)
    expect(r.riskUsd).toBeLessThanOrEqual(500.01)
  })

  it('returns no-trade on unusable inputs (zero NAV, zero stop)', () => {
    expect(sizePosition({ navUsd: 0, entryPrice: 10, stopDistanceDollars: 1, openRiskUsd: 0 }).allow).toBe(false)
    expect(sizePosition({ navUsd: 100, entryPrice: 10, stopDistanceDollars: 0, openRiskUsd: 0 }).allow).toBe(false)
  })
})
