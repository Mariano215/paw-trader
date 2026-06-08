import type { CommitteeSignalInput } from './committee.js'
import type { MarkovRegimePayload } from './types.js'
import { TRADER_SIGNAL_SCORE_THRESHOLD } from '../config.js'

/** Score multiple (abs_raw_score / threshold) at or above which a momentum
 *  buy on a lean asset is clean enough to skip the LLM committee. */
export const MOMENTUM_CLEAR_MULTIPLE = 3.0

/** Score multiple below which we abstain deterministically (engine already
 *  gates at MIN_SCORE, but the brain keeps its own floor for safety). */
export const MOMENTUM_FLOOR_MULTIPLE = 1.0

/** Absolute minimum raw score for a deterministic approve, regardless of the
 *  threshold multiple. Prevents weak absolute signals (e.g. score=0.06 when
 *  threshold=0.02, which is 3x but still weak) from skipping the committee.
 *  A signal auto-approves only when abs(raw_score) >= max(CLEAR_MULTIPLE *
 *  threshold, MOMENTUM_ABS_MIN_SCORE). Below this, escalate. */
export const MOMENTUM_ABS_MIN_SCORE = 0.15

/** Markov band treated as "neutral or supportive" for a buy. Outside this
 *  band (signal < -0.10) the regime is in soft-conflict; escalate to the
 *  committee rather than auto-approve. Signals at or below -0.30 are already
 *  suppressed by the Markov pre-gate in the dispatcher before reaching here. */
export const MOMENTUM_MARKOV_SUPPORT = -0.10

export type MomentumGateOutcome =
  | 'deterministic-approve'
  | 'deterministic-abstain'
  | 'escalate'

export interface MomentumGateResult {
  outcome: MomentumGateOutcome
  reason: string
  /** Confidence to stamp on a deterministic approve, derived from the score
   *  multiple, clamped to [0.30, 0.95]. */
  confidence: number
}

function parseMarkov(enrichmentJson: string | null): MarkovRegimePayload | null {
  if (!enrichmentJson) return null
  try {
    const e = JSON.parse(enrichmentJson) as Record<string, unknown>
    const r = e?.markov_regime as MarkovRegimePayload | undefined
    return r && typeof r.markov_signal === 'number' ? r : null
  } catch {
    return null
  }
}

/**
 * Deterministic gate for routine momentum entries on lean-asset buy signals.
 * The `side` parameter is narrowed to 'buy' to prevent a future call-site from
 * accidentally wiring a sell signal into the auto-approve path.
 * ONLY the caller decides which signals are eligible (lean assets, buy side).
 * This function assumes eligibility and judges score strength + regime support.
 */
export function evaluateMomentumGate(signal: Omit<CommitteeSignalInput, 'side'> & { side: 'buy' }): MomentumGateResult {
  const threshold = TRADER_SIGNAL_SCORE_THRESHOLD > 0 ? TRADER_SIGNAL_SCORE_THRESHOLD : 0.05
  const multiple = Math.abs(signal.raw_score) / threshold

  if (multiple < MOMENTUM_FLOOR_MULTIPLE) {
    return {
      outcome: 'deterministic-abstain',
      reason: `score multiple ${multiple.toFixed(2)} below floor ${MOMENTUM_FLOOR_MULTIPLE}`,
      confidence: 0,
    }
  }

  const markov = parseMarkov(signal.enrichment_json)
  // A buy with regime data that is not clearly supportive is ambiguous ->
  // let the committee reason about it.
  if (markov !== null && markov.markov_signal < MOMENTUM_MARKOV_SUPPORT) {
    return {
      outcome: 'escalate',
      reason: `markov_signal ${markov.markov_signal.toFixed(3)} in soft-conflict band; escalate to committee`,
      confidence: 0,
    }
  }

  if (multiple >= MOMENTUM_CLEAR_MULTIPLE) {
    // Absolute floor guard: 3x of a very low threshold (e.g. 0.02) yields 0.06 --
    // a weak absolute signal that should not skip the committee. Require the raw
    // score to also clear MOMENTUM_ABS_MIN_SCORE before deterministic approve.
    if (Math.abs(signal.raw_score) < MOMENTUM_ABS_MIN_SCORE) {
      return {
        outcome: 'escalate',
        reason: `score multiple ${multiple.toFixed(2)}x but abs score ${Math.abs(signal.raw_score).toFixed(3)} < abs floor ${MOMENTUM_ABS_MIN_SCORE}; escalate`,
        confidence: 0,
      }
    }
    // Map [3x .. 6x] -> [0.55 .. 0.95], clamp.
    const conf = Math.max(0.30, Math.min(0.95, 0.55 + (multiple - MOMENTUM_CLEAR_MULTIPLE) * 0.1))
    return {
      outcome: 'deterministic-approve',
      reason: `clean momentum: score multiple ${multiple.toFixed(2)}x, abs score ${Math.abs(signal.raw_score).toFixed(3)}, markov ${markov ? markov.markov_signal.toFixed(3) : 'n/a'}`,
      confidence: Math.round(conf * 100) / 100,
    }
  }

  // Between floor and clear: not strong enough to auto-approve, not weak
  // enough to auto-abstain -> committee decides.
  return {
    outcome: 'escalate',
    reason: `score multiple ${multiple.toFixed(2)} between floor and clear band; escalate`,
    confidence: 0,
  }
}
