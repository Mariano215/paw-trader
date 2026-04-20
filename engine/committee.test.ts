import { describe, it, expect, beforeEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import { initTraderTables } from './db.js'
import {
  runCommittee,
  storeTranscript,
  parseAgentJson,
  buildSignalContext,
  type CommitteeDeps,
  type CommitteeSignalInput,
} from './committee.js'
import type { AgentResult } from '../agent.js'

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
    expect(ctx).toContain('enrichment: {"rsi":45}')
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
