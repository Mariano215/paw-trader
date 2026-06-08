/**
 * validation-gate.test.ts -- Phase E Task 3.
 * One test per blocking criterion plus the early-warning behavior.
 */
import { describe, it, expect } from 'vitest'
import {
  evaluateGate, GATE_MIN_CLOSED_TRADES, GATE_MAX_DRAWDOWN_KILL,
  LIVE_RECON_EARLY_WARNING_TRADES, type GateInput,
} from './validation-gate.js'
import type { EquityPoint } from './metrics.js'

const DAY = 86_400_000

/** A return series with real edge: ~58% win, +2% wins, -1% losses. */
function edgyReturns(n: number): number[] {
  const out: number[] = []
  for (let i = 0; i < n; i++) out.push(i % 12 < 7 ? 0.02 : -0.01)
  return out
}

/** A gently rising equity curve with a shallow (under-kill) dip. */
function healthyCurve(): EquityPoint[] {
  return [
    { ts_ms: 0, equity: 100_000 },
    { ts_ms: 10 * DAY, equity: 108_000 },
    { ts_ms: 20 * DAY, equity: 103_000 }, // ~4.6% dip, under the 20% kill
    { ts_ms: 30 * DAY, equity: 120_000 },
  ]
}

function baseInput(over: Partial<GateInput> = {}): GateInput {
  const r = edgyReturns(120)
  return {
    closedReturns: r,
    equityCurve: healthyCurve(),
    regimesObserved: 3,
    variantsTested: 1,
    outOfSampleNoRetune: true,
    backtestSharpe: 2.0,
    liveReconReturns: edgyReturns(40),
    ...over,
  }
}

describe('evaluateGate', () => {
  it('passes when every criterion is met', () => {
    const res = evaluateGate(baseInput())
    expect(res.passed).toBe(true)
  })

  it('fails on too few closed trades', () => {
    const res = evaluateGate(baseInput({ closedReturns: edgyReturns(GATE_MIN_CLOSED_TRADES - 1), liveReconReturns: edgyReturns(40) }))
    expect(res.passed).toBe(false)
    expect(res.criteria.find((c) => c.name === 'closed_trades')?.passed).toBe(false)
  })

  it('fails on a single regime', () => {
    const res = evaluateGate(baseInput({ regimesObserved: 1 }))
    expect(res.criteria.find((c) => c.name === 'market_regimes')?.passed).toBe(false)
  })

  it('fails when out-of-sample is not asserted', () => {
    const res = evaluateGate(baseInput({ outOfSampleNoRetune: false }))
    expect(res.criteria.find((c) => c.name === 'out_of_sample_no_retune')?.passed).toBe(false)
  })

  it('fails on negative expectancy', () => {
    const losing = Array.from({ length: 120 }, (_, i) => (i % 12 < 7 ? 0.005 : -0.05))
    const res = evaluateGate(baseInput({ closedReturns: losing }))
    expect(res.criteria.find((c) => c.name === 'positive_expectancy')?.passed).toBe(false)
  })

  it('fails when the max drawdown breaches the pre-committed kill level', () => {
    const deepDip: EquityPoint[] = [
      { ts_ms: 0, equity: 100_000 },
      { ts_ms: 10 * DAY, equity: 120_000 },
      { ts_ms: 20 * DAY, equity: 80_000 }, // 33% drawdown, over the 20% kill
      { ts_ms: 30 * DAY, equity: 90_000 },
    ]
    const res = evaluateGate(baseInput({ equityCurve: deepDip }))
    const c = res.criteria.find((x) => x.name === 'max_drawdown_kill')
    expect(c?.passed).toBe(false)
    expect(deepDip[2].equity / deepDip[1].equity).toBeLessThan(1 - GATE_MAX_DRAWDOWN_KILL)
  })

  it('fails when live Sharpe degrades below half of backtest', () => {
    const flatLive = Array.from({ length: 40 }, (_, i) => (i % 2 === 0 ? 0.001 : -0.001))
    const res = evaluateGate(baseInput({ liveReconReturns: flatLive, backtestSharpe: 5.0 }))
    expect(res.criteria.find((c) => c.name === 'live_vs_backtest_degradation')?.passed).toBe(false)
  })

  it('deflates Sharpe for many tested variants and can fail edge on that alone', () => {
    const res = evaluateGate(baseInput({ variantsTested: 500 }))
    expect(res.criteria.find((c) => c.name === 'deflated_sharpe')?.passed).toBe(false)
  })

  it('treats sparse live reconciliation as early warning, not a blocker', () => {
    const res = evaluateGate(baseInput({ liveReconReturns: edgyReturns(LIVE_RECON_EARLY_WARNING_TRADES - 1) }))
    expect(res.passed).toBe(true) // still passes; recon is non-blocking
    expect(res.warnings.some((w) => w.includes('early-warning only'))).toBe(true)
  })
})
