import { randomUUID } from 'crypto'
import type Database from 'better-sqlite3'
import type { EngineClient } from './engine-client.js'
import {
  runCommittee,
  storeTranscript,
  type CommitteeDeps,
  type CommitteeResult,
  type CommitteeSignalInput,
} from './committee.js'
import { DEFAULT_SIZE_USD } from './approval-manager.js'
import { classifyStrategyTier, type LadderResult } from './autonomy-ladder.js'
import { recordSignalSuppressionBySignalId } from './suppression-state.js'
import { logger } from '../logger.js'

// Phase 2 hard cap: committee can size up to this via the size_multiplier.
// Raised from $100 default in Task 9 once paper trades pass QA.
const COMMITTEE_MAX_SIZE_USD = 200

// Phase 5 Task 1 -- per-strategy live cap constants.
// Absolute ceiling applied on top of every cap source so no single
// strategy can run away with the book even if config is wrong or NAV
// is missing.
const HARD_CEILING_USD = 1000
// Fraction of NAV used as the default cap when a strategy has no
// explicit max_size_usd set (2% of portfolio NAV).
const RISK_MULTIPLIER = 0.02

interface ParsedReplyRef {
  action: 'approve' | 'skip' | 'pause'
  approvalId: string
  decisionId: string  // this is the signal_id stored in trader_approvals.decision_id
  override_size?: number
}

export interface DispatchDeps {
  /** Injectable committee runner for tests. Defaults to the real runCommittee
   *  which pulls runAgent from ../agent.js on first call. */
  runCommittee?: (signal: CommitteeSignalInput, deps: CommitteeDeps) => Promise<CommitteeResult>
  /** Injectable runAgent for tests. Defaults to a dynamic import of ../agent.js. */
  runAgent?: CommitteeDeps['runAgent']
  /** Injectable autonomy ladder classifier. Defaults to classifyStrategyTier
   *  which reads trader_strategy_track_record + recent thesis grades. Tests
   *  can stub this to bypass cold-start scaling on synthetic signals. */
  classifyTier?: (db: Database.Database, strategyId: string) => LadderResult
}

export async function dispatchApproval(
  db: Database.Database,
  parsed: ParsedReplyRef,
  engineClient?: EngineClient,
  deps: DispatchDeps = {},
): Promise<string> {
  if (parsed.action === 'skip') {
    return 'Skipped. No trade placed.'
  }

  if (parsed.action === 'pause') {
    // Look up the strategy that generated this signal rather than hardcoding the ID
    const signal = db.prepare(`SELECT strategy_id FROM trader_signals WHERE id = ?`).get(parsed.decisionId) as
      | { strategy_id: string }
      | undefined
    if (signal?.strategy_id) {
      db.prepare("UPDATE trader_strategies SET status='paused', updated_at=? WHERE id=?")
        .run(Date.now(), signal.strategy_id)
      return `Strategy '${signal.strategy_id}' paused. No new signals will be sent until you resume it.`
    }
    return 'Pause requested but signal not found -- no strategy paused.'
  }

  // action === 'approve'
  if (!engineClient) {
    const { getEngineClient } = await import('./engine-client.js')
    engineClient = getEngineClient()
  }

  const signal = db.prepare('SELECT * FROM trader_signals WHERE id = ?').get(parsed.decisionId) as any
  if (!signal) {
    return 'Error: signal not found. Trade not placed.'
  }

  const decisionId = randomUUID()
  const now = Date.now()

  // ----- Phase 2 Task 4: Committee pass replaces the Tier-0 raw-score stub -----
  // Size honors the user's override_size when present; otherwise the committee
  // decides within [0, COMMITTEE_MAX_SIZE_USD]. If the committee abstains we
  // still record a 'committee_abstain' decision so the audit trail is complete.
  const defaultSize = parsed.override_size ?? DEFAULT_SIZE_USD
  const runCommitteeImpl = deps.runCommittee ?? runCommittee
  const runAgentImpl = deps.runAgent ?? (await import('../agent.js')).runAgent

  const committeeInput: CommitteeSignalInput = {
    id: signal.id,
    asset: signal.asset,
    side: signal.side,
    raw_score: signal.raw_score,
    horizon_days: signal.horizon_days,
    enrichment_json: signal.enrichment_json ?? null,
  }

  // Phase 2 Task 5 -- ReasoningBank retrieval. Returns null until the
  // Phase 3 verdicts pipeline populates the bank, at which point this
  // call starts injecting past similar cases into the coordinator
  // prompt with no further dispatcher changes.
  let pastCases: string | null = null
  try {
    const { retrievePastCases } = await import('./reasoning-bank.js')
    pastCases = retrievePastCases(db, {
      asset: signal.asset,
      strategy: signal.strategy_id,
      side: signal.side,
      k: 3,
    })
  } catch (err) {
    logger.warn({ err, signalId: signal.id }, 'ReasoningBank retrieval failed; proceeding without past cases')
  }

  let committeeResult: CommitteeResult
  try {
    committeeResult = await runCommitteeImpl(committeeInput, {
      runAgent: runAgentImpl,
      defaultSizeUsd: defaultSize,
      maxSizeUsd: COMMITTEE_MAX_SIZE_USD,
      pastCases,
    })
  } catch (err) {
    logger.error({ err, signalId: signal.id }, 'Committee run threw; blocking trade')
    return 'Committee run failed. No trade placed.'
  }

  // Persist the transcript regardless of approve/abstain for audit.
  storeTranscript(db, committeeResult)

  if (committeeResult.decision === 'abstain') {
    db.prepare(`
      INSERT INTO trader_decisions
        (id, signal_id, action, asset, size_usd, entry_type, thesis, confidence, committee_transcript_id, decided_at, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      decisionId, signal.id, 'abstain', signal.asset,
      0, 'none',
      committeeResult.thesis,
      committeeResult.confidence,
      committeeResult.transcript_id,
      now, 'committee_abstain',
    )
    recordSignalSuppressionBySignalId(db, signal.id, 'committee_abstain', now)
    db.prepare("UPDATE trader_signals SET status='decided' WHERE id=?").run(signal.id)
    // Close any other pending signals for the same asset+side: the committee
    // verdict already covers them and they should not re-queue.
    closeSiblingPendingSignals(db, signal.id, signal.strategy_id, signal.asset, signal.side, now)
    return `Committee abstained. ${committeeResult.thesis}`
  }

  try {
    const rawSize = committeeResult.size_usd > 0 ? committeeResult.size_usd : defaultSize

    // Phase 3 Task 5 -- autonomy ladder. Apply prudent scale based on
    // the strategy's track record (cold-start, drawdown, grade trend).
    // Defaults to classifyStrategyTier; tests inject a stub.
    const classifyTierImpl = deps.classifyTier ?? classifyStrategyTier
    const tier = classifyTierImpl(db, signal.strategy_id)
    const ladderScaled = Math.round(rawSize * tier.scale * 100) / 100

    // Phase 5 Task 1 -- per-strategy live cap.
    // Priority: explicit max_size_usd > NAV * 2% fallback. A $1000 hard
    // ceiling applies on top of either so a single strategy cannot run
    // away with the book even if a bad config or missing NAV sneaks
    // through. getNav failure falls back to DEFAULT_SIZE_USD rather
    // than blocking the trade -- the engine still enforces its own
    // risk rails downstream.
    //
    // max_size_usd = 0 is treated as "cap disabled, use the NAV path"
    // so an operator zeroing the column during reset does not
    // accidentally submit a $0 order. NULL has the same meaning.
    const stratRow = db
      .prepare('SELECT max_size_usd FROM trader_strategies WHERE id = ?')
      .get(signal.strategy_id) as { max_size_usd: number | null } | undefined
    let cap: number
    if (stratRow?.max_size_usd != null && stratRow.max_size_usd > 0) {
      cap = Math.min(stratRow.max_size_usd, HARD_CEILING_USD)
    } else {
      const nav = await engineClient!.getNav().catch((err) => {
        logger.warn(
          { err, strategyId: signal.strategy_id },
          'NAV fetch failed, falling back to DEFAULT_SIZE_USD cap',
        )
        return null
      })
      const navCap = nav != null ? nav * RISK_MULTIPLIER : DEFAULT_SIZE_USD
      cap = Math.min(navCap, HARD_CEILING_USD)
    }
    const sizeUsd = Math.min(ladderScaled, cap)

    logger.info(
      { signalId: signal.id, strategyId: signal.strategy_id, tier: tier.tier, scale: tier.scale, rawSize, ladderScaled, cap, sizeUsd, reason: tier.reason },
      'Autonomy ladder + per-strategy cap applied',
    )

    const result = await engineClient!.submitDecision({
      decision_id: decisionId,
      asset: signal.asset,
      side: committeeResult.action ?? signal.side,
      size_usd: sizeUsd,
      entry_type: 'limit',
      entry_price: 0,  // engine resolves via market price
      strategy: signal.strategy_id.replace(/-stocks$/, ''),
      confidence: committeeResult.confidence,
    })

    db.prepare(`
      INSERT INTO trader_decisions
        (id, signal_id, action, asset, size_usd, entry_type, thesis, confidence, committee_transcript_id, decided_at, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      decisionId, signal.id,
      committeeResult.action ?? signal.side,
      signal.asset,
      result.approved_size_usd, 'limit',
      committeeResult.thesis,
      committeeResult.confidence,
      committeeResult.transcript_id,
      now, 'executed',
    )

    db.prepare("UPDATE trader_signals SET status='decided' WHERE id=?").run(signal.id)
    // Close any pending duplicates for the same asset+side -- trade already placed.
    closeSiblingPendingSignals(db, signal.id, signal.strategy_id, signal.asset, signal.side, now)

    return `Order placed. Asset: ${signal.asset}, Size: $${result.approved_size_usd}, Confidence: ${committeeResult.confidence.toFixed(2)}, Status: ${result.status}, ID: ${result.client_order_id.slice(0, 8)}...`
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return `Trade blocked by engine: ${msg}. No order placed.`
  }
}

/**
 * Bulk-close all pending signals for the same strategy+asset+side EXCEPT the
 * actioned signal itself. Used after a committee verdict (approve or abstain)
 * so duplicate signals from the same engine cycle don't pile up in the queue.
 * Records a committee_abstain suppression for each closed sibling so the
 * 24-hour cooldown prevents immediate re-alerts.
 */
function closeSiblingPendingSignals(
  db: Database.Database,
  excludeSignalId: string,
  strategyId: string,
  asset: string,
  side: string,
  now = Date.now(),
): void {
  const siblings = db.prepare(`
    SELECT id FROM trader_signals
    WHERE strategy_id = ? AND asset = ? AND side = ? AND status = 'pending'
      AND id != ?
  `).all(strategyId, asset, side, excludeSignalId) as { id: string }[]

  if (siblings.length === 0) return

  db.prepare(`
    UPDATE trader_signals
    SET status = 'decided'
    WHERE strategy_id = ? AND asset = ? AND side = ? AND status = 'pending'
      AND id != ?
  `).run(strategyId, asset, side, excludeSignalId)

  for (const s of siblings) {
    recordSignalSuppressionBySignalId(db, s.id, 'committee_abstain', now)
  }

  logger.info({ strategyId, asset, side, count: siblings.length }, 'Closed sibling pending signals after committee verdict')
}
