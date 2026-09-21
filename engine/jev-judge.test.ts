import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('./knobs.js', () => ({ traderKnob: vi.fn() }))
vi.mock('../logger.js', () => ({ logger: { warn: vi.fn() } }))

import { traderKnob } from './knobs.js'
import { jevShadowJudge, jevQuestions } from './jev-judge.js'

const answers = {
  model: 'jev-1.13.0',
  usage: { input_tokens: 682, output_tokens: 101 },
  answers: {
    action: { type: 'choice', choice: 'enter', confidence: 0.59, probabilities: { enter: 0.8, abstain: 0.2 } },
    entry_extended: { type: 'noul', noul: 0.77 },
    regime_conflict: { type: 'noul', noul: 0.06 },
    size_half: { type: 'noul', noul: 0.51 },
  },
}

describe('jevShadowJudge', () => {
  beforeEach(() => { process.env.TYPESAFE_API_KEY = 'test-key' })
  afterEach(() => { delete process.env.TYPESAFE_API_KEY; vi.mocked(traderKnob).mockReset() })

  it('returns null when the knob is off', async () => {
    vi.mocked(traderKnob).mockReturnValue(false)
    const fetchFn = vi.fn()
    expect(await jevShadowJudge('state', 'buy', fetchFn as never)).toBeNull()
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('sends criteria-shaped questions and flattens the answers', async () => {
    vi.mocked(traderKnob).mockReturnValue(true)
    const fetchFn = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => answers })
    const out = await jevShadowJudge('SIGNAL CANDIDATE: DBC', 'buy', fetchFn as never)
    const [, init] = fetchFn.mock.calls[0]
    const body = JSON.parse(init.body)
    expect(init.headers.Authorization).toBe('Bearer test-key')
    expect(body.model).toBe('jev-latest')
    expect(body.questions.action.criteria.enter).toMatch(/long/)
    expect(body.questions.entry_extended.type).toBe('noul')
    expect(out).toMatchObject({ model: 'jev-1.13.0', input_tokens: 682, action: 'enter', p_enter: 0.8, entry_extended: 0.77, regime_conflict: 0.06, size_half: 0.51 })
    expect(out?.error).toBeUndefined()
  })

  it('never throws: HTTP error and thrown fetch both become { error }', async () => {
    vi.mocked(traderKnob).mockReturnValue(true)
    const bad = vi.fn().mockResolvedValue({ ok: false, status: 429, json: async () => ({}) })
    expect(await jevShadowJudge('s', 'sell', bad as never)).toMatchObject({ error: 'HTTP 429' })
    const boom = vi.fn().mockRejectedValue(new Error('timeout'))
    expect(await jevShadowJudge('s', 'sell', boom as never)).toMatchObject({ error: 'timeout' })
  })

  it('words the action question for the trade side', () => {
    expect(jevQuestions('sell').action.criteria.enter).toMatch(/short/)
  })
})
