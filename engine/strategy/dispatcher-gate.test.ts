import { describe, it, expect } from 'vitest'
import { decideGatedTrade } from './gate-decision.js'
import type { PricePoint } from '../types.js'

function bars(closes: number[]): PricePoint[] {
  return closes.map((close, i) => ({
    date: `2026-01-${String(i + 1).padStart(2, '0')}`,
    close,
    ts_ms: 1_700_000_000_000 + i * 86_400_000,
  }))
}

describe('decideGatedTrade', () => {
  const uptrend = bars(Array.from({ length: 240 }, (_, i) => 100 + i * 0.5))

  it('allows and sizes a long in a calm uptrend', () => {
    const d = decideGatedTrade({
      asset: 'VTI', side: 'buy', bars: uptrend,
      entryPrice: uptrend[uptrend.length - 1].close,
      navUsd: 100_000, openRiskUsd: 0,
    })
    expect(d.allow).toBe(true)
    expect(d.sizeUsd).toBeGreaterThan(0)
    expect(d.stopDistanceDollars).not.toBeNull()
  })

  it('suppresses a long below the 200DMA', () => {
    const down = bars([
      ...Array.from({ length: 200 }, (_, i) => 100 + i),
      ...Array.from({ length: 40 }, (_, i) => 300 - i * 6),
    ])
    const d = decideGatedTrade({
      asset: 'VTI', side: 'buy', bars: down,
      entryPrice: down[down.length - 1].close,
      navUsd: 100_000, openRiskUsd: 0,
    })
    expect(d.allow).toBe(false)
    expect(d.sizeUsd).toBe(0)
  })

  it('passes through non-buy sides without gating (engine is buy-only)', () => {
    const d = decideGatedTrade({
      asset: 'VTI', side: 'sell', bars: uptrend,
      entryPrice: 100, navUsd: 100_000, openRiskUsd: 0,
    })
    expect(d.allow).toBe(true)
    // sizeUsd is null for non-buy: the dispatcher must not shrink on null
    expect(d.sizeUsd).toBeNull()
    expect(d.reason).toContain('buy-only')
  })

  it('suppresses when heat budget is exhausted even in a clean uptrend', () => {
    const d = decideGatedTrade({
      asset: 'VTI', side: 'buy', bars: uptrend,
      entryPrice: 100, navUsd: 100_000, openRiskUsd: 6_000,
    })
    expect(d.allow).toBe(false)
  })
})
