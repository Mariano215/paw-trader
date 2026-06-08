import { describe, it, expect } from 'vitest'
import { computeRiskBasedSize, deriveStopPrice, MAX_PORTFOLIO_HEAT_PCT, DEFAULT_STOP_DISTANCE_PCT } from './risk-sizing.js'
import type { EnginePosition } from './types.js'

function pos(mv: number): EnginePosition {
  return { asset: 'X', qty: 1, avg_entry_price: mv, market_value: mv, unrealized_pnl: 0, source: 't', updated_at: 0 }
}

describe('risk-based sizing', () => {
  it('sizes off risk% and stop distance', () => {
    // nav 10000, risk 1% = $100 risk, stop 8% -> size 100 / 0.08 = 1250, capped at 2000
    const r = computeRiskBasedSize({ nav: 10000, positions: [], capUsd: 2000, floorUsd: 50 })
    expect(r.sizeUsd).toBe(1250)
    expect(r.riskUsd).toBe(100)
  })

  it('clamps to the per-strategy cap', () => {
    const r = computeRiskBasedSize({ nav: 10000, positions: [], capUsd: 500, floorUsd: 50 })
    expect(r.sizeUsd).toBe(500)
  })

  it('blocks new risk when portfolio heat is at the ceiling', () => {
    // committed heat = market_value * stop 8%. To hit 6% of 10000 = $600 heat,
    // need market_value 600 / 0.08 = 7500.
    const r = computeRiskBasedSize({ nav: 10000, positions: [pos(7500)], capUsd: 2000, floorUsd: 50 })
    expect(r.riskUsd).toBe(0)
    expect(r.sizeUsd).toBe(0)
  })

  it('falls back to the floor when NAV is unavailable', () => {
    const r = computeRiskBasedSize({ nav: null, positions: [], capUsd: 2000, floorUsd: 50 })
    expect(r.sizeUsd).toBe(50)
  })

  it('derives a buy-side stop below entry', () => {
    expect(deriveStopPrice(100, 0.08)).toBe(92)
  })

  it('reports heatBeforePct correctly', () => {
    // market_value 1000, stop 8% -> heat 80. nav 10000 -> heatBeforePct 0.0080
    const r = computeRiskBasedSize({ nav: 10000, positions: [pos(1000)], capUsd: 2000, floorUsd: 50 })
    expect(r.heatBeforePct).toBe(0.008)
    // headroom: ceiling 600 - 80 = 520 heat left -> riskUsd = min(100, 520) = 100 -> size = 1250
    expect(r.sizeUsd).toBe(1250)
  })

  it('heat ceiling constant is 6%', () => {
    expect(MAX_PORTFOLIO_HEAT_PCT).toBe(0.06)
  })

  it('stop distance constant is 8%', () => {
    expect(DEFAULT_STOP_DISTANCE_PCT).toBe(0.08)
  })

  it('near-full-heat headroom: floor does not floor UP past remaining heat budget', () => {
    // nav=10000, heat ceiling=600. Position mv=7400 -> heat=592. headroom=8.
    // riskUsd=min(100,8)=8. sizeUsd=8/0.08=100 -- headroom-limited.
    // floor=200: 200*0.08=$16 risk which exceeds the $8 headroom -> must NOT floor up.
    // Expected: sizeUsd=100, which is the headroom-derived size without the floor.
    const r = computeRiskBasedSize({
      nav: 10000,
      positions: [pos(7400)],
      capUsd: 2000,
      floorUsd: 200,
    })
    // The floor must only apply when the risk-derived size is >= floor.
    // Here riskUsd/stopPct = 8/0.08 = 100 < 200, so no floor. sizeUsd = 100.
    expect(r.sizeUsd).toBe(100)
    // Verify the heat budget is not breached: heat added = sizeUsd * stopPct = 100 * 0.08 = 8
    // existing heat = 7400 * 0.08 = 592. total = 600 = exactly ceiling, not over.
    expect(r.riskUsd).toBe(8)
  })

  it('cap always wins over floor: floor never overrides the per-strategy cap', () => {
    // capUsd=150, floorUsd=200. Risk sizing would want to floor up to 200,
    // but the cap must always win -> sizeUsd must be <= 150.
    const r = computeRiskBasedSize({ nav: 10000, positions: [], capUsd: 150, floorUsd: 200 })
    expect(r.sizeUsd).toBeLessThanOrEqual(150)
  })

  it('full heat ceiling: zero size even when floor is large', () => {
    // Exactly at ceiling -> sizeUsd=0 regardless of floor.
    const r = computeRiskBasedSize({
      nav: 10000,
      positions: [pos(7500)],  // heat = 600 = ceiling
      capUsd: 2000,
      floorUsd: 200,
    })
    expect(r.sizeUsd).toBe(0)
  })
})
