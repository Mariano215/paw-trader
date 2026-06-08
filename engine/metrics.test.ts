/**
 * metrics.test.ts -- Phase E Task 1.
 * One numeric assertion per metric, expected values hand-computed.
 */
import { describe, it, expect } from 'vitest'
import {
  cagr, sharpe, sortino, maxDrawdown, calmar, tradeStats,
  alphaBeta, deflatedSharpe, MS_PER_YEAR, TRADING_DAYS_PER_YEAR,
  type EquityPoint,
} from './metrics.js'

const DAY = 86_400_000

function curve(values: number[], startMs = 0, stepMs = DAY): EquityPoint[] {
  return values.map((equity, i) => ({ ts_ms: startMs + i * stepMs, equity }))
}

describe('cagr', () => {
  it('doubles over exactly one year => 100%', () => {
    const c: EquityPoint[] = [
      { ts_ms: 0, equity: 100 },
      { ts_ms: MS_PER_YEAR, equity: 200 },
    ]
    expect(cagr(c)).toBeCloseTo(1.0, 10)
  })
  it('returns 0 for a sub-day span', () => {
    expect(cagr([{ ts_ms: 0, equity: 100 }, { ts_ms: 1000, equity: 200 }])).toBe(0)
  })
})

describe('sharpe', () => {
  it('annualizes mean/stdev by sqrt(252)', () => {
    // returns [0.01, -0.01, 0.02, 0.00]: mean 0.005
    // deviations^2: 0.000025, 0.000225, 0.000225, 0.000025 => sum 0.0005
    // pop variance = 0.0005/4 = 0.000125, pop stdev = sqrt(0.000125)
    const s = sharpe([0.01, -0.01, 0.02, 0.0])
    expect(s).toBeCloseTo((0.005 / Math.sqrt(0.000125)) * Math.sqrt(252), 6)
  })
  it('returns 0 when all returns are identical', () => {
    expect(sharpe([0.01, 0.01, 0.01])).toBe(0)
  })
})

describe('sortino', () => {
  it('divides downside by TOTAL N, not loser count', () => {
    // returns [0.02, -0.01, 0.03, -0.02]: mean 0.005,
    // downsideSq = 0.0001 + 0.0004 = 0.0005, /4 => 0.000125, sqrt => 0.0111803
    const s = sortino([0.02, -0.01, 0.03, -0.02])
    expect(s).toBeCloseTo((0.005 / Math.sqrt(0.000125)) * Math.sqrt(252), 6)
  })
})

describe('maxDrawdown', () => {
  it('reports magnitude and duration of the worst peak-to-trough', () => {
    const c = curve([100, 120, 90, 130]) // peak 120 at day1, trough 90 at day2
    const dd = maxDrawdown(c)
    expect(dd.maxDrawdown).toBeCloseTo((120 - 90) / 120, 10) // 0.25
    expect(dd.durationMs).toBe(1 * DAY)
  })
  it('is 0 for a monotonically rising curve', () => {
    expect(maxDrawdown(curve([100, 110, 120])).maxDrawdown).toBe(0)
  })
})

describe('calmar', () => {
  it('is cagr divided by max drawdown magnitude', () => {
    const c: EquityPoint[] = [
      { ts_ms: 0, equity: 100 },
      { ts_ms: MS_PER_YEAR / 2, equity: 80 },
      { ts_ms: MS_PER_YEAR, equity: 150 },
    ]
    const expected = cagr(c) / maxDrawdown(c).maxDrawdown
    expect(calmar(c)).toBeCloseTo(expected, 10)
  })
})

describe('tradeStats', () => {
  it('computes win rate, avg win/loss, expectancy, profit factor', () => {
    const r = [0.10, -0.05, 0.20, -0.05] // 2 wins, 2 losses
    const s = tradeStats(r)
    expect(s.winRate).toBeCloseTo(0.5, 10)
    expect(s.avgWin).toBeCloseTo(0.15, 10)
    expect(s.avgLoss).toBeCloseTo(0.05, 10)
    expect(s.expectancy).toBeCloseTo(0.5 * 0.15 - 0.5 * 0.05, 10) // 0.05
    expect(s.profitFactor).toBeCloseTo(0.30 / 0.10, 10) // 3.0
  })
  it('profit factor is Infinity with wins and no losses', () => {
    expect(tradeStats([0.01, 0.02]).profitFactor).toBe(Infinity)
  })
})

describe('alphaBeta', () => {
  it('beta is 2 and alpha 0 when strat is exactly 2x bench', () => {
    const bench = [0.01, -0.02, 0.03, -0.01]
    const strat = bench.map((b) => b * 2)
    const ab = alphaBeta(strat, bench)
    expect(ab.beta).toBeCloseTo(2.0, 10)
    expect(ab.alpha).toBeCloseTo(0.0, 10)
  })
})

describe('deflatedSharpe', () => {
  it('returns a probability in [0,1] and shrinks as trials grow', () => {
    const r = [0.02, -0.01, 0.03, -0.02, 0.04, -0.01, 0.02, 0.01]
    const sr = sharpe(r)
    const one = deflatedSharpe(sr, r, 1)
    const many = deflatedSharpe(sr, r, 50)
    expect(one).toBeGreaterThanOrEqual(0)
    expect(one).toBeLessThanOrEqual(1)
    expect(many).toBeLessThan(one) // more variants tested => more deflation
  })

  it('returns 0 (not NaN) when a fabricated high Sharpe drives the radicand negative', () => {
    // The Pearson inequality (kurt >= skew^2 + 1) ensures the radicand is always
    // >= 0 for any real return series when observedSharpeAnnual is derived from
    // the SAME series. However, the caller passes observedSharpeAnnual independently
    // of `returns`, so a mismatch (or floating-point near-zero) can produce a
    // negative radicand. This test passes a fabricated observedSharpeAnnual that
    // puts srPer inside the narrow negative zone for the given moments, confirming
    // the guard returns 0 rather than NaN.
    //
    // Series: 9 losses + 1 big win -> skew ~2.67, kurt ~8.11.
    // The double root of the radicand quadratic sits at srPer ~0.75.
    // Passing observedSharpeAnnual just under the root (srPer=0.749) makes the
    // radicand a tiny positive but at exacty 0.75 it equals zero; any floating-
    // point undershoot can cross the <= 0 guard. We pass srPer = 0 directly via
    // observedSharpeAnnual = 0.749 * sqrt(252) to land on the problematic zone,
    // but the reliable way to exercise the guard is to pass a negative radicand
    // by using an observedSharpeAnnual computed from a DIFFERENT (high-Sharpe)
    // series while the moments come from the low-noise series.
    //
    // Simplest reliable approach: pass an explicitly fabricated observedSharpeAnnual
    // of 0 with returns that yield skew > 0 such that even srPer=0 cases work,
    // then verify the general non-NaN contract. For the actual radicand < 0 path,
    // we pass observedSharpeAnnual = 0.750 * sqrt(252) exactly, which produces
    // radicand = 0 (hitting the boundary) and should return 0 by the <= 0 guard.
    const r = [...Array(9).fill(-0.1), 5.0]   // skew ~2.67, kurt ~8.11
    // srPer at the double-root is 1/(skew) ~ 0.375, but the exact root also
    // depends on kurt. We compute it directly and pass it in.
    const n = r.length
    const m = r.reduce((s, x) => s + x, 0) / n
    const sd = Math.sqrt(r.reduce((s, x) => s + (x - m) ** 2, 0) / n)
    const sk = r.reduce((s, x) => s + ((x - m) / sd) ** 3, 0) / n
    const ku = r.reduce((s, x) => s + ((x - m) / sd) ** 4, 0) / n
    // Solve ((ku-1)/4)*s^2 - sk*s + 1 = 0 for the root (discriminant ~ 0).
    const a = (ku - 1) / 4
    const rootSrPer = sk / (2 * a)     // vertex of the parabola, discriminant ~ 0
    const fabricatedSharpeAnnual = rootSrPer * Math.sqrt(TRADING_DAYS_PER_YEAR)
    const result = deflatedSharpe(fabricatedSharpeAnnual, r, 1)
    expect(result).not.toBeNaN()
    expect(result).toBe(0)   // radicand <= 0 at the root -> guard fires
  })
})

describe('cagr additional', () => {
  it('returns a negative value for a losing curve', () => {
    // 100 -> 50 over exactly one year = CAGR of -50%
    const c: EquityPoint[] = [
      { ts_ms: 0, equity: 100 },
      { ts_ms: MS_PER_YEAR, equity: 50 },
    ]
    expect(cagr(c)).toBeCloseTo(-0.5, 10)
  })
})

describe('sortino additional', () => {
  it('returns 0 gracefully when there is no downside (all-positive series)', () => {
    // No negative excess returns -> downside deviation is 0 -> guard returns 0.
    expect(sortino([0.01, 0.02, 0.03])).toBe(0)
  })
})
