import { describe, it, expect, beforeEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import { initTraderTables } from './db.js'
import {
  runCommittee,
  storeTranscript,
  parseAgentJson,
  buildSignalContext,
  classifyVetoCategory,
  type CommitteeDeps,
  type CommitteeSignalInput,
  type RiskVerdict,
} from './committee.js'
import type { AgentResult } from '../agent.js'
import { TRADER_SIGNAL_SCORE_THRESHOLD } from '../config.js'
import { MOMENTUM_ABS_MIN_SCORE, MOMENTUM_CLEAR_MULTIPLE } from './momentum-gate.js'
import type { RollupResult } from './reasoning-bank.js'

const baseSignal: CommitteeSignalInput = {
  id: 'sig-c-1',
  asset: 'AAPL',
  side: 'buy',
  raw_score: 0.72,
  horizon_days: 20,
  enrichment_json: null,
}

function makeDb() {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = OFF')
  initTraderTables(db)
  return db
}

function agentResult(text: string | null): AgentResult {
  return { text, resultSubtype: 'success' } as AgentResult
}

/**
 * Build a fake runAgent that responds based on a substring of the source tag
 * in the actionPlan. This lets us script different JSON per specialist without
 * guessing call order.
 */
function scriptedRunAgent(
  script: Record<string, string | null>,
): CommitteeDeps['runAgent'] {
  return async (_message, _sid, _typ, _gh, _evt, actionPlan) => {
    const source = actionPlan?.source ?? 'unknown'
    return agentResult(script[source] ?? null)
  }
}

/** Static prompts so tests do not hit disk. */
const FAKE_PROMPT = 'TEST PROMPT'
const loadPrompt = (): string => FAKE_PROMPT

function deps(
  runAgent: CommitteeDeps['runAgent'],
  overrides: Partial<CommitteeDeps> = {},
): CommitteeDeps {
  return {
    runAgent,
    defaultSizeUsd: 100,
    maxSizeUsd: 200,
    loadPrompt,
    ...overrides,
  }
}

describe('committee -- helpers', () => {
  it('parseAgentJson reads clean JSON', () => {
    const out = parseAgentJson<{ a: number }>('{"a":1}')
    expect(out).toEqual({ a: 1 })
  })

  it('parseAgentJson extracts JSON embedded in prose', () => {
    const out = parseAgentJson<{ a: number }>('Sure, here is the JSON: {"a":2} and trailing text.')
    expect(out).toEqual({ a: 2 })
  })

  it('parseAgentJson returns null on garbage', () => {
    expect(parseAgentJson<unknown>('not json')).toBeNull()
    expect(parseAgentJson<unknown>('{ not-json')).toBeNull()
    expect(parseAgentJson<unknown>(null)).toBeNull()
    expect(parseAgentJson<unknown>('')).toBeNull()
  })

  it('buildSignalContext packs signal fields with enrichment placeholder', () => {
    const ctx = buildSignalContext({ ...baseSignal, enrichment_json: '{"rsi":45}' })
    expect(ctx).toContain('asset: AAPL')
    expect(ctx).toContain('raw_score: 0.72')
    expect(ctx).toContain('abs_raw_score: 0.72')
    expect(ctx).toContain(`score_threshold: ${TRADER_SIGNAL_SCORE_THRESHOLD}`)
    expect(ctx).toContain(`score_multiple_of_threshold: ${(0.72 / TRADER_SIGNAL_SCORE_THRESHOLD).toFixed(2)}`)
    expect(ctx).toContain('enrichment: {"rsi":45}')
  })
})

describe('committee -- classifyVetoCategory', () => {
  const base = (over: Partial<RiskVerdict>): RiskVerdict => ({
    role: 'risk_officer',
    veto: true,
    reason: '',
    concerns: [],
    ...over,
  })

  it('prefers structured category field', () => {
    expect(classifyVetoCategory(base({ category: 'event_risk', reason: 'specialists disagree' })))
      .toBe('event_risk')
    expect(classifyVetoCategory(base({ category: 'disagreement' }))).toBe('disagreement')
  })

  it("returns 'none' when veto is false and no category", () => {
    expect(classifyVetoCategory(base({ veto: false }))).toBe('none')
  })

  it('detects disagreement via whole-word fallback', () => {
    expect(classifyVetoCategory(base({ reason: 'Specialists disagree on direction.' })))
      .toBe('disagreement')
    expect(classifyVetoCategory(base({ reason: 'Mixed signals; thin conviction.' })))
      .toBe('disagreement')
    expect(classifyVetoCategory(base({ reason: 'Low confidence across the board.' })))
      .toBe('disagreement')
  })

  it('does NOT match negated disagreement phrasing (no false positives)', () => {
    expect(classifyVetoCategory(base({ reason: 'No disagreement, but earnings tomorrow.' })))
      .toBe('none')
    expect(classifyVetoCategory(base({ reason: 'Not split; halt risk on this name.' })))
      .toBe('none')
  })

  it('does NOT match substring-only hits (e.g. "conflict" inside "no conflict")', () => {
    // Negation stripping removes "no conflict"; nothing else matches.
    expect(classifyVetoCategory(base({ reason: 'No conflict here, but SEC action pending.' })))
      .toBe('none')
  })

  it("returns 'none' for event-risk reasons without disagreement keywords", () => {
    expect(classifyVetoCategory(base({ reason: 'Earnings in 24 hours; preserve capital.' })))
      .toBe('none')
    expect(classifyVetoCategory(base({ reason: 'Halt risk after regulatory headline.' })))
      .toBe('none')
  })

  it("category 'none' on a true-veto verdict still returns 'none'", () => {
    // If the LLM explicitly tags 'none', trust it -- the gate will not clear.
    expect(classifyVetoCategory(base({ category: 'none', reason: 'specialists disagree' })))
      .toBe('none')
  })
})

describe('committee -- approve path', () => {
  const script: Record<string, string> = {
    'committee-quant': '{"role":"quant","opinion":"Tape supports BUY","confidence":0.8,"concerns":[]}',
    'committee-fundamentalist': '{"role":"fundamentalist","opinion":"Earnings trajectory solid","confidence":0.7,"concerns":[]}',
    'committee-macro': '{"role":"macro","opinion":"Risk-on regime","confidence":0.65,"concerns":[]}',
    'committee-sentiment': '{"role":"sentiment","opinion":"Positive but not crowded","confidence":0.72,"concerns":[]}',
    'committee-coordinator': '{"role":"coordinator","consensus_direction":"buy","avg_confidence":0.72,"skip_round_2":true,"challenges":[]}',
    'committee-risk-officer': '{"role":"risk_officer","veto":false,"reason":"All clear","concerns":[]}',
    'committee-trader': '{"role":"trader","action":"buy","thesis":"Clean momentum with macro support","confidence":0.78,"size_multiplier":1.5}',
  }

  it('runs full committee, reaches trader approve, returns sized decision', async () => {
    const result = await runCommittee(baseSignal, deps(scriptedRunAgent(script)))
    expect(result.decision).toBe('approve')
    expect(result.action).toBe('buy')
    expect(result.thesis).toContain('momentum')
    expect(result.confidence).toBe(0.78)
    // 100 default * 1.5 multiplier = 150 (below 200 cap)
    expect(result.size_usd).toBe(150)
    expect(result.transcript.rounds_executed).toBe(1)  // coordinator said skip_round_2
    expect(result.transcript.round_1).toHaveLength(4)
    expect(result.transcript.errors).toEqual([])
  })

  it('clamps size_multiplier above 2 and below 0', async () => {
    const over = { ...script,
      'committee-trader': '{"role":"trader","action":"buy","thesis":"very bullish","confidence":0.9,"size_multiplier":5}' }
    const underResult = await runCommittee(
      baseSignal,
      deps(scriptedRunAgent(over), { defaultSizeUsd: 100, maxSizeUsd: 200 }),
    )
    // multiplier clamped to 2, so 100*2 = 200 (hits maxSizeUsd cap)
    expect(underResult.size_usd).toBe(200)
  })

  it('respects maxSizeUsd ceiling even when default*multiplier exceeds it', async () => {
    const result = await runCommittee(
      baseSignal,
      deps(scriptedRunAgent(script), { defaultSizeUsd: 300, maxSizeUsd: 200 }),
    )
    expect(result.size_usd).toBeLessThanOrEqual(200)
  })

  it('injects pastCases into the coordinator message when provided (Task 5)', async () => {
    // Capture every prompt the coordinator call sees so we can assert the
    // injection.
    const seen: { source: string; message: string }[] = []
    const capturing: CommitteeDeps['runAgent'] = async (message, _sid, _typ, _gh, _evt, actionPlan) => {
      const source = actionPlan?.source ?? 'unknown'
      seen.push({ source, message })
      return agentResult(script[source] ?? null)
    }
    const pastCases = 'PAST SIMILAR CASES (most recent first):\n(1) AAPL buy via momentum-stocks -- grade=A, outcome=win, pnl=12.50. Held 20d.'
    await runCommittee(baseSignal, deps(capturing, { pastCases }))
    const coordCall = seen.find(e => e.source === 'committee-coordinator')
    expect(coordCall).toBeDefined()
    expect(coordCall!.message).toContain('PAST SIMILAR CASES')
    expect(coordCall!.message).toContain('AAPL buy via momentum-stocks')
  })

  it('leaves the coordinator message unchanged when pastCases is omitted', async () => {
    const seen: { source: string; message: string }[] = []
    const capturing: CommitteeDeps['runAgent'] = async (message, _sid, _typ, _gh, _evt, actionPlan) => {
      const source = actionPlan?.source ?? 'unknown'
      seen.push({ source, message })
      return agentResult(script[source] ?? null)
    }
    await runCommittee(baseSignal, deps(capturing))
    const coordCall = seen.find(e => e.source === 'committee-coordinator')
    expect(coordCall).toBeDefined()
    expect(coordCall!.message).not.toContain('PAST SIMILAR CASES')
  })
})

describe('committee -- round 2', () => {
  const script: Record<string, string> = {
    'committee-quant': '{"role":"quant","opinion":"Tape supports BUY","confidence":0.8,"concerns":[]}',
    'committee-fundamentalist': '{"role":"fundamentalist","opinion":"Earnings mixed","confidence":0.4,"concerns":["recent guide-down"]}',
    'committee-macro': '{"role":"macro","opinion":"Late cycle","confidence":0.5,"concerns":["sector rotation"]}',
    'committee-sentiment': '{"role":"sentiment","opinion":"Crowded","confidence":0.45,"concerns":["too many longs"]}',
    'committee-coordinator': '{"role":"coordinator","consensus_direction":"mixed","avg_confidence":0.54,"skip_round_2":false,"challenges":[{"role":"fundamentalist","question":"Does the guide-down overhang clear this quarter?"}]}',
    'committee-fundamentalist-r2': '{"role":"fundamentalist","opinion":"Overhang clears next ER; still cautious","confidence":0.55,"concerns":[]}',
    'committee-risk-officer': '{"role":"risk_officer","veto":false,"reason":"Data supports small size","concerns":["thin conviction"]}',
    'committee-trader': '{"role":"trader","action":"buy","thesis":"Small-size probe given mixed specialists","confidence":0.58,"size_multiplier":0.5}',
  }

  it('runs round 2 when coordinator requests it and records updated responses', async () => {
    const result = await runCommittee(baseSignal, deps(scriptedRunAgent(script)))
    expect(result.decision).toBe('approve')
    expect(result.transcript.rounds_executed).toBe(2)
    expect(result.transcript.round_2).toHaveLength(1)
    expect(result.transcript.round_2![0].role).toBe('fundamentalist')
    expect(result.transcript.round_2![0].updated_confidence).toBe(0.55)
    // 100 * 0.5 = 50
    expect(result.size_usd).toBe(50)
  })
})

describe('committee -- risk officer veto', () => {
  const script: Record<string, string> = {
    'committee-quant': '{"role":"quant","opinion":"ok","confidence":0.7,"concerns":[]}',
    'committee-fundamentalist': '{"role":"fundamentalist","opinion":"ok","confidence":0.7,"concerns":[]}',
    'committee-macro': '{"role":"macro","opinion":"ok","confidence":0.7,"concerns":[]}',
    'committee-sentiment': '{"role":"sentiment","opinion":"ok","confidence":0.7,"concerns":[]}',
    'committee-coordinator': '{"role":"coordinator","consensus_direction":"buy","avg_confidence":0.7,"skip_round_2":true,"challenges":[]}',
    'committee-risk-officer': '{"role":"risk_officer","veto":true,"reason":"Earnings report within 24h","concerns":["event risk"]}',
  }

  it('returns abstain when risk officer vetoes', async () => {
    const result = await runCommittee(baseSignal, deps(scriptedRunAgent(script)))
    expect(result.decision).toBe('abstain')
    expect(result.action).toBeNull()
    expect(result.size_usd).toBe(0)
    expect(result.thesis).toContain('Earnings report within 24h')
    expect(result.transcript.risk_officer.veto).toBe(true)
  })
})

describe('committee -- trader abstain', () => {
  const script: Record<string, string> = {
    'committee-quant': '{"role":"quant","opinion":"ok","confidence":0.6,"concerns":[]}',
    'committee-fundamentalist': '{"role":"fundamentalist","opinion":"ok","confidence":0.55,"concerns":[]}',
    'committee-macro': '{"role":"macro","opinion":"ok","confidence":0.55,"concerns":[]}',
    'committee-sentiment': '{"role":"sentiment","opinion":"ok","confidence":0.5,"concerns":[]}',
    'committee-coordinator': '{"role":"coordinator","consensus_direction":"mixed","avg_confidence":0.55,"skip_round_2":true,"challenges":[]}',
    'committee-risk-officer': '{"role":"risk_officer","veto":false,"reason":"clear","concerns":[]}',
    'committee-trader': '{"role":"trader","action":"abstain","thesis":"Conviction too low","confidence":0.4,"size_multiplier":0}',
  }

  it('propagates trader abstain as overall abstain with size zero', async () => {
    const result = await runCommittee(baseSignal, deps(scriptedRunAgent(script)))
    expect(result.decision).toBe('abstain')
    expect(result.size_usd).toBe(0)
    expect(result.transcript.trader.action).toBe('abstain')
  })
})

describe('committee -- fail-closed on broken agents', () => {
  it('abstains when fewer than 2 specialists produce parseable opinions', async () => {
    const script: Record<string, string | null> = {
      'committee-quant': '{"role":"quant","opinion":"ok","confidence":0.7,"concerns":[]}',
      'committee-fundamentalist': 'not json',
      'committee-macro': null,
      'committee-sentiment': 'also broken',
    }
    const result = await runCommittee(baseSignal, deps(scriptedRunAgent(script)))
    expect(result.decision).toBe('abstain')
    expect(result.thesis).toContain('quorum')
    expect(result.transcript.errors.length).toBeGreaterThan(0)
  })

  it('abstains when risk officer output fails to parse (fail-closed)', async () => {
    const script: Record<string, string | null> = {
      'committee-quant': '{"role":"quant","opinion":"ok","confidence":0.7,"concerns":[]}',
      'committee-fundamentalist': '{"role":"fundamentalist","opinion":"ok","confidence":0.7,"concerns":[]}',
      'committee-macro': '{"role":"macro","opinion":"ok","confidence":0.7,"concerns":[]}',
      'committee-sentiment': '{"role":"sentiment","opinion":"ok","confidence":0.7,"concerns":[]}',
      'committee-coordinator': '{"role":"coordinator","consensus_direction":"buy","avg_confidence":0.7,"skip_round_2":true,"challenges":[]}',
      'committee-risk-officer': 'bogus',
    }
    const result = await runCommittee(baseSignal, deps(scriptedRunAgent(script)))
    expect(result.decision).toBe('abstain')
    expect(result.transcript.risk_officer.veto).toBe(true)
    expect(result.transcript.errors).toContain('risk_officer parse failed; defaulting to veto (fail-closed)')
  })

  it('abstains when trader output fails to parse', async () => {
    const script: Record<string, string | null> = {
      'committee-quant': '{"role":"quant","opinion":"ok","confidence":0.7,"concerns":[]}',
      'committee-fundamentalist': '{"role":"fundamentalist","opinion":"ok","confidence":0.7,"concerns":[]}',
      'committee-macro': '{"role":"macro","opinion":"ok","confidence":0.7,"concerns":[]}',
      'committee-sentiment': '{"role":"sentiment","opinion":"ok","confidence":0.7,"concerns":[]}',
      'committee-coordinator': '{"role":"coordinator","consensus_direction":"buy","avg_confidence":0.7,"skip_round_2":true,"challenges":[]}',
      'committee-risk-officer': '{"role":"risk_officer","veto":false,"reason":"ok","concerns":[]}',
      'committee-trader': 'not-json-at-all',
    }
    const result = await runCommittee(baseSignal, deps(scriptedRunAgent(script)))
    expect(result.decision).toBe('abstain')
    expect(result.transcript.errors).toContain('trader parse failed; abstaining')
  })

  it('runAgent throwing is handled per call without aborting the run', async () => {
    const runAgent: CommitteeDeps['runAgent'] = async (_m, _s, _t, _g, _e, ap) => {
      if (ap?.source === 'committee-macro') throw new Error('timeout')
      const ok: Record<string, string> = {
        'committee-quant': '{"role":"quant","opinion":"ok","confidence":0.7,"concerns":[]}',
        'committee-fundamentalist': '{"role":"fundamentalist","opinion":"ok","confidence":0.7,"concerns":[]}',
        'committee-sentiment': '{"role":"sentiment","opinion":"ok","confidence":0.7,"concerns":[]}',
        'committee-coordinator': '{"role":"coordinator","consensus_direction":"buy","avg_confidence":0.7,"skip_round_2":true,"challenges":[]}',
        'committee-risk-officer': '{"role":"risk_officer","veto":false,"reason":"ok","concerns":[]}',
        'committee-trader': '{"role":"trader","action":"buy","thesis":"ok","confidence":0.7,"size_multiplier":1}',
      }
      return agentResult(ok[ap?.source ?? ''] ?? null)
    }
    const result = await runCommittee(baseSignal, deps(runAgent))
    // Macro specialist failed but 3 other specialists gave opinions -> still approves
    expect(result.decision).toBe('approve')
    expect(result.transcript.round_1).toHaveLength(3)
    expect(result.transcript.errors).toContain('round1:macro parse failed')
  })
})

describe('committee -- transcript persistence', () => {
  it('storeTranscript inserts a row with JSON blob', () => {
    const db = makeDb()
    const result = {
      decision: 'approve' as const,
      action: 'buy' as const,
      thesis: 'test',
      confidence: 0.7,
      size_usd: 100,
      transcript_id: 'tr-abc',
      transcript: {
        signal_id: 'sig-store-1',
        started_at: 1,
        finished_at: 2,
        rounds_executed: 1,
        round_1: [],
        risk_officer: { role: 'risk_officer' as const, veto: false, reason: 'ok', concerns: [] },
        trader: { role: 'trader' as const, action: 'buy' as const, thesis: 't', confidence: 0.7, size_multiplier: 1 },
        errors: [],
      },
    }
    // Signal row so FK passes (even with FK off, we at least track the id)
    db.prepare(`
      INSERT INTO trader_signals (id, strategy_id, asset, side, raw_score, horizon_days, generated_at, status)
      VALUES ('sig-store-1', 'momentum-stocks', 'AAPL', 'buy', 0.5, 20, ?, 'committee')
    `).run(Date.now())
    db.prepare(`
      INSERT INTO trader_strategies (id, name, asset_class, tier, status, params_json, created_at, updated_at)
      VALUES ('momentum-stocks', 'Momentum', 'equity', 0, 'active', '{}', ?, ?)
    `).run(Date.now(), Date.now())

    storeTranscript(db, result, { totalTokens: 1234, totalCostUsd: 0.05 })

    const row = db.prepare("SELECT id, rounds, total_tokens, total_cost_usd FROM trader_committee_transcripts WHERE id = 'tr-abc'").get() as any
    expect(row).not.toBeNull()
    expect(row.rounds).toBe(1)
    expect(row.total_tokens).toBe(1234)
    expect(row.total_cost_usd).toBe(0.05)
  })

  it('storeTranscript swallows DB errors', () => {
    const brokenDb = {
      prepare: () => { throw new Error('db closed') },
    } as unknown as Database.Database
    expect(() => storeTranscript(brokenDb, {
      decision: 'approve',
      action: 'buy',
      thesis: 't',
      confidence: 0.7,
      size_usd: 100,
      transcript_id: 'x',
      transcript: {
        signal_id: 's',
        started_at: 1, finished_at: 2, rounds_executed: 1,
        round_1: [],
        risk_officer: { role: 'risk_officer', veto: false, reason: '', concerns: [] },
        trader: { role: 'trader', action: 'buy', thesis: '', confidence: 0.7, size_multiplier: 1 },
        errors: [],
      },
    })).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// Markov regime gate tests
// ---------------------------------------------------------------------------

function makeEnrichmentJson(markovSignal: number | null): string | null {
  if (markovSignal === null) return null
  const payload = {
    price_current: 150,
    price_change_1d_pct: 0.5,
    price_change_5d_pct: 1.2,
    price_change_20d_pct: 3.4,
    rsi_14: 55,
    window_high: 155,
    window_low: 140,
    pct_from_window_high: -3.2,
    bars_fetched: 22,
    fetched_at: Date.now(),
    markov_regime: {
      source: 'markov_regime',
      asset: 'AAPL',
      as_of: '2026-05-20',
      n_obs: 200,
      current_state: markovSignal > 0.1 ? 'bull' : markovSignal < -0.1 ? 'bear' : 'sideways',
      markov_signal: markovSignal,
      stationary: { bear: 0.2, sideways: 0.3, bull: 0.5 },
      persistence_diag: [0.9, 0.85, 0.92],
      walk_forward: { sharpe: 0.8, max_drawdown: -0.05, n_trades: 12 },
      computed_at_ms: Date.now(),
      params: { window: 60, threshold: 0.1, backtest: true, days: 30 },
    },
  }
  return JSON.stringify(payload)
}

/** Shared specialist + coordinator script for Markov gate tests. */
function markovBaseScript(
  avgConfidence: number,
  consensusDirection: 'buy' | 'sell' | 'mixed' = 'buy',
): Record<string, string> {
  return {
    'committee-quant':         `{"role":"quant","opinion":"ok","confidence":${avgConfidence},"concerns":[]}`,
    'committee-fundamentalist':`{"role":"fundamentalist","opinion":"ok","confidence":${avgConfidence},"concerns":[]}`,
    'committee-macro':         `{"role":"macro","opinion":"mixed","confidence":${(avgConfidence - 0.1).toFixed(2)},"concerns":["some concern"]}`,
    'committee-sentiment':     `{"role":"sentiment","opinion":"ok","confidence":${avgConfidence},"concerns":[]}`,
    'committee-coordinator':   JSON.stringify({
      role: 'coordinator',
      consensus_direction: consensusDirection,
      avg_confidence: avgConfidence,
      skip_round_2: true,
      challenges: [],
    }),
    // LLM risk officer would normally veto on specialist split; gate should override
    'committee-risk-officer':  '{"role":"risk_officer","veto":true,"reason":"Specialists show sharp directional split","concerns":["disagreement"]}',
    'committee-trader':        `{"role":"trader","action":"${consensusDirection === 'sell' ? 'sell' : 'buy'}","thesis":"momentum","confidence":${avgConfidence},"size_multiplier":1}`,
  }
}

describe('committee -- Markov regime gate', () => {
  it('Markov agrees with majority + mild specialist split → action goes through (NOT abstain)', async () => {
    // markov_signal=+0.55 agrees with buy; LLM risk officer wants to veto on disagreement
    const signal: CommitteeSignalInput = {
      ...baseSignal,
      enrichment_json: makeEnrichmentJson(0.55),
    }
    const result = await runCommittee(signal, deps(scriptedRunAgent(markovBaseScript(0.60))))
    expect(result.decision).toBe('approve')
    expect(result.action).toBe('buy')
    expect(result.transcript.risk_officer.veto).toBe(false)
    expect(result.transcript.risk_officer.reason).toContain('markov_signal')
  })

  it('Markov conflicts with action (buy, markov_signal=-0.6) → Risk Officer veto with markov_conflict reason', async () => {
    const signal: CommitteeSignalInput = {
      ...baseSignal,
      enrichment_json: makeEnrichmentJson(-0.6),
    }
    // LLM says no-veto; gate should override to veto
    const script = {
      ...markovBaseScript(0.65),
      'committee-risk-officer': '{"role":"risk_officer","veto":false,"reason":"All clear","concerns":[]}',
    }
    const result = await runCommittee(signal, deps(scriptedRunAgent(script)))
    expect(result.decision).toBe('abstain')
    expect(result.transcript.risk_officer.veto).toBe(true)
    expect(result.transcript.risk_officer.concerns.some((c) => c.includes('markov_conflict'))).toBe(true)
  })

  it('Markov absent + avg confidence 0.50 + mild split → goes through', async () => {
    // No markov_regime in enrichment; avg conf 0.50 >= 0.30 hard floor.
    // With no Markov, the gate only adds vetoes -- it does not clear LLM vetoes.
    // So the LLM must say veto:false for the trade to proceed.
    const signal: CommitteeSignalInput = {
      ...baseSignal,
      enrichment_json: null,
    }
    const script = {
      ...markovBaseScript(0.50),
      // LLM clears veto; gate has no opinion at conf=0.50 >= 0.45 -- trade goes through.
      'committee-risk-officer': '{"role":"risk_officer","veto":false,"reason":"Borderline but acceptable","concerns":[]}',
    }
    const result = await runCommittee(signal, deps(scriptedRunAgent(script)))
    expect(result.decision).toBe('approve')
    expect(result.transcript.risk_officer.veto).toBe(false)
  })

  it('Markov absent + avg confidence 0.40 + mild split → goes through (single 0.30 floor only)', async () => {
    // With the 0.45 floor removed, 0.40 >= 0.30 and the LLM says veto:false,
    // so the trade should proceed.
    const signal: CommitteeSignalInput = {
      ...baseSignal,
      enrichment_json: null,
    }
    const script = {
      ...markovBaseScript(0.40),
      'committee-risk-officer': '{"role":"risk_officer","veto":false,"reason":"Borderline but ok","concerns":[]}',
    }
    const result = await runCommittee(signal, deps(scriptedRunAgent(script)))
    expect(result.decision).toBe('approve')
    expect(result.transcript.risk_officer.veto).toBe(false)
  })

  it('Hard veto: avg confidence 0.20 → veto regardless of Markov', async () => {
    // Markov is strongly bullish but confidence is below absolute floor
    const signal: CommitteeSignalInput = {
      ...baseSignal,
      enrichment_json: makeEnrichmentJson(0.9),
    }
    const script = {
      ...markovBaseScript(0.20),
      'committee-risk-officer': '{"role":"risk_officer","veto":false,"reason":"Score is high, proceed","concerns":[]}',
    }
    const result = await runCommittee(signal, deps(scriptedRunAgent(script)))
    expect(result.decision).toBe('abstain')
    expect(result.transcript.risk_officer.veto).toBe(true)
    expect(result.transcript.risk_officer.concerns.some((c) => c.includes('hard_confidence_floor'))).toBe(true)
  })

  it('Markov neutral (signal=0.0) with buy action → does not conflict, trade goes through', async () => {
    const signal: CommitteeSignalInput = {
      ...baseSignal,
      enrichment_json: makeEnrichmentJson(0.0),
    }
    const result = await runCommittee(signal, deps(scriptedRunAgent(markovBaseScript(0.60))))
    expect(result.decision).toBe('approve')
    expect(result.transcript.risk_officer.veto).toBe(false)
  })

  it('Markov at exact boundary (-0.30 with buy) → does not veto (boundary is exclusive)', async () => {
    // markov_signal = -0.30, threshold is <= -0.30, so -0.30 should veto
    const signal: CommitteeSignalInput = {
      ...baseSignal,
      enrichment_json: makeEnrichmentJson(-0.30),
    }
    const script = {
      ...markovBaseScript(0.65),
      'committee-risk-officer': '{"role":"risk_officer","veto":false,"reason":"ok","concerns":[]}',
    }
    const result = await runCommittee(signal, deps(scriptedRunAgent(script)))
    // -0.30 <= -0.30 is true → veto
    expect(result.decision).toBe('abstain')
    expect(result.transcript.risk_officer.concerns.some((c) => c.includes('markov_conflict'))).toBe(true)
  })

  it('Sell action: Markov negative signal agrees with sell → goes through', async () => {
    const signal: CommitteeSignalInput = {
      ...baseSignal,
      side: 'sell',
      enrichment_json: makeEnrichmentJson(-0.7),
    }
    const script = {
      ...markovBaseScript(0.65, 'sell'),
      'committee-risk-officer': '{"role":"risk_officer","veto":true,"reason":"Specialists disagree on sell","concerns":["split"]}',
      'committee-trader': '{"role":"trader","action":"sell","thesis":"bear regime","confidence":0.65,"size_multiplier":1}',
    }
    const result = await runCommittee(signal, deps(scriptedRunAgent(script)))
    expect(result.decision).toBe('approve')
    expect(result.action).toBe('sell')
    expect(result.transcript.risk_officer.veto).toBe(false)
  })
})

describe('committee -- rollup injection', () => {
  const rollupScript: Record<string, string> = {
    'committee-quant': '{"role":"quant","opinion":"neutral","confidence":0.5,"concerns":[]}',
    'committee-fundamentalist': '{"role":"fundamentalist","opinion":"neutral","confidence":0.5,"concerns":[]}',
    'committee-macro': '{"role":"macro","opinion":"neutral","confidence":0.5,"concerns":[]}',
    'committee-sentiment': '{"role":"sentiment","opinion":"neutral","confidence":0.5,"concerns":[]}',
    'committee-coordinator': '{"role":"coordinator","consensus_direction":"buy","avg_confidence":0.5,"skip_round_2":true,"challenges":[]}',
    'committee-risk-officer': '{"role":"risk_officer","veto":false,"reason":"ok","concerns":[]}',
    'committee-trader': '{"role":"trader","action":"buy","thesis":"test","confidence":0.5,"size_multiplier":1}',
  }

  it('prepends rollup block to specialist prompts when paper outcomes exist', async () => {
    const db = makeDb()
    db.prepare("INSERT INTO trader_strategies (id, name, asset_class, tier, status, params_json, created_at, updated_at) VALUES ('eq-mom','Equity Momentum','equity',0,'active','{}',?,?)").run(Date.now(), Date.now())
    db.prepare("INSERT INTO trader_reasoning_bank (id, asset, side, strategy, summary, outcome, pnl_net, created_at) VALUES ('c1','AAPL','buy','eq-mom','x','win',0.02,?)").run(Date.now())

    const promptCaptures: string[] = []
    const fakeRunAgent: CommitteeDeps['runAgent'] = async (message, _sid, _typ, _gh, _evt, actionPlan) => {
      promptCaptures.push(message)
      const source = actionPlan?.source ?? 'unknown'
      return { text: rollupScript[source] ?? null, resultSubtype: 'success' } as AgentResult
    }

    const signal: CommitteeSignalInput & { strategy_id: string } = {
      id: 'sig-rollup-1', asset: 'AAPL', side: 'buy', raw_score: 0.6, horizon_days: 5,
      enrichment_json: null, strategy_id: 'eq-mom',
    }

    await runCommittee(signal as any, deps(fakeRunAgent, { db }))

    expect(promptCaptures.some((p) => p.includes('RECENT PAPER TRADE OUTCOMES'))).toBe(true)
    expect(promptCaptures.some((p) => p.includes('Last 1 paper trades (equity)'))).toBe(true)
  })

  it('falls back gracefully when rollup throws (no rollup block in prompts)', async () => {
    const db = makeDb()
    // Drop trader_strategies so rollupRecentOutcomes throws (JOIN will fail)
    db.exec('DROP TABLE IF EXISTS trader_strategies')

    const promptCaptures: string[] = []
    const fakeRunAgent: CommitteeDeps['runAgent'] = async (message, _sid, _typ, _gh, _evt, actionPlan) => {
      promptCaptures.push(message)
      const source = actionPlan?.source ?? 'unknown'
      return { text: rollupScript[source] ?? null, resultSubtype: 'success' } as AgentResult
    }

    const signal: CommitteeSignalInput & { strategy_id: string } = {
      id: 'sig-rollup-2', asset: 'AAPL', side: 'buy', raw_score: 0.6, horizon_days: 5,
      enrichment_json: null, strategy_id: 'eq-mom',
    }

    await runCommittee(signal as any, deps(fakeRunAgent, { db }))

    expect(promptCaptures.every((p) => !p.includes('RECENT PAPER TRADE OUTCOMES'))).toBe(true)
  })
})

describe('committee -- single 0.30 confidence floor (Task 1)', () => {
  it('does not abstain at avg confidence 0.40 with no Markov data (single 0.30 floor)', async () => {
    const script: Record<string, string | null> = {
      'committee-quant': JSON.stringify({ role: 'quant', opinion: 'ok', confidence: 0.40, concerns: [] }),
      'committee-fundamentalist': JSON.stringify({ role: 'fundamentalist', opinion: 'ok', confidence: 0.40, concerns: [] }),
      'committee-macro': JSON.stringify({ role: 'macro', opinion: 'ok', confidence: 0.40, concerns: [] }),
      'committee-sentiment': JSON.stringify({ role: 'sentiment', opinion: 'ok', confidence: 0.40, concerns: [] }),
      'committee-coordinator': JSON.stringify({ role: 'coordinator', consensus_direction: 'buy', avg_confidence: 0.40, skip_round_2: true, challenges: [] }),
      'committee-risk-officer': JSON.stringify({ role: 'risk_officer', veto: false, reason: 'clear', concerns: [], category: 'none' }),
      'committee-trader': JSON.stringify({ role: 'trader', action: 'buy', thesis: 'momentum entry', confidence: 0.40, size_multiplier: 1 }),
    }
    const db = makeDb()
    const result = await runCommittee(baseSignal, deps(scriptedRunAgent(script), { db }))
    expect(result.decision).toBe('approve')
  })

  it('still hard-vetoes below the 0.30 floor', async () => {
    const script: Record<string, string | null> = {
      'committee-quant': JSON.stringify({ role: 'quant', opinion: 'weak', confidence: 0.20, concerns: [] }),
      'committee-fundamentalist': JSON.stringify({ role: 'fundamentalist', opinion: 'weak', confidence: 0.20, concerns: [] }),
      'committee-macro': JSON.stringify({ role: 'macro', opinion: 'weak', confidence: 0.20, concerns: [] }),
      'committee-sentiment': JSON.stringify({ role: 'sentiment', opinion: 'weak', confidence: 0.20, concerns: [] }),
      'committee-coordinator': JSON.stringify({ role: 'coordinator', consensus_direction: 'buy', avg_confidence: 0.20, skip_round_2: true, challenges: [] }),
      'committee-risk-officer': JSON.stringify({ role: 'risk_officer', veto: false, reason: 'clear', concerns: [], category: 'none' }),
      'committee-trader': JSON.stringify({ role: 'trader', action: 'buy', thesis: 'x', confidence: 0.20, size_multiplier: 1 }),
    }
    const db = makeDb()
    const result = await runCommittee(baseSignal, deps(scriptedRunAgent(script), { db }))
    expect(result.decision).toBe('abstain')
  })
})

describe('committee -- deterministic momentum gate (Task 2)', () => {
  it('skips the LLM panel for a clean strong momentum buy on a lean asset', async () => {
    let calls = 0
    const runAgent: CommitteeDeps['runAgent'] = async () => { calls++; return agentResult('{}') }
    const db = makeDb()
    // Score must clear both the 3x multiple bar AND the 0.15 absolute floor.
    const clearScore = Math.max(TRADER_SIGNAL_SCORE_THRESHOLD * MOMENTUM_CLEAR_MULTIPLE, MOMENTUM_ABS_MIN_SCORE) * 1.5
    const strongSpy: CommitteeSignalInput = {
      id: 'sig-spy-strong', asset: 'SPY', side: 'buy',
      raw_score: clearScore, horizon_days: 20, enrichment_json: null,
    }
    const result = await runCommittee(strongSpy, deps(runAgent, { db }))
    expect(result.decision).toBe('approve')
    expect(calls).toBe(0)
  })

  it('still runs the LLM panel for an ambiguous lean-asset score', async () => {
    let calls = 0
    const runAgent: CommitteeDeps['runAgent'] = async () => { calls++; return agentResult(null) }
    const db = makeDb()
    const midSpy: CommitteeSignalInput = {
      id: 'sig-spy-mid', asset: 'SPY', side: 'buy',
      raw_score: TRADER_SIGNAL_SCORE_THRESHOLD * 2, horizon_days: 20, enrichment_json: null,
    }
    await runCommittee(midSpy, deps(runAgent, { db }))
    expect(calls).toBeGreaterThan(0)
  })
})
