import { describe, it, expect } from 'vitest'
import { dailyReturnStdevDollars, volStopDistanceDollars } from './volatility.js'
import type { PricePoint } from '../types.js'

function bars(closes: number[]): PricePoint[] {
  return closes.map((close, i) => ({
    date: `2026-01-${String(i + 1).padStart(2, '0')}`,
    close,
    ts_ms: 1_700_000_000_000 + i * 86_400_000,
  }))
}

describe('volatility proxy', () => {
  it('returns null with too few bars', () => {
    expect(dailyReturnStdevDollars(bars([100, 101, 102]), 20)).toBeNull()
  })

  it('returns null for a flat series (zero vol)', () => {
    const flat = bars(Array(30).fill(100))
    expect(dailyReturnStdevDollars(flat, 20)).toBeNull()
  })

  it('computes a positive dollar stdev for a noisy series', () => {
    const closes = Array.from({ length: 40 }, (_, i) => 100 + (i % 2 === 0 ? 1 : -1))
    const d = dailyReturnStdevDollars(bars(closes), 20)
    expect(d).not.toBeNull()
    expect(d!).toBeGreaterThan(0)
  })

  it('sorts out-of-order bars before computing', () => {
    const ordered = bars(Array.from({ length: 30 }, (_, i) => 100 + Math.sin(i)))
    const shuffled = [...ordered].reverse()
    const a = dailyReturnStdevDollars(ordered, 20)
    const b = dailyReturnStdevDollars(shuffled, 20)
    expect(a).not.toBeNull()
    expect(b!).toBeCloseTo(a!, 9)
  })

  it('vol stop applies the multiple and floors it at 1.5x', () => {
    const b = bars(Array.from({ length: 40 }, (_, i) => 100 + (i % 2 === 0 ? 1 : -1)))
    const sigma = dailyReturnStdevDollars(b, 20)!
    expect(volStopDistanceDollars(b, 2.5, 20)!).toBeCloseTo(sigma * 2.5, 9)
    // mult below the floor is clamped to 1.5
    expect(volStopDistanceDollars(b, 0.5, 20)!).toBeCloseTo(sigma * 1.5, 9)
  })

  it('returns null stop when vol is unavailable', () => {
    expect(volStopDistanceDollars(bars([100, 101]), 2.5, 20)).toBeNull()
  })
})
