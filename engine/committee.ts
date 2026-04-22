import { randomUUID } from 'crypto'
import { readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import type Database from 'better-sqlite3'
import { logger } from '../logger.js'
import type { AgentResult } from '../agent.js'
import { TRADER_SIGNAL_SCORE_THRESHOLD } from '../config.js'

// Dynamically import runAgent lazily so tests can mock it without forcing
// a full agent subsystem boot.
type RunAgentFn = (
  message: string,
  sessionId?: string,
  onTyping?: () => void,
  guardHarden?: boolean,
  onEvent?: (event: any) => void,
  actionPlan?: { projectId: string; source: string },
  runtimeContext?: { projectId?: string },
) => Promise<AgentResult>

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SpecialistRole = 'quant' | 'fundamentalist' | 'macro' | 'sentiment'

export interface SpecialistOpinion {
  role: SpecialistRole
  opinion: string
  confidence: number
  concerns: string[]
}

export interface CoordinatorSynthesis {
  role: 'coordinator'
  consensus_direction: 'buy' | 'sell' | 'mixed'
  avg_confidence: number
  skip_round_2: boolean
  challenges: Array<{ role: string; question: string }>
}

export interface RiskVerdict {
  role: 'risk_officer'
  veto: boolean
  reason: string
  concerns: string[]
}

export interface TraderVerdict {
  role: 'trader'
  action: 'buy' | 'sell' | 'abstain'
  thesis: string
  confidence: number
  size_multiplier: number
}

export interface Round2Response {
  role: SpecialistRole
  response: string
  updated_confidence: number
}

export interface CommitteeTranscript {
  signal_id: string
  started_at: number
  finished_at: number
  rounds_executed: number
  round_1: SpecialistOpinion[]
  coordinator?: CoordinatorSynthesis
  round_2?: Round2Response[]
  risk_officer: RiskVerdict
  trader: TraderVerdict
  errors: string[]
}

export interface CommitteeResult {
  decision: 'approve' | 'abstain'
  action: 'buy' | 'sell' | null
  thesis: string
  confidence: number
  size_usd: number
  transcript_id: string
  transcript: CommitteeTranscript
}

export interface CommitteeSignalInput {
  id: string
  asset: string
  side: 'buy' | 'sell'
  raw_score: number
  horizon_days: number
  enrichment_json: string | null
}

export interface CommitteeDeps {
  runAgent: RunAgentFn
  /** Default per-trade size in USD before the trader's size multiplier. */
  defaultSizeUsd: number
  /** Hard ceiling after multiplier. Committee never sizes past this. */
  maxSizeUsd: number
  /** Override prompt loader for tests (defaults to reading projects/trader/agents/). */
  loadPrompt?: (name: string) => string
  /**
   * Phase 2 Task 5 -- ReasoningBank retrieval.
   *
   * Optional. When provided, the string is prepended to the coordinator
   * message so the coordinator can anchor its synthesis on past similar
   * cases. Pass null or omit to skip the injection -- the committee
   * behaviour is otherwise unchanged, which keeps the path side-effect
   * free while the verdicts pipeline (Phase 3) is not yet populating
   * the bank.
   */
  pastCases?: string | null
}

// ---------------------------------------------------------------------------
// Prompt loading
// ---------------------------------------------------------------------------

const SPECIALIST_FILES: Record<SpecialistRole, string> = {
  quant: 'committee-quant.md',
  fundamentalist: 'committee-fundamentalist.md',
  macro: 'committee-macro.md',
  sentiment: 'committee-sentiment.md',
}

const SUPPORT_FILES = {
  coordinator: 'committee-coordinator.md',
  risk_officer: 'committee-risk-officer.md',
  trader: 'committee-trader.md',
} as const

function defaultLoadPrompt(name: string): string {
  const here = dirname(fileURLToPath(import.meta.url))
  // src/trader/committee.ts -> projects/trader/agents/<name>
  const projectsDir = join(here, '..', '..', 'projects', 'trader', 'agents', name)
  return readFileSync(projectsDir, 'utf8')
}

// ---------------------------------------------------------------------------
// Tolerant JSON parsing
// ---------------------------------------------------------------------------

/**
 * Extract the first `{...}` JSON object from a text blob. The agents are
 * instructed to emit only JSON, but models occasionally wrap it in prose.
 * Returns null on parse failure so callers can record the raw text as an
 * error in the transcript without blowing up.
 */
export function parseAgentJson<T>(raw: string | null | undefined): T | null {
  if (!raw) return null
  const trimmed = raw.trim()
  // Fast path
  try {
    return JSON.parse(trimmed) as T
  } catch { /* fall through */ }
  const first = trimmed.indexOf('{')
  const last = trimmed.lastIndexOf('}')
  if (first === -1 || last <= first) return null
  const slice = trimmed.slice(first, last + 1)
  try {
    return JSON.parse(slice) as T
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Signal context builder
// ---------------------------------------------------------------------------

export function buildSignalContext(signal: CommitteeSignalInput): string {
  const enrichment = signal.enrichment_json ?? '(none)'
  const absRawScore = Math.abs(signal.raw_score)
  const scoreMultiple = TRADER_SIGNAL_SCORE_THRESHOLD > 0
    ? absRawScore / TRADER_SIGNAL_SCORE_THRESHOLD
    : 0
  return [
    `SIGNAL CANDIDATE:`,
    `asset: ${signal.asset}`,
    `side: ${signal.side}`,
    `raw_score: ${signal.raw_score}`,
    `abs_raw_score: ${absRawScore}`,
    `score_threshold: ${TRADER_SIGNAL_SCORE_THRESHOLD}`,
    `score_multiple_of_threshold: ${scoreMultiple.toFixed(2)}`,
    `horizon_days: ${signal.horizon_days}`,
    `enrichment: ${enrichment}`,
  ].join('\n')
}

// ---------------------------------------------------------------------------
// Per-specialist call helper
// ---------------------------------------------------------------------------

async function callAgent(
  deps: CommitteeDeps,
  systemPrompt: string,
  userMessage: string,
  source: string,
): Promise<string | null> {
  const composed = `${systemPrompt}\n\n---\n\n${userMessage}`
  try {
    const result = await deps.runAgent(
      composed,
      undefined,
      undefined,
      false,  // guardHarden off -- this is an internal system pipeline, not a user prompt
      undefined,
      { projectId: 'trader', source },
      { projectId: 'trader' },
    )
    return result.text
  } catch (err) {
    logger.warn({ err, source }, 'Committee agent call threw')
    return null
  }
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

/**
 * Run the committee over a signal candidate and return an approve/abstain
 * decision plus a full transcript. Fail-closed: any uncaught failure in the
 * risk officer path returns abstain; any failure before the trader step
 * returns abstain.
 *
 * The committee does NOT submit the decision to the engine; it returns the
 * refined thesis/confidence/size and the caller (decision-dispatcher) plugs
 * those into the engine submit call.
 */
export async function runCommittee(
  signal: CommitteeSignalInput,
  deps: CommitteeDeps,
): Promise<CommitteeResult> {
  const loadPrompt = deps.loadPrompt ?? defaultLoadPrompt
  const startedAt = Date.now()
  const errors: string[] = []

  const context = buildSignalContext(signal)

  // ---- Round 1: four specialists in parallel ----
  const specialistRoles: SpecialistRole[] = ['quant', 'fundamentalist', 'macro', 'sentiment']

  const specialistResults = await Promise.all(
    specialistRoles.map(async (role) => {
      const prompt = loadPrompt(SPECIALIST_FILES[role])
      const raw = await callAgent(deps, prompt, `ROUND 1\n\n${context}`, `committee-${role}`)
      const parsed = parseAgentJson<SpecialistOpinion>(raw)
      if (!parsed || parsed.role !== role) {
        errors.push(`round1:${role} parse failed`)
        return null
      }
      return parsed
    }),
  )

  const round1: SpecialistOpinion[] = specialistResults.filter((o): o is SpecialistOpinion => o !== null)

  // If fewer than half the specialists produced usable opinions, abstain.
  // A blind committee call is worse than no trade.
  if (round1.length < 2) {
    return buildAbstainResult({
      signal,
      reason: 'Committee could not reach quorum (too few specialist opinions).',
      round1,
      round2: undefined,
      coordinator: undefined,
      errors,
      startedAt,
      defaultSizeUsd: deps.defaultSizeUsd,
    })
  }

  // ---- Coordinator synthesis ----
  const coordPrompt = loadPrompt(SUPPORT_FILES.coordinator)
  // Prepend ReasoningBank past cases when present. The bank stays empty
  // until Phase 3's verdicts pipeline lands, so in practice this block
  // is a no-op in Phase 2 -- but the injection point is wired so the
  // upgrade is a pure data migration.
  const pastCasesBlock = deps.pastCases ? `${deps.pastCases}\n\n` : ''
  const coordMessage =
    pastCasesBlock +
    `${context}\n\n` +
    `ROUND 1 OPINIONS:\n` +
    round1.map((o) => `- ${o.role} (conf ${o.confidence}): ${o.opinion} ` +
      (o.concerns?.length ? `concerns: ${JSON.stringify(o.concerns)}` : '')).join('\n')

  const coordRaw = await callAgent(deps, coordPrompt, coordMessage, 'committee-coordinator')
  const coordinator = parseAgentJson<CoordinatorSynthesis>(coordRaw)
  if (!coordinator) {
    errors.push('coordinator parse failed; falling back to skip_round_2=true')
  }

  let round2: Round2Response[] | undefined
  let roundsExecuted = 1

  if (coordinator && !coordinator.skip_round_2 && coordinator.challenges.length > 0) {
    const round2Results = await Promise.all(
      coordinator.challenges.map(async (c) => {
        const specialistRole = c.role as SpecialistRole
        const file = SPECIALIST_FILES[specialistRole]
        if (!file) {
          errors.push(`round2:${c.role} unknown role`)
          return null
        }
        const prompt = loadPrompt(file)
        const raw = await callAgent(
          deps,
          prompt,
          `ROUND 2 -- Coordinator challenge: ${c.question}\n\n${context}`,
          `committee-${c.role}-r2`,
        )
        // Specialists in round 2 still emit their standard opinion shape;
        // we adapt to Round2Response by mapping confidence into updated_confidence.
        const parsed = parseAgentJson<SpecialistOpinion>(raw)
        if (!parsed) {
          errors.push(`round2:${c.role} parse failed`)
          return null
        }
        return {
          role: specialistRole,
          response: parsed.opinion,
          updated_confidence: parsed.confidence,
        } satisfies Round2Response
      }),
    )
    round2 = round2Results.filter((r): r is Round2Response => r !== null)
    roundsExecuted = 2
  }

  // ---- Risk Officer final verdict ----
  const riskPrompt = loadPrompt(SUPPORT_FILES.risk_officer)
  const transcriptSoFar =
    `${context}\n\nROUND 1:\n` +
    round1.map((o) => `- ${o.role}: conf=${o.confidence} opinion="${o.opinion}" concerns=${JSON.stringify(o.concerns)}`).join('\n') +
    (coordinator ? `\n\nCOORDINATOR: direction=${coordinator.consensus_direction}, avg_confidence=${coordinator.avg_confidence}` : '') +
    (round2?.length
      ? `\n\nROUND 2:\n` + round2.map((r) => `- ${r.role}: updated_conf=${r.updated_confidence} response="${r.response}"`).join('\n')
      : '')

  const riskRaw = await callAgent(deps, riskPrompt, transcriptSoFar, 'committee-risk-officer')
  const riskVerdict = parseAgentJson<RiskVerdict>(riskRaw)
  if (!riskVerdict) {
    errors.push('risk_officer parse failed; defaulting to veto (fail-closed)')
  }
  const effectiveRisk: RiskVerdict = riskVerdict ?? {
    role: 'risk_officer',
    veto: true,
    reason: 'Risk officer output failed to parse. Fail-closed abstain.',
    concerns: ['risk_officer_parse_failed'],
  }

  if (effectiveRisk.veto) {
    return buildAbstainResult({
      signal,
      reason: `Risk officer veto: ${effectiveRisk.reason}`,
      round1,
      round2,
      coordinator: coordinator ?? undefined,
      risk: effectiveRisk,
      errors,
      startedAt,
      roundsExecuted,
      defaultSizeUsd: deps.defaultSizeUsd,
    })
  }

  // ---- Trader final decision ----
  const traderPrompt = loadPrompt(SUPPORT_FILES.trader)
  const traderMessage =
    `${transcriptSoFar}\n\n` +
    `RISK OFFICER VERDICT: veto=${effectiveRisk.veto} reason="${effectiveRisk.reason}"\n\n` +
    `Produce the final trader JSON now.`

  const traderRaw = await callAgent(deps, traderPrompt, traderMessage, 'committee-trader')
  const traderVerdict = parseAgentJson<TraderVerdict>(traderRaw)
  if (!traderVerdict) {
    errors.push('trader parse failed; abstaining')
    return buildAbstainResult({
      signal,
      reason: 'Trader output failed to parse. Abstain.',
      round1,
      round2,
      coordinator: coordinator ?? undefined,
      risk: effectiveRisk,
      errors,
      startedAt,
      roundsExecuted,
      defaultSizeUsd: deps.defaultSizeUsd,
    })
  }

  if (traderVerdict.action === 'abstain') {
    return buildAbstainResult({
      signal,
      reason: `Trader abstain: ${traderVerdict.thesis}`,
      round1,
      round2,
      coordinator: coordinator ?? undefined,
      risk: effectiveRisk,
      trader: traderVerdict,
      errors,
      startedAt,
      roundsExecuted,
      defaultSizeUsd: deps.defaultSizeUsd,
    })
  }

  const multiplier = Math.max(0, Math.min(2, traderVerdict.size_multiplier))
  const sizedUsd = Math.min(deps.maxSizeUsd, deps.defaultSizeUsd * multiplier)

  const finishedAt = Date.now()
  const transcript: CommitteeTranscript = {
    signal_id: signal.id,
    started_at: startedAt,
    finished_at: finishedAt,
    rounds_executed: roundsExecuted,
    round_1: round1,
    coordinator: coordinator ?? undefined,
    round_2: round2,
    risk_officer: effectiveRisk,
    trader: traderVerdict,
    errors,
  }

  return {
    decision: 'approve',
    action: traderVerdict.action,
    thesis: traderVerdict.thesis,
    confidence: traderVerdict.confidence,
    size_usd: sizedUsd,
    transcript_id: randomUUID(),
    transcript,
  }
}

function buildAbstainResult(args: {
  signal: CommitteeSignalInput
  reason: string
  round1: SpecialistOpinion[]
  round2?: Round2Response[]
  coordinator?: CoordinatorSynthesis
  risk?: RiskVerdict
  trader?: TraderVerdict
  errors: string[]
  startedAt: number
  roundsExecuted?: number
  defaultSizeUsd: number
}): CommitteeResult {
  const risk: RiskVerdict = args.risk ?? {
    role: 'risk_officer',
    veto: true,
    reason: args.reason,
    concerns: [],
  }
  const trader: TraderVerdict = args.trader ?? {
    role: 'trader',
    action: 'abstain',
    thesis: args.reason,
    confidence: 0,
    size_multiplier: 0,
  }
  const transcript: CommitteeTranscript = {
    signal_id: args.signal.id,
    started_at: args.startedAt,
    finished_at: Date.now(),
    rounds_executed: args.roundsExecuted ?? 1,
    round_1: args.round1,
    coordinator: args.coordinator,
    round_2: args.round2,
    risk_officer: risk,
    trader,
    errors: args.errors,
  }
  return {
    decision: 'abstain',
    action: null,
    thesis: args.reason,
    confidence: 0,
    size_usd: 0,
    transcript_id: randomUUID(),
    transcript,
  }
}

/**
 * Persist a committee transcript. Separate from runCommittee so callers can
 * decide whether to store abstains (typically yes, for audit).
 *
 * Stores in trader_committee_transcripts, keyed by the UUID the committee
 * result returned. Never throws: DB failures are logged and swallowed so a
 * transcript write error does not stop a valid trade from executing.
 */
export function storeTranscript(
  db: Database.Database,
  result: CommitteeResult,
  totals: { totalTokens?: number; totalCostUsd?: number } = {},
): void {
  try {
    db.prepare(`
      INSERT OR REPLACE INTO trader_committee_transcripts
        (id, signal_id, transcript_json, rounds, total_tokens, total_cost_usd, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      result.transcript_id,
      result.transcript.signal_id,
      JSON.stringify(result.transcript),
      result.transcript.rounds_executed,
      totals.totalTokens ?? 0,
      totals.totalCostUsd ?? 0,
      Date.now(),
    )
  } catch (err) {
    logger.error({ err, transcriptId: result.transcript_id }, 'Failed to persist committee transcript')
  }
}
