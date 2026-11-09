import { describe, it, expect } from 'vitest'
import { evaluateRegime, DEFAULT_REGIME_PARAMS } from './regime-gate.js'
import type { PricePoint } from '../types.js'

function bars(closes: number[]): PricePoint[] {
  return closes.map((close, i) => ({
    date: `2026-01-${String(i + 1).padStart(2, '0')}`,
    close,
    ts_ms: 1_700_000_000_000 + i * 86_400_000,
  }))
}

describe('regime gate', () => {
  it('suppresses when fewer than smaWindow bars (fail toward no-trade)', () => {
    const v = evaluateRegime(bars(Array.from({ length: 50 }, (_, i) => 100 + i)))
    expect(v.allow).toBe(false)
    expect(v.aboveTrend).toBeNull()
    expect(v.reason).toContain('Insufficient bars')
  })

  it('allows a long in a calm uptrend above the 200DMA', () => {
    // 240 bars rising gently: last close well above the 200DMA, low vol.
    const closes = Array.from({ length: 240 }, (_, i) => 100 + i * 0.5)
    const v = evaluateRegime(bars(closes))
    expect(v.aboveTrend).toBe(true)
    expect(v.allow).toBe(true)
  })

  it('suppresses a long below the 200DMA (downtrend)', () => {
    // Rise then sharp fall so the last close is under the 200-bar average.
    const up = Array.from({ length: 200 }, (_, i) => 100 + i)
    const down = Array.from({ length: 40 }, (_, i) => 300 - i * 6)
    const v = evaluateRegime(bars([...up, ...down]))
    expect(v.aboveTrend).toBe(false)
    expect(v.allow).toBe(false)
    expect(v.reason).toContain('below')
  })

  it('suppresses a long in an extreme-vol state even above trend', () => {
    // Uptrend in level but huge daily swings -> extreme vol overlay fires.
    const closes = Array.from({ length: 240 }, (_, i) => 100 + i + (i % 2 === 0 ? 8 : -8))
    const v = evaluateRegime(bars(closes))
    expect(v.aboveTrend).toBe(true)
    expect(v.volState).toBe('extreme')
    expect(v.allow).toBe(false)
    expect(v.reason).toContain('Volatility state extreme')
  })

  it('respects custom params (tighter extreme threshold flips a normal day to extreme)', () => {
    const closes = Array.from({ length: 240 }, (_, i) => 100 + i + (i % 2 === 0 ? 2 : -2))
    const base = evaluateRegime(bars(closes))
    const strict = evaluateRegime(bars(closes), { ...DEFAULT_REGIME_PARAMS, extremePct: 0.005 })
    expect(base.allow).toBe(true)
    expect(strict.allow).toBe(false)
    expect(strict.volState).toBe('extreme')
  })

  it('suppresses when bars are empty (crypto / no engine data)', () => {
    const v = evaluateRegime([])
    expect(v.allow).toBe(false)
  })
})
