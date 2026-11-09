// Jev shadow judge. Asks TypeSafe's Jev model the same question the LLM
// committee answers, in one typed call (about 300 ms), and records the
// answer next to the committee transcript. With `jev_shadow` it decides
// nothing. With `jev_gate` it can veto an approval or halve its size, never
// approve on its own; any Jev error leaves the committee result as is.
// Needs TYPESAFE_API_KEY in .env.
import { logger } from '../logger.js'
import { traderKnob } from './knobs.js'

const JEV_URL = 'https://api.typesafe.ai/v1/systemone'
const TIMEOUT_MS = 5_000

export interface JevShadow {
  model?: string
  latency_ms: number
  input_tokens?: number
  action?: 'enter' | 'abstain'
  p_enter?: number
  entry_extended?: number
  regime_conflict?: number
  size_half?: number
  error?: string
}

export function jevQuestions(side: 'buy' | 'sell') {
  const dir = side === 'buy' ? 'long' : 'short'
  return {
    action: {
      type: 'choice',
      instructions: `Given this signal candidate, should code enter a ${dir} position now or abstain?`,
      criteria: { enter: `Enter the ${dir} now`, abstain: 'Do not enter; wait for a better entry or skip' },
    },
    entry_extended: {
      type: 'noul',
      instructions: 'Has price already moved far in the trade direction, so a pullback is likely before further gains?',
    },
    regime_conflict: {
      type: 'noul',
      instructions: 'Does the market regime conflict with the direction of this trade?',
    },
    size_half: {
      type: 'noul',
      instructions: 'Should position size be cut to half of normal for this entry?',
    },
  }
}

export function jevEnabled(): boolean {
  return (traderKnob('jev_shadow', false) || jevGateOn()) && Boolean(process.env.TYPESAFE_API_KEY)
}

export function jevGateOn(): boolean {
  return traderKnob('jev_gate', false)
}

export interface JevGateVerdict { veto: boolean; halve: boolean; reason?: string }

/** Veto-only: Jev can block or shrink an approval, never create one. Errors fail open. */
export function jevGateVerdict(jev: JevShadow | null | undefined): JevGateVerdict {
  if (!jev || jev.error) return { veto: false, halve: false }
  if (jev.action === 'abstain') {
    return { veto: true, halve: false, reason: `Jev abstain (p_enter=${jev.p_enter?.toFixed(2) ?? '?'})` }
  }
  const halve = (jev.size_half ?? 0) >= 0.5
  return { veto: false, halve, reason: halve ? `Jev size_half=${jev.size_half?.toFixed(2)}` : undefined }
}

/** Never throws. Returns null when disabled, `{ error }` on any failure. */
export async function jevShadowJudge(
  state: string,
  side: 'buy' | 'sell',
  fetchFn: typeof fetch = fetch,
): Promise<JevShadow | null> {
  if (!jevEnabled()) return null
  const t0 = Date.now()
  try {
    const res = await fetchFn(JEV_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.TYPESAFE_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ state, model: 'jev-latest', questions: jevQuestions(side) }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    const latency_ms = Date.now() - t0
    if (!res.ok) return { latency_ms, error: `HTTP ${res.status}` }
    const body = await res.json() as {
      model?: string
      usage?: { input_tokens?: number }
      answers?: Record<string, { choice?: string; probabilities?: Record<string, number>; noul?: number }>
    }
    const a = body.answers ?? {}
    return {
      model: body.model,
      latency_ms,
      input_tokens: body.usage?.input_tokens,
      action: a.action?.choice as JevShadow['action'],
      p_enter: a.action?.probabilities?.enter,
      entry_extended: a.entry_extended?.noul,
      regime_conflict: a.regime_conflict?.noul,
      size_half: a.size_half?.noul,
    }
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    logger.warn({ error }, 'Jev shadow judge failed')
    return { latency_ms: Date.now() - t0, error }
  }
}
