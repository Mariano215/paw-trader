/**
 * eval-guards.test.ts -- Phase E Task 4.
 */
import { describe, it, expect } from 'vitest'
import {
  guardNoNavDriftAsPnl, guardNoSameBarClose, guardCostsIncluded, guardMonotonicCurve,
} from './eval-guards.js'
import type { FillRow } from './audit-log.js'
import type { EquityPoint } from './metrics.js'

function f(over: Partial<FillRow>): FillRow {
  return {
    id: 'x', decision_id: 'd1', client_order_id: 'co1', broker_order_id: null,
    asset: 'AAPL', side: 'buy', fill_qty: 1, fill_price: 100,
    intended_price: 100, intended_ts_ms: 0, fill_ts_ms: 1000,
    fee_usd: 0, slippage_usd: 0, entry_thesis: null, exit_reason: null, recorded_at: 0,
    ...over,
  }
}

describe('guardNoNavDriftAsPnl', () => {
  it('passes when reported value equals realized P&L', () => {
    expect(guardNoNavDriftAsPnl(100, 100).ok).toBe(true)
  })
  it('fails when a NAV delta is passed off as P&L', () => {
    expect(guardNoNavDriftAsPnl(100, 5000).ok).toBe(false)
  })
})

describe('guardNoSameBarClose', () => {
  it('fails when a sell shares a bar with an entry', () => {
    const fills = [f({ side: 'buy', fill_ts_ms: 1000 }), f({ side: 'sell', fill_ts_ms: 1000 })]
    expect(guardNoSameBarClose(fills).ok).toBe(false)
  })
  it('passes when exit is a later bar', () => {
    const fills = [f({ side: 'buy', fill_ts_ms: 1000 }), f({ side: 'sell', fill_ts_ms: 2000 })]
    expect(guardNoSameBarClose(fills).ok).toBe(true)
  })
})

describe('guardCostsIncluded', () => {
  it('fails when every leg has zero fees and zero slippage', () => {
    const fills = [f({ fee_usd: 0, slippage_usd: 0 }), f({ side: 'sell', fee_usd: 0, slippage_usd: 0 })]
    expect(guardCostsIncluded(fills).ok).toBe(false)
  })
  it('passes when a fee-free venue is declared', () => {
    const fills = [f({ fee_usd: 0, slippage_usd: 0 })]
    expect(guardCostsIncluded(fills, true).ok).toBe(true)
  })
  it('passes when slippage is present', () => {
    const fills = [f({ fee_usd: 0, slippage_usd: 1.5 })]
    expect(guardCostsIncluded(fills).ok).toBe(true)
  })
})

describe('guardMonotonicCurve', () => {
  it('fails on out-of-order timestamps', () => {
    const c: EquityPoint[] = [{ ts_ms: 2000, equity: 1 }, { ts_ms: 1000, equity: 1 }]
    expect(guardMonotonicCurve(c).ok).toBe(false)
  })
  it('passes on strictly increasing timestamps', () => {
    const c: EquityPoint[] = [{ ts_ms: 1000, equity: 1 }, { ts_ms: 2000, equity: 1 }]
    expect(guardMonotonicCurve(c).ok).toBe(true)
  })
})
