import { randomUUID } from 'crypto'
import { readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import type Database from 'better-sqlite3'
import { logger } from '../logger.js'
import type { AgentResult } from '../agent.js'
import { TRADER_SIGNAL_SCORE_THRESHOLD } from '../config.js'
import { rollupRecentOutcomes, type AssetClass } from './reasoning-bank.js'
import type { MarkovRegimePayload } from './types.js'
import type { SignalEnrichment } from './enrichment-fetcher.js'

// ---------------------------------------------------------------------------
// Rollup helpers (Task 8)
// ---------------------------------------------------------------------------

function assetClassForStrategy(db: Database.Database | undefined, strategyId: string | null): AssetClass {
  if (!db || !strategyId) return 'equity'
  try {
    const row = db.prepare('SELECT asset_class FROM trader_strategies WHERE id = ?').get(strategyId) as { asset_class?: string } | undefined
    return row?.asset_class === 'crypto' ? 'crypto' : 'equity'
  } catch {
    return 'equity'
  }
}

function buildRollupBlock(db: Database.Database | undefined, assetClass: AssetClass): string {
  if (!db) return ''
  try {
    const rollup = rollupRecentOutcomes(db, assetClass, 20)
    if (rollup.total === 0) return ''
    return [
      '=== RECENT PAPER TRADE OUTCOMES ===',
      rollup.formatted,
      '===================================',
      '',
    ].join('\n')
  } catch {
    return ''
  }
}

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

/**
 * Reason category the risk officer attaches to a verdict. Lets downstream
 * gates (e.g. Markov tiebreaker) treat "disagreement" vetoes differently
 * from genuine event-risk vetoes without keyword-matching free-text.
 *
 * - disagreement: specialists split / low avg confidence / weak conviction
 * - event_risk:   earnings, halt, SEC action, regulatory headline
 * - confidence:   below absolute confidence floor
 * - size:         circuit breaker / position-size breach
 * - data:         missing critical risk data
 * - none:         no veto (or category not provided)
 */
export type RiskVetoCategory =
  | 'disagreement'
  | 'event_risk'
  | 'confidence'
  | 'size'
  | 'data'
  | 'none'

export interface RiskVerdict {
  role: 'risk_officer'
  veto: boolean
  reason: string
  concerns: string[]
  /**
   * Optional category for the verdict. Older / parse-degraded LLM outputs
   * may omit this; callers must handle absence (see classifyVetoCategory).
   */
  category?: RiskVetoCategory
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
  /** Strategy that produced this signal. Used to apply strategy-aware gate logic. */
  strategy_id?: string
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
  /**
   * Phase 2 Task 8 -- ReasoningBank rollup injection.
   *
   * Optional. When provided, the rollup of recent paper trade outcomes
   * is prepended to ALL specialist, coordinator, risk officer, and trader
   * prompts so every LLM call in the committee sees aggregate P&L context.
   */
  db?: Database.Database
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
// Markov regime helpers
// ---------------------------------------------------------------------------

/**
 * Extract the markov_regime payload from a signal's enrichment_json string.
 * Returns null on any parse failure or if the field is absent -- callers
 * treat null as "no opinion".
 */
function parseMarkovRegime(enrichmentJson: string | null): MarkovRegimePayload | null {
  if (!enrichmentJson) return null
  try {
    const parsed = JSON.parse(enrichmentJson) as Partial<SignalEnrichment>
    const regime = parsed.markov_regime
    if (!regime || typeof regime !== 'object') return null
    if (typeof regime.markov_signal !== 'number') return null
    return regime as MarkovRegimePayload
  } catch {
    return null
  }
}

/**
 * Deterministic risk gate that runs AFTER the LLM risk officer verdict.
 *
 * Hard vetoes (always enforced, override everything including LLM clears):
 *   - avg committee confidence below 0.30
 *
 * Markov tiebreaker (when enrichment.markov_regime is present):
 *   - If Markov conflicts with the proposed action by > 0.30
 *     (buy + markov_signal <= -0.30, OR sell + markov_signal >= 0.30) → veto.
 *   - If Markov agrees or is neutral AND the LLM vetoed → clear the veto.
 *     The LLM disagreement-veto is replaced; LLM event-risk vetoes (earnings,
 *     halt) are NOT cleared here because Markov agreement only speaks to
 *     regime direction, not idiosyncratic event risk.  The caller decides
 *     which LLM vetoes are regime-type by passing llmVetoed=true only when
 *     the LLM veto reason matches a disagreement pattern.
 *
 * No-Markov fallback (when enrichment.markov_regime is absent):
 *   - Add a veto when avg confidence < 0.45 (raised floor vs old "any split").
 *   - When avg confidence >= 0.45 the gate returns null, deferring to the LLM.
 *     This preserves genuine event-risk vetoes from the LLM in the no-Markov path.
 *
 * Returns null when no deterministic override needed (LLM verdict stands).
 * Returns a RiskVerdict when the gate fires.
 */

/**
 * Classify a risk officer veto into a category.
 *
 * Prefers the structured `category` field on the verdict (returned by the
 * current risk officer prompt). When absent (older prompts, fallback paths,
 * or parse-degraded outputs), falls back to keyword matching on the reason
 * text with word boundaries to avoid the "no conflict" matches "conflict"
 * class of false positives.
 *
 * Keyword fallback is intentionally narrow: only fires on whole-word hits
 * for disagreement-shaped reasons.  Anything else, including event_risk
 * keywords, falls through to 'none' so the gate treats the LLM veto as
 * non-overridable.
 */
export function classifyVetoCategory(v: RiskVerdict): RiskVetoCategory {
  if (v.category) return v.category
  if (!v.veto) return 'none'
  const reason = (v.reason ?? '').toLowerCase()
  // Strip easy negations so "no disagreement" / "not split" don't match.
  const stripped = reason.replace(/\b(no|not|without)\s+\w+/g, '')
  const disagreementWords = [
    'disagree', 'disagreement',
    'split', 'splits',
    'diverge', 'divergent', 'divergence',
    'conflict', 'conflicting',
    'mixed',
    'thin conviction',
    'low conviction',
    'low confidence',
    'weak consensus',
  ]
  // Whole-word match (handles "thin conviction" as a phrase too).
  const hit = disagreementWords.some((w) => {
    const pattern = new RegExp(`\\b${w.replace(/\s+/g, '\\s+')}\\b`)
    return pattern.test(stripped)
  })
  return hit ? 'disagreement' : 'none'
}

function applyDeterministicRiskGate(
  action: 'buy' | 'sell',
  avgConfidence: number,
  markov: MarkovRegimePayload | null,
  llmVetoedOnDisagreement: boolean,
  strategyId?: string,
): RiskVerdict | null {
  // Hard veto: avg confidence below absolute floor (0.30) -- beats everything.
  if (avgConfidence < 0.30) {
    return {
      role: 'risk_officer',
      veto: true,
      reason: `Hard veto: avg committee confidence ${avgConfidence.toFixed(2)} below 0.30 floor.`,
      concerns: [`risk_officer_hard_confidence_floor_${avgConfidence.toFixed(2)}`],
    }
  }

  // Mean-reversion strategies skip the Markov conflict veto: a bear/oversold
  // regime is the entry condition, not a contraindication. Mirrors the pre-gate
  // bypass in decision-dispatcher.ts.
  const isMeanReversion = (strategyId ?? '').startsWith('mean-reversion')

  if (markov !== null) {
    const markovSignal = markov.markov_signal

    // Markov conflicts with proposed action → veto regardless of LLM.
    // Threshold loosened -0.30 -> -0.15 (2026-06-28). MUST mirror the Markov
    // pre-gate in decision-dispatcher.ts.
    // Skipped for mean-reversion: oversold/bear regime is the buy entry.
    const conflicts =
      !isMeanReversion &&
      ((action === 'buy'  && markovSignal <= -0.15) ||
       (action === 'sell' && markovSignal >=  0.15))

    if (conflicts) {
      return {
        role: 'risk_officer',
        veto: true,
        reason: `Markov regime conflicts with ${action} action (markov_signal=${markovSignal.toFixed(3)}).`,
        concerns: [`risk_officer_markov_conflict_${markovSignal.toFixed(3)}`],
      }
    }

    // Markov agrees/neutral. If the LLM fired a disagreement-type veto, clear it.
    // If the LLM fired a genuine event-risk veto (earnings, halt), leave it alone.
    if (llmVetoedOnDisagreement) {
      return {
        role: 'risk_officer',
        veto: false,
        reason: `Markov regime supports ${action} (markov_signal=${markovSignal.toFixed(3)}); specialist disagreement overridden.`,
        concerns: [],
      }
    }

    // LLM did not veto on disagreement (either no-veto or event-risk veto) -- no override.
    return null
  }

  // No Markov data: the single hard floor (0.30, checked above) already
  // governs. Do not stack a second, higher floor here -- four independent
  // 0..1 specialist confidences average 0.30-0.50, so a 0.45 floor vetoed
  // the majority of valid signals. The LLM risk officer keeps soft judgment.

  // No Markov, confidence acceptable -- no deterministic override.
  return null
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

/**
 * Thrown when runAgent REFUSED to run (kill switch / cost cap), as opposed to
 * running and returning bad output. Callers must NOT treat this as a parse
 * failure: during the Jun 8-11 2026 dashboard outage every refusal was
 * recorded as "parse failed" -> quorum fail -> committee_abstain, which
 * suppressed real signals for 24h and buried the actual outage.
 */
export class CommitteeGatedError extends Error {
  constructor(reason: string) {
    super(`Committee gated: ${reason}`)
    this.name = 'CommitteeGatedError'
  }
}

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
    if (result.resultSubtype === 'refused') {
      throw new CommitteeGatedError(result.emptyReason ?? result.text ?? 'agent refused')
    }
    return result.text
  } catch (err) {
    if (err instanceof CommitteeGatedError) throw err
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

  // Task 8: compute rollup block once; prepend to every LLM-bound prompt.
  const assetClass = assetClassForStrategy(deps.db, (signal as any).strategy_id ?? null)
  const rollupBlock = buildRollupBlock(deps.db, assetClass)

  // ---- Round 1: specialists in parallel ----
  // Index ETFs (liquid momentum signals on SPY/QQQ/etc.) use quant-only:
  // fundamentalist/macro/sentiment add mixed-direction noise on pure
  // technical momentum signals, driving committee abstain without adding
  // edge. Full committee for individual stocks and crypto.
  // Lean-committee assets: quant-only instead of the full four-specialist panel.
  // Index ETFs: fundamentalist/macro/sentiment add mixed-direction noise on pure
  // technical momentum signals for liquid index products.
  // Crypto pairs (asset contains '/'): engine serves no price bars so specialists
  // receive Markov-only enrichment — only quant can usefully evaluate that signal.
  // NOTE: This list is intentionally narrower than CLUSTER_MAP in correlation-gate.ts.
  // INDEX_ETFS gates the committee fast-path (lean assets skip the LLM panel).
  // CLUSTER_MAP gates gross-exposure per cluster (includes single stocks AAPL/MSFT/NVDA
  // which move with SPY/QQQ). Two separate concerns; keep them in sync deliberately,
  // not automatically. If you add a ticker here, ask whether it also belongs in CLUSTER_MAP.
  const INDEX_ETFS = new Set(['SPY', 'QQQ', 'IWM', 'DIA', 'VTI', 'VOO'])
  const asset = signal.asset ?? ''
  const isLeanAsset = INDEX_ETFS.has(asset.toUpperCase()) || asset.includes('/')

  // Deterministic momentum gate: clean, strong buys on lean assets skip the
  // LLM panel entirely (faster, cheaper, no parse-failure abstains). Only
  // ambiguous cases ('escalate') fall through to the committee below.
  if (isLeanAsset && signal.side === 'buy') {
    const { evaluateMomentumGate } = await import('./momentum-gate.js')
    const gate = evaluateMomentumGate(signal as typeof signal & { side: 'buy' })
    if (gate.outcome === 'deterministic-approve') {
      const finishedAt = Date.now()
      const transcript: CommitteeTranscript = {
        signal_id: signal.id,
        started_at: startedAt,
        finished_at: finishedAt,
        rounds_executed: 0,
        round_1: [],
        risk_officer: { role: 'risk_officer', veto: false, reason: `deterministic momentum gate: ${gate.reason}`, concerns: [] },
        trader: { role: 'trader', action: 'buy', thesis: gate.reason, confidence: gate.confidence, size_multiplier: 1 },
        errors: [],
      }
      return {
        decision: 'approve',
        action: 'buy',
        thesis: `Deterministic momentum entry. ${gate.reason}`,
        confidence: gate.confidence,
        size_usd: Math.min(deps.maxSizeUsd, deps.defaultSizeUsd),
        transcript_id: randomUUID(),
        transcript,
      }
    }
    if (gate.outcome === 'deterministic-abstain') {
      return buildAbstainResult({
        signal,
        reason: `Deterministic momentum gate abstain: ${gate.reason}`,
        round1: [],
        round2: undefined,
        coordinator: undefined,
        errors,
        startedAt,
        defaultSizeUsd: deps.defaultSizeUsd,
      })
    }
    // gate.outcome === 'escalate' -> fall through to the LLM committee.
  }

  const specialistRoles: SpecialistRole[] = isLeanAsset
    ? ['quant']
    : ['quant', 'fundamentalist', 'macro', 'sentiment']

  const specialistResults = await Promise.all(
    specialistRoles.map(async (role) => {
      const prompt = rollupBlock + loadPrompt(SPECIALIST_FILES[role])
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
  // Quorum is relative to how many specialists were requested so that the
  // quant-only path (1 specialist) does not always fail this check.
  const quorumNeeded = Math.ceil(specialistRoles.length / 2)
  if (round1.length < quorumNeeded) {
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
  const coordPrompt = rollupBlock + loadPrompt(SUPPORT_FILES.coordinator)
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
        const prompt = rollupBlock + loadPrompt(file)
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
  const riskPrompt = rollupBlock + loadPrompt(SUPPORT_FILES.risk_officer)
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

  // Deterministic Markov gate -- runs after LLM verdict, may override it.
  // The gate is skipped when the LLM failed to parse (fail-closed stays).
  if (riskVerdict) {
    const markov = parseMarkovRegime(signal.enrichment_json)
    // When coordinator is null (parse failed), use 0.30 -- the single hard
    // floor. avgConfidence < 0.30 still hard-vetoes; >= 0.30 defers to the
    // Markov gate (if regime data present) and the LLM risk officer verdict.
    // Coordinator parse failure must not auto-abstain via a fabricated default.
    const avgConf = coordinator?.avg_confidence ?? 0.30
    // Proposed action comes from the coordinator direction; fall back to signal side.
    const proposedAction: 'buy' | 'sell' =
      coordinator?.consensus_direction === 'buy' || coordinator?.consensus_direction === 'sell'
        ? coordinator.consensus_direction
        : signal.side
    // Classify whether the LLM veto was disagreement-type so the gate knows
    // whether to clear it when Markov agrees. Any other category (earnings,
    // halt, sector risk) is treated as a genuine event-risk veto and preserved.
    //
    // Prefer the structured `category` field; fall back to word-boundary
    // keyword matching on the reason text when the LLM omits it (older
    // prompts or parse-degraded outputs).
    const llmVetoedOnDisagreement =
      riskVerdict.veto && classifyVetoCategory(riskVerdict) === 'disagreement'
    const gateVerdict = applyDeterministicRiskGate(proposedAction, avgConf, markov, llmVetoedOnDisagreement, signal.strategy_id)
    if (gateVerdict !== null) {
      logger.debug(
        { gateVeto: gateVerdict.veto, reason: gateVerdict.reason, markovSignal: markov?.markov_signal },
        'Committee deterministic risk gate fired',
      )
      // Replace the LLM verdict with the gate verdict.
      Object.assign(effectiveRisk, gateVerdict)
    }
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
  const traderPrompt = rollupBlock + loadPrompt(SUPPORT_FILES.trader)
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
