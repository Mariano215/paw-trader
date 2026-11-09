/**
 * committee-summary.test.ts
 *
 * Unit tests for summarizeCommitteeTranscript -- the pure parser that turns a
 * stored trader_committee_transcripts.transcript_json blob into the compact
 * per-role vote summary the dashboard "AI Committee" card renders. Engine-
 * independent; exercises only JSON shape handling, not HTTP.
 */
import { describe, it, expect } from 'vitest'
import { summarizeCommitteeTranscript } from './committee.js'

const META = {
  id: 'tr-1',
  signal_id: 'sig-1',
  asset: 'SPY',
  side: 'buy',
  rounds: 2,
  created_at: 1779825866161,
}

describe('summarizeCommitteeTranscript', () => {
  it('merges round_2 updated_confidence over round_1 confidence per role', () => {
    const body = JSON.stringify({
      signal_id: 'sig-1',
      rounds_executed: 2,
      round_1: [
        { role: 'quant', opinion: 'x', confidence: 0.68, concerns: [] },
        { role: 'macro', opinion: 'y', confidence: 0.6 },
      ],
      coordinator: { role: 'coordinator', consensus_direction: 'buy', avg_confidence: 0.64, skip_round_2: false },
      round_2: [
        { role: 'macro', response: 'z', updated_confidence: 0.52 },
      ],
    })
    const out = summarizeCommitteeTranscript(body, META)
    expect(out.consensus_direction).toBe('buy')
    expect(out.avg_confidence).toBeCloseTo(0.64)
    expect(out.asset).toBe('SPY')
    expect(out.side).toBe('buy')
    const quant = out.roles.find((r) => r.role === 'quant')
    const macro = out.roles.find((r) => r.role === 'macro')
    // quant only spoke in round 1 -> final == round 1
    expect(quant?.final_confidence).toBeCloseTo(0.68)
    // macro revised in round 2 -> final == round 2 updated_confidence
    expect(macro?.round1_confidence).toBeCloseTo(0.6)
    expect(macro?.final_confidence).toBeCloseTo(0.52)
  })

  it('handles skip_round_2 transcripts (no round_2 key) using round_1 confidence', () => {
    const body = JSON.stringify({
      round_1: [{ role: 'quant', confidence: 0.71 }],
      coordinator: { consensus_direction: 'skip', avg_confidence: 0.71, skip_round_2: true },
    })
    const out = summarizeCommitteeTranscript(body, META)
    expect(out.consensus_direction).toBe('skip')
    expect(out.roles).toHaveLength(1)
    expect(out.roles[0].final_confidence).toBeCloseTo(0.71)
  })

  it('returns safe defaults on malformed JSON but preserves meta', () => {
    const out = summarizeCommitteeTranscript('{not valid json', META)
    expect(out.roles).toEqual([])
    expect(out.consensus_direction).toBeNull()
    expect(out.avg_confidence).toBeNull()
    expect(out.id).toBe('tr-1')
    expect(out.asset).toBe('SPY')
    expect(out.rounds).toBe(2)
  })

  it('tolerates a missing coordinator block', () => {
    const body = JSON.stringify({ round_1: [{ role: 'risk', confidence: 0.4 }] })
    const out = summarizeCommitteeTranscript(body, META)
    expect(out.consensus_direction).toBeNull()
    expect(out.avg_confidence).toBeNull()
    expect(out.roles[0].role).toBe('risk')
  })
})
