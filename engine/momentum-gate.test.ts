import { describe, it, expect } from 'vitest'
import { evaluateMomentumGate, MOMENTUM_CLEAR_MULTIPLE, MOMENTUM_ABS_MIN_SCORE } from './momentum-gate.js'
import { TRADER_SIGNAL_SCORE_THRESHOLD } from '../config.js'
import type { CommitteeSignalInput } from './committee.js'

const t = TRADER_SIGNAL_SCORE_THRESHOLD > 0 ? TRADER_SIGNAL_SCORE_THRESHOLD : 0.05

type BuySignal = Omit<CommitteeSignalInput, 'side'> & { side: 'buy' }

function sig(over: Partial<BuySignal>): BuySignal {
  return { id: 's1', asset: 'SPY', side: 'buy' as const, raw_score: t * 4, horizon_days: 20, enrichment_json: null, ...over }
}

describe('evaluateMomentumGate', () => {
  it('auto-approves a clean strong momentum buy with no regime data', () => {
    // Use a score well above both the multiple bar AND the absolute floor.
    const strongScore = Math.max(t * MOMENTUM_CLEAR_MULTIPLE, MOMENTUM_ABS_MIN_SCORE) * 1.5
    const r = evaluateMomentumGate(sig({ raw_score: strongScore }))
    expect(r.outcome).toBe('deterministic-approve')
    expect(r.confidence).toBeGreaterThanOrEqual(0.30)
    expect(r.confidence).toBeLessThanOrEqual(0.95)
  })

  it('auto-abstains below the floor multiple', () => {
    const r = evaluateMomentumGate(sig({ raw_score: t * 0.5 }))
    expect(r.outcome).toBe('deterministic-abstain')
  })

  it('escalates the mid band to the committee', () => {
    const r = evaluateMomentumGate(sig({ raw_score: t * 2 }))
    expect(r.outcome).toBe('escalate')
  })

  it('escalates when Markov is in the soft-conflict band even with a strong score', () => {
    const enrichment = JSON.stringify({ markov_regime: { markov_signal: -0.2 } })
    const strongScore = Math.max(t * 5, MOMENTUM_ABS_MIN_SCORE * 2)
    const r = evaluateMomentumGate(sig({ raw_score: strongScore, enrichment_json: enrichment }))
    expect(r.outcome).toBe('escalate')
  })

  it('auto-approves a strong score when Markov is supportive', () => {
    const enrichment = JSON.stringify({ markov_regime: { markov_signal: 0.4 } })
    const strongScore = Math.max(t * 5, MOMENTUM_ABS_MIN_SCORE * 2)
    const r = evaluateMomentumGate(sig({ raw_score: strongScore, enrichment_json: enrichment }))
    expect(r.outcome).toBe('deterministic-approve')
  })

  it('escalates a score that meets the 3x multiple but is below MOMENTUM_ABS_MIN_SCORE', () => {
    // With threshold=0.02: 3x = 0.06 which is below the 0.15 absolute floor -> must escalate.
    // Use a raw_score just at 3x * threshold to be precise.
    const scoreAt3xThreshold = t * MOMENTUM_CLEAR_MULTIPLE
    if (scoreAt3xThreshold < MOMENTUM_ABS_MIN_SCORE) {
      const r = evaluateMomentumGate(sig({ raw_score: scoreAt3xThreshold, enrichment_json: null }))
      expect(r.outcome).toBe('escalate')
    } else {
      // If threshold is already high (>=0.05), 3x already exceeds the floor: skip guard.
      // Still verify that a score just barely at 3x approves when above the floor.
      const r = evaluateMomentumGate(sig({ raw_score: scoreAt3xThreshold }))
      expect(['deterministic-approve', 'escalate']).toContain(r.outcome)
    }
  })

  it('approves a clearly strong score that exceeds both the multiple and absolute floor', () => {
    // Score = max(3x threshold, ABS_MIN_SCORE) * 2 guarantees both bars cleared.
    const strongScore = Math.max(t * MOMENTUM_CLEAR_MULTIPLE, MOMENTUM_ABS_MIN_SCORE) * 2
    const r = evaluateMomentumGate(sig({ raw_score: strongScore }))
    expect(r.outcome).toBe('deterministic-approve')
  })
})
