/**
 * verdict-engine.test.ts -- Phase 3 Task 1
 *
 * Pure-function tests for the verdict math + grader. No DB, no network.
 */
import { describe, it, expect } from 'vitest'

import {
  rollUpFills,
  computeVerdict,
  gradeThesis,
  attributeAgents,
  summarizeForReasoningBank,
  pickBenchSymbol,
  computeBenchReturn,
  computeHoldDrawdown,
  priceWindows,
} from './verdict-engine.js'
import type { EngineOrder, PricePoint } from './types.js'
import type { CommitteeTranscript } from './committee.js'

function order(overrides: Partial<EngineOrder> = {}): EngineOrder {
  return {
    client_order_id: 'co-' + Math.random().toString(36).slice(2, 8),
    broker_order_id: null,
    asset: 'AAPL',
    side: 'buy',
    qty: 1,
    order_type: 'limit',
    limit_price: null,
    status: 'filled',
    filled_qty: 1,
    filled_avg_price: 100,
    source: 'test',
    created_at: 1000,
    updated_at: 2000,
    ...overrides,
  }
}

function transcript(overrides: Partial<CommitteeTranscript> = {}): CommitteeTranscript {
  return {
    signal_id: 'sig-1',
    started_at: 0,
    finished_at: 1000,
    rounds_executed: 1,
    round_1: [
      { role: 'quant', opinion: 'long', confidence: 0.7, concerns: ['vol'] },
      { role: 'fundamentalist', opinion: 'long', confidence: 0.6, concerns: [] },
      { role: 'macro', opinion: 'pass', confidence: 0.4, concerns: ['rates'] },
      { role: 'sentiment', opinion: 'long', confidence: 0.55, concerns: [] },
    ],
    risk_officer: { role: 'risk_officer', veto: false, reason: 'ok', concerns: [] },
    trader: { role: 'trader', action: 'buy', thesis: 'go long AAPL', confidence: 0.65, size_multiplier: 1 },
    errors: [],
    ...overrides,
  }
}

describe('rollUpFills', () => {
  it('returns zeros for an empty order list', () => {
    const r = rollUpFills([], 'buy')
    expect(r.qty).toBe(0)
    expect(r.weightedPrice).toBe(0)
    expect(r.firstFillMs).toBeNull()
    expect(r.lastFillMs).toBeNull()
  })

  it('ignores orders with the wrong side', () => {
    const r = rollUpFills([order({ side: 'sell', filled_qty: 5, filled_avg_price: 110 })], 'buy')
    expect(r.qty).toBe(0)
  })

  it('weights price by filled quantity across multiple orders', () => {
    const r = rollUpFills([
      order({ side: 'buy', filled_qty: 1, filled_avg_price: 100, updated_at: 100 }),
      order({ side: 'buy', filled_qty: 3, filled_avg_price: 200, updated_at: 200 }),
    ], 'buy')
    expect(r.qty).toBe(4)
    expect(r.weightedPrice).toBe((100 * 1 + 200 * 3) / 4)
    expect(r.firstFillMs).toBe(100)
    expect(r.lastFillMs).toBe(200)
  })

  it('skips zero-qty fills and null prices', () => {
    const r = rollUpFills([
      order({ side: 'buy', filled_qty: 0, filled_avg_price: 100 }),
      order({ side: 'buy', filled_qty: 1, filled_avg_price: null }),
      order({ side: 'buy', filled_qty: 1, filled_avg_price: 50 }),
    ], 'buy')
    expect(r.qty).toBe(1)
    expect(r.weightedPrice).toBe(50)
  })
})

describe('computeVerdict', () => {
  it('long winner: positive pnl when sell > buy', () => {
    const v = computeVerdict({
      decisionId: 'd1',
      side: 'buy',
      buys: { qty: 10, weightedPrice: 100, fees: 0, firstFillMs: 1, lastFillMs: 2 },
      sells: { qty: 10, weightedPrice: 110, fees: 0, firstFillMs: 3, lastFillMs: 4 },
    })
    expect(v.fullyClosed).toBe(true)
    expect(v.pnlGross).toBe(100)
    expect(v.pnlNet).toBe(100)
    expect(v.pnlPct).toBeCloseTo(0.1, 6)
    expect(v.thesisGrade).toBe('A') // 10% > 2% AND 10% > 0
  })

  it('long loser: negative pnl when sell < buy', () => {
    const v = computeVerdict({
      decisionId: 'd2',
      side: 'buy',
      buys: { qty: 10, weightedPrice: 100, fees: 0, firstFillMs: 1, lastFillMs: 2 },
      sells: { qty: 10, weightedPrice: 90, fees: 0, firstFillMs: 3, lastFillMs: 4 },
    })
    expect(v.fullyClosed).toBe(true)
    expect(v.pnlGross).toBe(-100)
    expect(v.thesisGrade).toBe('D')
  })

  it('partial close: pnl_gross is 0 and fullyClosed is false', () => {
    const v = computeVerdict({
      decisionId: 'd3',
      side: 'buy',
      buys: { qty: 10, weightedPrice: 100, fees: 0, firstFillMs: 1, lastFillMs: 2 },
      sells: { qty: 5, weightedPrice: 105, fees: 0, firstFillMs: 3, lastFillMs: 4 },
    })
    expect(v.fullyClosed).toBe(false)
    expect(v.pnlGross).toBe(0)
  })

  it('zero buy qty: returns zeros without throwing', () => {
    const v = computeVerdict({
      decisionId: 'd4',
      side: 'buy',
      buys: { qty: 0, weightedPrice: 0, fees: 0, firstFillMs: null, lastFillMs: null },
      sells: { qty: 0, weightedPrice: 0, fees: 0, firstFillMs: null, lastFillMs: null },
    })
    expect(v.fullyClosed).toBe(false)
    expect(v.pnlGross).toBe(0)
    expect(v.pnlPct).toBe(0)
  })

  it('uses sell lastFillMs as closedAtMs when present', () => {
    const v = computeVerdict({
      decisionId: 'd5',
      side: 'buy',
      buys: { qty: 1, weightedPrice: 100, fees: 0, firstFillMs: 100, lastFillMs: 200 },
      sells: { qty: 1, weightedPrice: 110, fees: 0, firstFillMs: 300, lastFillMs: 999 },
    })
    expect(v.closedAtMs).toBe(999)
  })

  it('subtracts fees from pnl_net but not pnl_gross', () => {
    const v = computeVerdict({
      decisionId: 'd6',
      side: 'buy',
      buys: { qty: 10, weightedPrice: 100, fees: 1, firstFillMs: 1, lastFillMs: 2 },
      sells: { qty: 10, weightedPrice: 110, fees: 2, firstFillMs: 3, lastFillMs: 4 },
    })
    expect(v.pnlGross).toBe(100)
    expect(v.pnlNet).toBe(97)
  })
})

describe('gradeThesis', () => {
  it('A grade: pnl > 2% AND beat bench', () => {
    expect(gradeThesis(0.05, 0.02)).toBe('A')
  })

  it('B grade: positive AND beat bench, but pnl <= 2%', () => {
    expect(gradeThesis(0.015, 0.01)).toBe('B')
  })

  it('C grade: positive but did not beat bench', () => {
    expect(gradeThesis(0.01, 0.05)).toBe('C')
  })

  it('C grade: negative but beat bench (still avoided larger drop)', () => {
    expect(gradeThesis(-0.01, -0.05)).toBe('C')
  })

  it('D grade: negative AND failed to beat bench', () => {
    expect(gradeThesis(-0.05, -0.01)).toBe('D')
  })

  it('with benchReturn=0 (Phase 3 v1 placeholder): pnl > 2% is A', () => {
    expect(gradeThesis(0.03, 0)).toBe('A')
  })

  it('with benchReturn=0: 0 < pnl <= 2% is B (positive AND trivially beat 0)', () => {
    expect(gradeThesis(0.01, 0)).toBe('B')
  })

  it('with benchReturn=0: pnl <= 0 is D (zero does not beat zero)', () => {
    expect(gradeThesis(0, 0)).toBe('D')
    expect(gradeThesis(-0.05, 0)).toBe('D')
  })
})

describe('attributeAgents', () => {
  it('records confidences and concern counts for each round-1 specialist', () => {
    const t = transcript()
    const attr = attributeAgents(t, 50)
    const quant = attr.find(a => a.role === 'quant')
    expect(quant).toBeDefined()
    expect(quant!.data.confidence).toBe(0.7)
    expect(quant!.data.concerns_count).toBe(1)
  })

  it('marks risk_officer + trader right when pnl > 0', () => {
    const t = transcript()
    const attr = attributeAgents(t, 100)
    const risk = attr.find(a => a.role === 'risk_officer')
    const trader = attr.find(a => a.role === 'trader')
    expect(risk!.data.right).toBe(true)
    expect(trader!.data.right).toBe(true)
  })

  it('marks risk_officer + trader wrong when pnl <= 0', () => {
    const t = transcript()
    const attr = attributeAgents(t, -10)
    const risk = attr.find(a => a.role === 'risk_officer')
    const trader = attr.find(a => a.role === 'trader')
    expect(risk!.data.right).toBe(false)
    expect(trader!.data.right).toBe(false)
  })

  it('records trader action + size_multiplier for the report card', () => {
    const t = transcript({
      trader: { role: 'trader', action: 'buy', thesis: 'x', confidence: 0.8, size_multiplier: 1.5 },
    })
    const attr = attributeAgents(t, 0)
    const trader = attr.find(a => a.role === 'trader')
    expect(trader!.data.action).toBe('buy')
    expect(trader!.data.size_multiplier).toBe(1.5)
  })
})

describe('summarizeForReasoningBank', () => {
  it('includes asset, side, strategy, grade, and pnl', () => {
    const summary = summarizeForReasoningBank({
      asset: 'AAPL',
      side: 'buy',
      strategy: 'momentum-stocks',
      thesis: '  Hold 20d   on positive earnings momentum.  ',
      outcome: {
        pnlGross: 12.5,
        pnlNet: 12.5,
        pnlPct: 0.0625,
        benchReturn: 0,
        holdDrawdown: 0,
        thesisGrade: 'A',
        closedAtMs: 0,
        fullyClosed: true,
      },
    })
    expect(summary).toContain('AAPL buy via momentum-stocks')
    expect(summary).toContain('win')
    expect(summary).toContain('6.25%')
    expect(summary).toContain('graded A')
    expect(summary).toContain('Hold 20d on positive earnings momentum.')
  })

  it('marks loss when pnlGross is negative', () => {
    const summary = summarizeForReasoningBank({
      asset: 'NVDA',
      side: 'buy',
      strategy: 'mean-reversion-stocks',
      thesis: 'oversold bounce',
      outcome: {
        pnlGross: -5,
        pnlNet: -5,
        pnlPct: -0.05,
        benchReturn: 0,
        holdDrawdown: 0,
        thesisGrade: 'D',
        closedAtMs: 0,
        fullyClosed: true,
      },
    })
    expect(summary).toContain('loss')
    expect(summary).toContain('graded D')
  })

  it('marks breakeven when pnlGross is exactly 0', () => {
    const summary = summarizeForReasoningBank({
      asset: 'SPY',
      side: 'buy',
      strategy: 'momentum-stocks',
      thesis: 't',
      outcome: {
        pnlGross: 0,
        pnlNet: 0,
        pnlPct: 0,
        benchReturn: 0,
        holdDrawdown: 0,
        thesisGrade: 'D',
        closedAtMs: 0,
        fullyClosed: true,
      },
    })
    expect(summary).toContain('breakeven')
  })
})

// Phase 4 Task B additions ------------------------------------------------

function pricePoint(ms: number, close: number): PricePoint {
  return { date: new Date(ms).toISOString().slice(0, 10), close, ts_ms: ms }
}

describe('pickBenchSymbol', () => {
  it('picks SPY for plain equity tickers', () => {
    expect(pickBenchSymbol('AAPL')).toBe('SPY')
    expect(pickBenchSymbol('MSFT')).toBe('SPY')
    expect(pickBenchSymbol('TSLA')).toBe('SPY')
  })

  it('picks BTC/USD when the asset looks crypto by ticker shape', () => {
    expect(pickBenchSymbol('BTC/USD')).toBe('BTC/USD')
    expect(pickBenchSymbol('ETH/USD')).toBe('BTC/USD')
    expect(pickBenchSymbol('btc-usd')).toBe('BTC/USD')
  })

  it('picks BTC/USD for bare crypto symbols in the known list', () => {
    expect(pickBenchSymbol('BTC')).toBe('BTC/USD')
    expect(pickBenchSymbol('ETH')).toBe('BTC/USD')
    expect(pickBenchSymbol('SOL')).toBe('BTC/USD')
  })

  it('asset_class hint overrides symbol heuristic', () => {
    // Engine signals could tag an odd crypto-backed equity; asset_class wins.
    expect(pickBenchSymbol('AAPL', 'crypto')).toBe('BTC/USD')
    expect(pickBenchSymbol('BTC', 'stocks')).toBe('SPY')
  })
})

describe('computeBenchReturn', () => {
  it('returns 0 on empty or single-point series', () => {
    expect(computeBenchReturn([])).toBe(0)
    expect(computeBenchReturn([pricePoint(1, 100)])).toBe(0)
  })

  it('computes simple return on a two-point series', () => {
    const prices = [pricePoint(1, 100), pricePoint(2, 110)]
    expect(computeBenchReturn(prices)).toBeCloseTo(0.1, 10)
  })

  it('uses first and last close, ignoring intermediates', () => {
    const prices = [
      pricePoint(1, 100),
      pricePoint(2, 50),   // big dip in the middle
      pricePoint(3, 200),  // moon
      pricePoint(4, 90),
    ]
    // Last close 90, first 100 -> -10%
    expect(computeBenchReturn(prices)).toBeCloseTo(-0.1, 10)
  })

  it('returns 0 when entry close is non-positive (defensive)', () => {
    expect(computeBenchReturn([pricePoint(1, 0), pricePoint(2, 10)])).toBe(0)
    expect(computeBenchReturn([pricePoint(1, -5), pricePoint(2, 10)])).toBe(0)
  })
})

describe('computeHoldDrawdown', () => {
  it('returns 0 for empty or single-point series', () => {
    expect(computeHoldDrawdown([])).toBe(0)
    expect(computeHoldDrawdown([pricePoint(1, 100)])).toBe(0)
  })

  it('computes drawdown from entry to min close', () => {
    const prices = [
      pricePoint(1, 100),
      pricePoint(2, 110),
      pricePoint(3, 85),   // worst
      pricePoint(4, 95),
    ]
    // (85 - 100) / 100 = -0.15
    expect(computeHoldDrawdown(prices)).toBeCloseTo(-0.15, 10)
  })

  it('returns 0 for a monotonically-up trade (no drawdown)', () => {
    const prices = [
      pricePoint(1, 100),
      pricePoint(2, 105),
      pricePoint(3, 112),
      pricePoint(4, 120),
    ]
    expect(computeHoldDrawdown(prices)).toBe(0)
  })

  it('returns 0 when entry close is non-positive', () => {
    expect(computeHoldDrawdown([pricePoint(1, 0), pricePoint(2, -5)])).toBe(0)
  })

  it('handles drawdown at the first bar correctly (0, not positive)', () => {
    // If the very first close is the min, drawdown is 0 not positive.
    const prices = [
      pricePoint(1, 100),
      pricePoint(2, 110),
      pricePoint(3, 120),
    ]
    expect(computeHoldDrawdown(prices)).toBe(0)
  })
})

describe('priceWindows', () => {
  it('returns the hold window inclusive on both sides', () => {
    const w = priceWindows(1000, 2000)
    expect(w.benchFromMs).toBe(1000)
    expect(w.benchToMs).toBe(2000)
    expect(w.assetFromMs).toBe(1000)
    expect(w.assetToMs).toBe(2000)
  })
})
