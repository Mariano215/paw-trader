import { randomUUID } from 'crypto'
import type Database from 'better-sqlite3'
import type { EngineClient } from './engine-client.js'
import type { EnginePosition } from './types.js'
import {
  runCommittee,
  storeTranscript,
  CommitteeGatedError,
  type CommitteeDeps,
  type CommitteeResult,
  type CommitteeSignalInput,
  type CommitteeTranscript,
} from './committee.js'
import { DEFAULT_SIZE_USD } from './approval-manager.js'
import { classifyStrategyTier, type LadderResult } from './autonomy-ladder.js'
import { recordSignalSuppressionBySignalId } from './suppression-state.js'
import { isTerminalSubmitError, DECISION_STATUS } from './order-lifecycle.js'
import { logger } from '../logger.js'
import {
  TRADER_COMMITTEE_BYPASS,
  TRADER_BYPASS_TRADE_TARGET,
  TRADER_DAILY_TRADE_CAP,
  TRADER_STRATEGY_GATE_ENABLED,
} from '../config.js'
import { decideGatedTrade } from './strategy/gate-decision.js'
import {
  countBypassTrades,
  countTradesToday,
  invalidateCounters,
} from './bypass-counter.js'
import { computeExits } from './exit-calculator.js'
import { HARD_CEILING_USD } from './trader-constants.js'

export interface AutoDispatchResult {
  signalId:  string
  asset:     string
  side:      'buy' | 'sell'
  action:    'executed' | 'suppressed' | 'skipped'
  reason:    string
  sizeUsd?:  number
  strategy?: string
}

// Phase 2 hard cap: committee can size up to this via the size_multiplier.
// Raised from $100 default in Task 9 once paper trades pass QA; lifted to
// $2500 on 2026-06-11 alongside HARD_CEILING_USD + the engine per-trade cap
// (operator decision: risk model owns sizing for the paper evaluation).
const COMMITTEE_MAX_SIZE_USD = 2500

// Phase 5 Task 1 -- per-strategy live cap constants.
// Absolute ceiling applied on top of every cap source so no single
// strategy can run away with the book even if config is wrong or NAV
// is missing. Defined in trader-constants.ts (shared with strategy gate).
// Fraction of NAV used as the default cap when a strategy has no
// explicit max_size_usd set (2% of portfolio NAV).
const RISK_MULTIPLIER = 0.02

interface ParsedReplyRef {
  action: 'approve' | 'skip' | 'pause'
  approvalId: string
  decisionId: string  // this is the signal_id stored in trader_approvals.decision_id
  override_size?: number
}

type StrategyGateResult =
  | { suppressed: true; reason: string }
  | { suppressed: false; sizeUsd: number }

/**
 * Shared strategy-gate block: regime filter + risk sizing.
 * Called from both dispatchApproval and autoDispatchPendingSignals so the
 * filter is symmetric across both execution paths.
 *
 * Uses the already-fetched nav to avoid a second getNav() round-trip (#4).
 * Records signal suppression when the regime gate fires (#3).
 * Only applies Math.min shrinkage when gate.sizeUsd is non-null, so a
 * non-buy pass-through (sizeUsd=null) never zeroes the order (#1).
 * Returns early (suppressed=true) so the caller can suppress/continue
 * without submitting. Returns suppressed=false with the (possibly shrunk)
 * sizeUsd when the gate allows the trade.
 *
 * On any fetch failure the gate is skipped and the legacy size is returned
 * unchanged (fail toward the existing, already-capped path).
 */
async function applyStrategyGate(
  db: Database.Database,
  engineClient: EngineClient,
  signalId: string,
  asset: string,
  side: 'buy' | 'sell',
  nav: number | null,
  currentSizeUsd: number,
  now: number,
): Promise<StrategyGateResult> {
  if (!TRADER_STRATEGY_GATE_ENABLED) {
    return { suppressed: false, sizeUsd: currentSizeUsd }
  }

  const toMs = Date.now()
  const fromMs = toMs - 400 * 24 * 60 * 60 * 1000  // ~400 calendar days -> ~260 bars
  const gateBars = await engineClient.getPrices(asset, fromMs, toMs).catch(() => [])

  // Use already-fetched nav; skip gate entirely on missing/zero NAV or no bars.
  if (gateBars.length === 0 || nav == null || nav <= 0) {
    return { suppressed: false, sizeUsd: currentSizeUsd }
  }

  const lastClose = gateBars[gateBars.length - 1].close
  const gate = decideGatedTrade({
    asset,
    side,
    bars: gateBars,
    entryPrice: lastClose,
    navUsd: nav,
    openRiskUsd: 0,  // TODO: real open-risk needs per-position stops; 0 until fills land
  })
  logger.info({ signalId, asset, gate }, 'Strategy gate evaluated')

  if (!gate.allow) {
    db.prepare("UPDATE trader_signals SET status='suppressed_regime' WHERE id=?").run(signalId)
    recordSignalSuppressionBySignalId(db, signalId, 'regime', now)
    return { suppressed: true, reason: gate.reason }
  }

  // Only shrink when the gate produced a size recommendation (non-null = buy path).
  // A null sizeUsd means non-buy pass-through: leave currentSizeUsd untouched.
  const sizeUsd = gate.sizeUsd != null
    ? Math.min(currentSizeUsd, gate.sizeUsd)
    : currentSizeUsd
  return { suppressed: false, sizeUsd }
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
    strategy_id: signal.strategy_id,
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

  // Gate 1: daily cap (applies regardless of bypass mode)
  const dailyCount = countTradesToday(db)
  if (dailyCount >= TRADER_DAILY_TRADE_CAP) {
    logger.warn(
      { event: 'trader.cap.daily_hit', signalId: signal.id, dailyCount, cap: TRADER_DAILY_TRADE_CAP },
      'daily cap reached, suppressing',
    )
    db.prepare("UPDATE trader_signals SET status = 'suppressed_daily_cap' WHERE id = ?").run(signal.id)
    return 'Daily trade cap reached. No trade placed.'
  }

  // Gate 2: bypass branch (only while under target)
  const bypass = TRADER_COMMITTEE_BYPASS
  const bypassCount = bypass ? countBypassTrades(db) : 0
  const useBypass = bypass && bypassCount < TRADER_BYPASS_TRADE_TARGET

  let committeeResult: CommitteeResult
  if (useBypass) {
    const tag = `[BYPASS#${bypassCount + 1}/${TRADER_BYPASS_TRADE_TARGET}]`
    logger.warn(
      { event: 'trader.bypass.dispatched', signalId: signal.id, asset: signal.asset, bypassCount: bypassCount + 1, target: TRADER_BYPASS_TRADE_TARGET },
      `TRADER_COMMITTEE_BYPASS active — ${tag} (paper mode)`,
    )
    if (bypassCount + 1 === TRADER_BYPASS_TRADE_TARGET) {
      logger.warn(
        { event: 'trader.bypass.target_reached', count: TRADER_BYPASS_TRADE_TARGET },
        'bypass target reached, next signal will use committee',
      )
    }
    const bypassTs = Date.now()
    committeeResult = {
      decision:      'approve',
      action:        signal.side as 'buy' | 'sell',
      size_usd:      defaultSize,
      confidence:    1.0,
      thesis:        `${tag} Committee skipped via TRADER_COMMITTEE_BYPASS. Paper mode only.`,
      transcript_id: randomUUID(),
      transcript: {
        signal_id:       signal.id,
        started_at:      bypassTs,
        finished_at:     bypassTs,
        rounds_executed: 0,
        round_1:         [],
        risk_officer:    { role: 'risk_officer', veto: false, reason: 'bypassed', concerns: [] },
        trader:          { role: 'trader', action: signal.side as 'buy' | 'sell', thesis: 'bypassed', confidence: 1.0, size_multiplier: 1 },
        errors:          [],
      } satisfies CommitteeTranscript,
    }
    invalidateCounters()
  } else {
    try {
      committeeResult = await runCommitteeImpl(committeeInput, {
        runAgent: runAgentImpl,
        defaultSizeUsd: defaultSize,
        maxSizeUsd: COMMITTEE_MAX_SIZE_USD,
        pastCases,
        db,
      })
    } catch (err) {
      logger.error({ err, signalId: signal.id }, 'Committee run threw; blocking trade')
      return 'Committee run failed. No trade placed.'
    }

    // Persist the transcript regardless of approve/abstain for audit.
    storeTranscript(db, committeeResult)
  }

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
    // Fetch NAV and positions once; reuse for both the cap calculation and
    // risk sizing so diverging values cannot cause the sizing to bypass the cap
    // derived from a different NAV snapshot.
    const manualNavForSize = await engineClient!.getNav().catch((err) => {
      logger.warn(
        { err, strategyId: signal.strategy_id },
        'NAV fetch failed, falling back to DEFAULT_SIZE_USD cap',
      )
      return null
    })
    const manualSizePositions = await engineClient!.getPositions().catch(() => [] as EnginePosition[])

    const stratRow = db
      .prepare('SELECT max_size_usd FROM trader_strategies WHERE id = ?')
      .get(signal.strategy_id) as { max_size_usd: number | null } | undefined
    let cap: number
    if (stratRow?.max_size_usd != null && stratRow.max_size_usd > 0) {
      cap = Math.min(stratRow.max_size_usd, HARD_CEILING_USD)
    } else {
      // Treat null OR non-positive NAV as "no usable NAV" so cold-start
      // engines (no positions, no snapshots -> nav=0) fall back to the
      // hard default cap instead of zeroing the cap and submitting
      // size_usd=0, which the engine rejects with 422 position_sizer.
      const navUsable = manualNavForSize != null && manualNavForSize > 0
      const navCap = navUsable ? manualNavForSize * RISK_MULTIPLIER : DEFAULT_SIZE_USD
      cap = Math.min(navCap, HARD_CEILING_USD)
    }
    const { computeRiskBasedSize } = await import('./risk-sizing.js')
    const manualRiskSize = computeRiskBasedSize({
      nav: manualNavForSize,
      positions: manualSizePositions,
      // Keep the autonomy ladder (ladderScaled) as an upper bound so cold-start
      // strategies are still scaled down relative to the risk-sized amount.
      capUsd: Math.min(cap, ladderScaled > 0 ? ladderScaled : cap),
      floorUsd: DEFAULT_SIZE_USD,
    })
    if (manualRiskSize.sizeUsd <= 0) {
      db.prepare("UPDATE trader_signals SET status = 'suppressed_portfolio_heat' WHERE id = ?").run(signal.id)
      recordSignalSuppressionBySignalId(db, signal.id, 'portfolio_heat', now)
      return `Trade blocked: ${manualRiskSize.reason}. No order placed.`
    }
    const sizeUsd = manualRiskSize.sizeUsd

    let entryRef = 0
    if (signal.enrichment_json) {
      try {
        const e = JSON.parse(signal.enrichment_json) as { price_current?: number | null }
        if (typeof e.price_current === 'number' && e.price_current > 0) entryRef = e.price_current
      } catch { /* malformed enrichment -> entryRef stays 0 */ }
    }
    const exits = computeExits({
      side: (committeeResult.action ?? signal.side) as 'buy' | 'sell',
      entryPrice: entryRef,
      horizonDays: signal.horizon_days,
      enrichment: signal.enrichment_json ?? null,
    })

    logger.info(
      { signalId: signal.id, strategyId: signal.strategy_id, tier: tier.tier, scale: tier.scale, rawSize, ladderScaled, cap, sizeUsd, reason: tier.reason },
      'Autonomy ladder + risk sizing applied',
    )

    // Correlation-cluster exposure gate -- uses already-fetched positions and NAV.
    // Product decision: TRIM to headroom rather than block. Suppress only when
    // headroom <= 0 (cluster already at or over cap).
    let finalSizeUsd = sizeUsd
    {
      const { evaluateClusterGate, evaluateSymbolGate } = await import('./correlation-gate.js')
      const clusterGate = evaluateClusterGate({
        asset: signal.asset,
        proposedSizeUsd: sizeUsd,
        positions: manualSizePositions,
        nav: manualNavForSize,
      })
      if (!clusterGate.allowed) {
        if (clusterGate.allowedSizeUsd <= 0) {
          db.prepare("UPDATE trader_signals SET status = 'suppressed_cluster_cap' WHERE id = ?").run(signal.id)
          recordSignalSuppressionBySignalId(db, signal.id, 'cluster_cap', now)
          return `Trade blocked: ${clusterGate.reason}. No order placed.`
        }
        // Headroom > 0: trim to allowedSizeUsd and proceed.
        finalSizeUsd = Math.round(clusterGate.allowedSizeUsd * 100) / 100
        logger.info(
          { signalId: signal.id, original: sizeUsd, trimmed: finalSizeUsd, cluster: clusterGate.cluster },
          'cluster cap: trimmed order to headroom',
        )
      }

      // Per-symbol gate, tighter than the cluster gate -- stops one ticker
      // (e.g. a singleton-cluster symbol) from repeatedly absorbing signals
      // until it alone accounts for most of the book's exposure.
      const symbolGate = evaluateSymbolGate({
        asset: signal.asset,
        proposedSizeUsd: finalSizeUsd,
        positions: manualSizePositions,
        nav: manualNavForSize,
      })
      if (!symbolGate.allowed) {
        if (symbolGate.allowedSizeUsd <= 0) {
          db.prepare("UPDATE trader_signals SET status = 'suppressed_symbol_cap' WHERE id = ?").run(signal.id)
          recordSignalSuppressionBySignalId(db, signal.id, 'symbol_cap', now)
          return `Trade blocked: ${symbolGate.reason}. No order placed.`
        }
        finalSizeUsd = Math.round(symbolGate.allowedSizeUsd * 100) / 100
        logger.info(
          { signalId: signal.id, trimmed: finalSizeUsd, symbol: symbolGate.cluster },
          'symbol cap: trimmed order to headroom',
        )
      }
    }

    // Strategy gate (regime filter + fixed-fractional sizing). Shared helper
    // used by both dispatchApproval and autoDispatchPendingSignals. Reuses the
    // already-fetched manualNavForSize -- no second getNav() round-trip.
    {
      const gateResult = await applyStrategyGate(
        db, engineClient!, signal.id,
        signal.asset,
        (committeeResult.action ?? signal.side) as 'buy' | 'sell',
        manualNavForSize,
        finalSizeUsd,
        now,
      )
      if (gateResult.suppressed) {
        return `Suppressed by strategy gate: ${gateResult.reason}`
      }
      finalSizeUsd = gateResult.sizeUsd
    }

    const result = await engineClient!.submitDecision({
      decision_id: decisionId,
      asset: signal.asset,
      side: committeeResult.action ?? signal.side,
      size_usd: finalSizeUsd,
      entry_type: 'limit',
      entry_price: entryRef,
      ...(exits.stopLoss != null ? { stop_loss: exits.stopLoss } : {}),
      ...(exits.takeProfit != null ? { take_profit: exits.takeProfit } : {}),
      strategy: signal.strategy_id.replace(/-stocks$/, ''),
      confidence: committeeResult.confidence,
    })

    db.prepare(`
      INSERT INTO trader_decisions
        (id, signal_id, action, asset, size_usd, entry_type, entry_price, stop_loss, take_profit, thesis, confidence, committee_transcript_id, decided_at, status, engine_order_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      decisionId, signal.id,
      committeeResult.action ?? signal.side,
      signal.asset,
      result.approved_size_usd, 'limit',
      entryRef,
      exits.stopLoss,
      exits.takeProfit,
      committeeResult.thesis,
      committeeResult.confidence,
      committeeResult.transcript_id,
      now, 'submitted',
      result.broker_order_id ?? null,
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

export interface AutoDispatchDeps {
  send:           (text: string) => Promise<void>
  runCommittee?:  (signal: CommitteeSignalInput, deps: CommitteeDeps) => Promise<CommitteeResult>
  runAgent?:      CommitteeDeps['runAgent']
  alertOnReject?: boolean
}

export async function autoDispatchPendingSignals(
  db: Database.Database,
  deps: AutoDispatchDeps,
  engineClient?: EngineClient,
): Promise<AutoDispatchResult[]> {
  // ORDER BY raw_score DESC is load-bearing: it makes the daily cap rank-aware
  // within a tick -- the strongest signals are dispatched first, so when the
  // cap is hit the suppressed remainder are the weakest, not the latest ones.
  const pending = db.prepare(
    "SELECT * FROM trader_signals WHERE status = 'pending' ORDER BY raw_score DESC",
  ).all() as any[]

  if (pending.length === 0) return []

  const results: AutoDispatchResult[] = []

  for (const signal of pending) {
    // Atomic claim -- if another dispatch already grabbed it, changes === 0
    const claimed = db.prepare(
      "UPDATE trader_signals SET status = 'dispatching' WHERE id = ? AND status = 'pending'",
    ).run(signal.id)
    if (claimed.changes === 0) continue

    try {
      const strategy = db.prepare(
        'SELECT id, name, tier, status FROM trader_strategies WHERE id = ?',
      ).get(signal.strategy_id) as { id: string; name: string; tier: number; status: string } | undefined

      if (!strategy || strategy.status === 'paused') {
        db.prepare("UPDATE trader_signals SET status = 'suppressed_strategy_paused' WHERE id = ?")
          .run(signal.id)
        continue
      }

      // Gate 0: Markov regime pre-filter (deterministic, no LLM cost).
      // Skipped for mean-reversion strategies: a bear/oversold regime is the
      // entry condition for mean reversion, not a contraindication. The SMA
      // regime gate and committee still protect those signals downstream.
      // For all other strategies: suppress if Markov strongly contradicts
      // the signal direction -- committee would veto anyway, skip LLM cost.
      const isMeanReversion = strategy.id.startsWith('mean-reversion')
      if (!isMeanReversion && signal.enrichment_json) {
        try {
          const enrichment = JSON.parse(signal.enrichment_json) as Record<string, unknown>
          const regime = enrichment?.markov_regime as { markov_signal?: number } | undefined
          const markovSignal = typeof regime?.markov_signal === 'number' ? regime.markov_signal : null
          if (markovSignal !== null) {
            const isBuy = signal.side === 'buy'
            // Threshold loosened -0.30 -> -0.15 (2026-06-28) to unfreeze the
            // ~45% of signals this pre-gate suppressed. MUST stay in sync with
            // the risk-officer mirror in committee.ts.
            const regimeConflict = (isBuy && markovSignal <= -0.15) || (!isBuy && markovSignal >= 0.15)
            if (regimeConflict) {
              logger.info(
                { signalId: signal.id, asset: signal.asset, side: signal.side, markovSignal },
                'Trader: Markov pre-gate suppressed signal',
              )
              db.prepare("UPDATE trader_signals SET status = 'suppressed_markov_gate' WHERE id = ?")
                .run(signal.id)
              recordSignalSuppressionBySignalId(db, signal.id, 'markov_gate')
              continue
            }
          }
        } catch {
          // Malformed enrichment JSON -- skip the gate, let committee decide.
        }
      }

      const committeeInput: CommitteeSignalInput = {
        id:              signal.id,
        asset:           signal.asset,
        side:            signal.side,
        raw_score:       signal.raw_score,
        horizon_days:    signal.horizon_days,
        enrichment_json: signal.enrichment_json ?? null,
        strategy_id:     signal.strategy_id,
      }

      // Gate 1: daily cap (applies regardless of bypass mode)
      const dailyCount = countTradesToday(db)
      if (dailyCount >= TRADER_DAILY_TRADE_CAP) {
        logger.warn(
          { event: 'trader.cap.daily_hit', signalId: signal.id, dailyCount, cap: TRADER_DAILY_TRADE_CAP },
          'daily cap reached, suppressing',
        )
        db.prepare("UPDATE trader_signals SET status = 'suppressed_daily_cap' WHERE id = ?").run(signal.id)
        continue
      }

      // Gate 2: bypass branch (only while under target)
      const bypass = TRADER_COMMITTEE_BYPASS
      const bypassCount = bypass ? countBypassTrades(db) : 0
      const useBypass = bypass && bypassCount < TRADER_BYPASS_TRADE_TARGET

      const runCommitteeImpl = deps.runCommittee ?? runCommittee
      const runAgentImpl     = deps.runAgent ?? (await import('../agent.js')).runAgent

      let committeeResult: CommitteeResult
      if (useBypass) {
        const tag = `[BYPASS#${bypassCount + 1}/${TRADER_BYPASS_TRADE_TARGET}]`
        logger.warn(
          { event: 'trader.bypass.dispatched', signalId: signal.id, asset: signal.asset, bypassCount: bypassCount + 1, target: TRADER_BYPASS_TRADE_TARGET },
          `TRADER_COMMITTEE_BYPASS active — ${tag} (paper mode)`,
        )
        if (bypassCount + 1 === TRADER_BYPASS_TRADE_TARGET) {
          logger.warn(
            { event: 'trader.bypass.target_reached', count: TRADER_BYPASS_TRADE_TARGET },
            'bypass target reached, next signal will use committee',
          )
        }
        const bypassTs = Date.now()
        committeeResult = {
          decision:      'approve',
          action:        signal.side as 'buy' | 'sell',
          size_usd:      DEFAULT_SIZE_USD,
          confidence:    1.0,
          thesis:        `${tag} Committee skipped via TRADER_COMMITTEE_BYPASS. Paper mode only.`,
          transcript_id: randomUUID(),
          transcript: {
            signal_id:       signal.id,
            started_at:      bypassTs,
            finished_at:     bypassTs,
            rounds_executed: 0,
            round_1:         [],
            risk_officer:    { role: 'risk_officer', veto: false, reason: 'bypassed', concerns: [] },
            trader:          { role: 'trader', action: signal.side as 'buy' | 'sell', thesis: 'bypassed', confidence: 1.0, size_multiplier: 1 },
            errors:          [],
          } satisfies CommitteeTranscript,
        }
        invalidateCounters()
      } else {
        try {
          committeeResult = await runCommitteeImpl(committeeInput, {
            runAgent: runAgentImpl,
            defaultSizeUsd: DEFAULT_SIZE_USD,
            maxSizeUsd: COMMITTEE_MAX_SIZE_USD,
            db,
          })
        } catch (err) {
          db.prepare("UPDATE trader_signals SET status = 'pending' WHERE id = ?")
            .run(signal.id)
          if (err instanceof CommitteeGatedError) {
            // runAgent REFUSED (kill switch / cost cap). The gate is global:
            // every remaining signal would refuse identically, so stop the
            // loop instead of churning through the queue recording bogus
            // abstains (Jun 8-11 2026: 100% of committee output was gate
            // refusals mislabeled as parse failures). Signals stay pending
            // and re-enter on the next tick once the gate clears.
            logger.warn({ signalId: signal.id, reason: err.message }, 'Committee gated -- halting dispatch loop for this tick')
            break
          }
          logger.error({ err, signalId: signal.id }, 'Committee threw during auto-dispatch')
          continue
        }
        storeTranscript(db, committeeResult)
      }

      if (committeeResult.decision === 'abstain') {
        db.prepare("UPDATE trader_signals SET status = 'suppressed_committee_abstain' WHERE id = ?")
          .run(signal.id)
        recordSignalSuppressionBySignalId(db, signal.id, 'committee_abstain', Date.now())

        const result: AutoDispatchResult = {
          signalId: signal.id,
          asset:    signal.asset,
          side:     signal.side as 'buy' | 'sell',
          action:   'suppressed',
          strategy: strategy.name,
          reason:   committeeResult.thesis,
        }
        results.push(result)
        if (deps.alertOnReject) {
          await deps.send(formatRejectionAlert(result))
        }
        continue
      }

      // Committee approved -- submit to engine
      if (!engineClient) {
        const { getEngineClient } = await import('./engine-client.js')
        engineClient = getEngineClient()
      }

      // Per-strategy cap: explicit max_size_usd > NAV*2% fallback, hard ceiling on top.
      const autoStratRow = db.prepare('SELECT max_size_usd FROM trader_strategies WHERE id = ?')
        .get(signal.strategy_id) as { max_size_usd: number | null } | undefined
      const autoNavForSize = await engineClient.getNav().catch(() => null)
      const autoNavUsable = autoNavForSize != null && autoNavForSize > 0
      let autoCapUsd: number
      if (autoStratRow?.max_size_usd != null && autoStratRow.max_size_usd > 0) {
        autoCapUsd = Math.min(autoStratRow.max_size_usd, HARD_CEILING_USD)
      } else {
        autoCapUsd = Math.min(autoNavUsable ? autoNavForSize * RISK_MULTIPLIER : DEFAULT_SIZE_USD, HARD_CEILING_USD)
      }
      const { computeRiskBasedSize } = await import('./risk-sizing.js')
      const autoSizePositions = await engineClient.getPositions().catch(() => [] as EnginePosition[])
      const autoRiskSize = computeRiskBasedSize({
        nav: autoNavForSize,
        positions: autoSizePositions,
        capUsd: autoCapUsd,
        floorUsd: DEFAULT_SIZE_USD,
      })
      // If risk sizing zeroed the trade (portfolio heat ceiling), suppress.
      if (autoRiskSize.sizeUsd <= 0) {
        logger.warn({ event: 'trader.gate.heat_block', signalId: signal.id, reason: autoRiskSize.reason }, 'portfolio heat ceiling reached, suppressing')
        db.prepare("UPDATE trader_signals SET status = 'suppressed_portfolio_heat' WHERE id = ?").run(signal.id)
        recordSignalSuppressionBySignalId(db, signal.id, 'portfolio_heat', Date.now())
        continue
      }
      let sizeUsd      = autoRiskSize.sizeUsd
      const decisionId = randomUUID()
      const now        = Date.now()

      // Resolve an entry reference price from enrichment so the
      // exit-calculator can size stop/target off it. entry_price stays
      // 0 on the wire when unknown (engine resolves via market price),
      // but exits need a concrete number; null entry -> null exits.
      let entryRef = 0
      if (signal.enrichment_json) {
        try {
          const e = JSON.parse(signal.enrichment_json) as { price_current?: number | null }
          if (typeof e.price_current === 'number' && e.price_current > 0) entryRef = e.price_current
        } catch { /* malformed enrichment -> entryRef stays 0 */ }
      }
      const exits = computeExits({
        side: (committeeResult.action ?? signal.side) as 'buy' | 'sell',
        entryPrice: entryRef,
        horizonDays: signal.horizon_days,
        enrichment: signal.enrichment_json ?? null,
      })

      // Correlation-cluster exposure gate (deterministic, pre-submit). Uses the
      // already-fetched positions and NAV from the risk-sizing step above.
      // Product decision: TRIM to headroom rather than block. Suppress only when
      // headroom <= 0 (cluster already at or over cap).
      {
        const { evaluateClusterGate, evaluateSymbolGate } = await import('./correlation-gate.js')
        const clusterGate = evaluateClusterGate({
          asset: signal.asset,
          proposedSizeUsd: sizeUsd,
          positions: autoSizePositions,
          nav: autoNavForSize,
        })
        if (!clusterGate.allowed) {
          if (clusterGate.allowedSizeUsd <= 0) {
            logger.warn(
              { event: 'trader.gate.cluster_block', signalId: signal.id, cluster: clusterGate.cluster, current: clusterGate.currentExposureUsd, cap: clusterGate.capUsd, proposed: sizeUsd },
              'correlation cluster cap reached, suppressing',
            )
            db.prepare("UPDATE trader_signals SET status = 'suppressed_cluster_cap' WHERE id = ?").run(signal.id)
            recordSignalSuppressionBySignalId(db, signal.id, 'cluster_cap', Date.now())
            continue
          }
          // Headroom > 0: trim to allowedSizeUsd and proceed.
          const trimmed = Math.round(clusterGate.allowedSizeUsd * 100) / 100
          logger.info(
            { event: 'trader.gate.cluster_trim', signalId: signal.id, cluster: clusterGate.cluster, original: sizeUsd, trimmed },
            'cluster cap: trimmed order to headroom',
          )
          sizeUsd = trimmed
        }

        // Per-symbol gate, tighter than the cluster gate -- stops one ticker
        // (e.g. a singleton-cluster symbol) from repeatedly absorbing signals
        // until it alone accounts for most of the book's exposure.
        const symbolGate = evaluateSymbolGate({
          asset: signal.asset,
          proposedSizeUsd: sizeUsd,
          positions: autoSizePositions,
          nav: autoNavForSize,
        })
        if (!symbolGate.allowed) {
          if (symbolGate.allowedSizeUsd <= 0) {
            logger.warn(
              { event: 'trader.gate.symbol_block', signalId: signal.id, symbol: symbolGate.cluster, current: symbolGate.currentExposureUsd, cap: symbolGate.capUsd, proposed: sizeUsd },
              'symbol exposure cap reached, suppressing',
            )
            db.prepare("UPDATE trader_signals SET status = 'suppressed_symbol_cap' WHERE id = ?").run(signal.id)
            recordSignalSuppressionBySignalId(db, signal.id, 'symbol_cap', Date.now())
            continue
          }
          const trimmed = Math.round(symbolGate.allowedSizeUsd * 100) / 100
          logger.info(
            { event: 'trader.gate.symbol_trim', signalId: signal.id, symbol: symbolGate.cluster, original: sizeUsd, trimmed },
            'symbol cap: trimmed order to headroom',
          )
          sizeUsd = trimmed
        }
      }

      // Strategy gate (regime filter + fixed-fractional sizing). Shared helper
      // used by both dispatchApproval and autoDispatchPendingSignals. Reuses the
      // already-fetched autoNavForSize -- no second getNav() round-trip.
      {
        const gateResult = await applyStrategyGate(
          db, engineClient, signal.id,
          signal.asset,
          (committeeResult.action ?? signal.side) as 'buy' | 'sell',
          autoNavForSize,
          sizeUsd,
          now,
        )
        if (gateResult.suppressed) {
          results.push({
            signalId: signal.id,
            asset:    signal.asset,
            side:     signal.side as 'buy' | 'sell',
            action:   'suppressed',
            strategy: strategy.name,
            reason:   gateResult.reason,
          })
          continue
        }
        sizeUsd = gateResult.sizeUsd
      }

      // Audit log so the 422 root cause is visible without re-arming a
      // monitor. Records what payload we actually sent to the engine.
      logger.info(
        {
          event:       'trader.auto_dispatch.submit',
          signalId:    signal.id,
          decisionId,
          asset:       signal.asset,
          side:        committeeResult.action ?? signal.side,
          size_usd:    sizeUsd,
          confidence:  committeeResult.confidence,
          strategy:    signal.strategy_id,
        },
        'auto-dispatch submitting decision to engine',
      )

      try {
        // Duplicate guard: if a decision row for this signal already has an
        // engine_order_id, the broker already accepted a previous submission.
        // Skip rather than double-submit.
        //
        // CRITICAL: a THROW here (e.g. schema drift -- missing engine_order_id
        // column) must NOT fall through to a 'pending' reset. A pending reset
        // re-arms the signal and every subsequent tick re-throws -> infinite
        // re-dispatch loop. Distinguish "guard ran, no prior order" (continue)
        // from "guard query errored" (terminal failure + alert).
        let existing: unknown
        try {
          existing = db.prepare(
            "SELECT id FROM trader_decisions WHERE signal_id = ? AND engine_order_id IS NOT NULL LIMIT 1",
          ).get(signal.id)
        } catch (guardErr) {
          logger.error(
            { err: guardErr, signalId: signal.id, decisionId },
            'Duplicate-guard query failed -- marking signal failed (NOT re-queuing) to avoid re-dispatch loop',
          )
          db.prepare("UPDATE trader_signals SET status = 'failed' WHERE id = ?").run(signal.id)
          await deps.send(
            `TRADER ALERT: Signal ${signal.id} (${signal.asset} ${signal.side}) could not be dispatched -- ` +
              `duplicate-guard query failed (likely schema drift). Signal marked failed and will NOT retry. ` +
              `Error: ${guardErr instanceof Error ? guardErr.message : String(guardErr)}`,
          ).catch(() => {/* send errors must not block the continue */})
          continue
        }
        if (existing) {
          logger.warn({ signalId: signal.id, decisionId }, 'Duplicate guard hit -- skipping re-submission')
          db.prepare("UPDATE trader_signals SET status = 'executed' WHERE id = ?").run(signal.id)
          continue
        }

        // INSERT first so the audit row exists before the broker sees the order.
        // Status 'submitting' prevents a crash-between-insert-and-submit from
        // leaving the row in a state that triggers a duplicate next tick.
        db.prepare(`
          INSERT INTO trader_decisions
            (id, signal_id, action, asset, size_usd, entry_type, entry_price, stop_loss, take_profit, thesis, confidence, committee_transcript_id, decided_at, status)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          decisionId, signal.id,
          committeeResult.action ?? signal.side,
          signal.asset, sizeUsd, 'market',
          entryRef,
          exits.stopLoss,
          exits.takeProfit,
          committeeResult.thesis,
          committeeResult.confidence,
          committeeResult.transcript_id,
          now, 'submitting',
        )

        let engineResult: Awaited<ReturnType<EngineClient['submitDecision']>>
        try {
          engineResult = await engineClient.submitDecision({
            decision_id:  decisionId,
            asset:        signal.asset,
            side:         committeeResult.action ?? signal.side,
            size_usd:     sizeUsd,
            entry_type:   'market',
            entry_price:  entryRef,
            ...(exits.stopLoss != null ? { stop_loss: exits.stopLoss } : {}),
            ...(exits.takeProfit != null ? { take_profit: exits.takeProfit } : {}),
            strategy:     signal.strategy_id,
            confidence:   committeeResult.confidence,
          })
        } catch (engineErr) {
          const terminal = isTerminalSubmitError(engineErr)
          const msg = engineErr instanceof Error ? engineErr.message : String(engineErr)
          if (terminal) {
            // 4xx: the engine refused this order (validation). No retry.
            logger.error({ err: engineErr, signalId: signal.id, decisionId }, 'Engine submit rejected (4xx, terminal)')
            db.prepare("UPDATE trader_decisions SET status = ? WHERE id = ?").run(DECISION_STATUS.FAILED, decisionId)
            db.prepare("UPDATE trader_signals SET status = 'failed' WHERE id = ?").run(signal.id)
            await deps.send(
              `TRADER ALERT: Signal ${signal.id} (${signal.asset} ${signal.side}) rejected by engine and will not retry. Error: ${msg}`,
            ).catch(() => {/* send must not block */})
            continue
          }
          // Network / timeout / 5xx: transient. Park at retry_pending with a
          // backoff. Critically, we do NOT resend the same order this tick --
          // a timed-out submit may have reached the broker, so a resend risks
          // a duplicate order. The reconcile phase (Task 3) checks the broker
          // first; the retry sweep (Task 5) re-attempts only after confirming
          // no live order exists.
          const attempts = 1
          const backoffMs = 5 * 60 * 1000 // one tick
          logger.warn({ err: engineErr, signalId: signal.id, decisionId, attempts }, 'Engine submit transient failure, parking retry_pending')
          db.prepare(
            "UPDATE trader_decisions SET status = ?, submit_attempts = ?, next_retry_at = ? WHERE id = ?",
          ).run(DECISION_STATUS.RETRY_PENDING, attempts, Date.now() + backoffMs, decisionId)
          // Keep the signal out of the fresh-dispatch queue: it now owns a
          // decision row. Leave it 'dispatching' so the next tick's pending
          // query skips it; the retry sweep operates on the decision row.
          continue
        }

        // Engine ACK ('placed') proves SUBMISSION, not a fill. Land at
        // 'submitted'; the scheduler reconcile phase promotes to 'executed'
        // once the engine reports filled_qty>0 covering this order.
        db.prepare("UPDATE trader_decisions SET status = 'submitted', engine_order_id = ? WHERE id = ?")
          .run(engineResult.broker_order_id ?? null, decisionId)
        db.prepare("UPDATE trader_signals SET status = 'submitted' WHERE id = ?").run(signal.id)

        const result: AutoDispatchResult = {
          signalId: signal.id,
          asset:    signal.asset,
          side:     signal.side as 'buy' | 'sell',
          action:   'executed',
          strategy: strategy.name,
          sizeUsd,
          reason:   committeeResult.thesis,
        }
        results.push(result)
        await deps.send(formatExecutionAlert(result, signal.raw_score, strategy.tier))
      } catch (err) {
        logger.error({ err, signalId: signal.id, decisionId }, 'Unexpected error in auto-dispatch submission block')
        // Do NOT reset to 'pending' -- that re-arms the signal for the next tick
        // and, when the cause is deterministic (schema drift), loops forever.
        // Terminal-fail and alert, consistent with the engine-submit no-retry policy.
        db.prepare("UPDATE trader_signals SET status = 'failed' WHERE id = ?").run(signal.id)
        await deps.send(
          `TRADER ALERT: Signal ${signal.id} (${signal.asset} ${signal.side}) hit an unexpected dispatch error ` +
            `and was marked failed (no retry). Error: ${err instanceof Error ? err.message : String(err)}`,
        ).catch(() => {})
      }

    } catch (err) {
      logger.error({ err, signalId: signal.id }, 'Unexpected error in autoDispatch loop')
      // Same rationale: never silently re-queue. Terminal-fail so a deterministic
      // fault cannot loop the dispatcher on every tick.
      db.prepare("UPDATE trader_signals SET status = 'failed' WHERE id = ?")
        .run(signal.id)
      // Clean up any decision row that may be stranded in 'submitting' (written
      // before the throw). No-op if no decision row exists for this signal yet.
      db.prepare("UPDATE trader_decisions SET status = 'failed' WHERE signal_id = ? AND status = 'submitting'")
        .run(signal.id)
      await deps.send(
        `TRADER ALERT: Signal ${signal.id} (${signal.asset} ${signal.side}) hit an unexpected loop error ` +
          `and was marked failed (no retry). Error: ${err instanceof Error ? err.message : String(err)}`,
      ).catch(() => {})
    }
  }

  return results
}

function formatExecutionAlert(r: AutoDispatchResult, score: number, tier: number): string {
  const side = r.side.toUpperCase()
  return [
    `EXECUTED: ${side} ${r.asset} $${r.sizeUsd} @ market`,
    `Strategy: ${r.strategy} | Score: ${score.toFixed(2)} | Tier ${tier}`,
    `Committee: approved`,
    r.reason,
  ].join('\n')
}

function formatRejectionAlert(r: AutoDispatchResult): string {
  return [
    `SKIPPED: ${r.side.toUpperCase()} ${r.asset} (committee abstained)`,
    r.reason,
    'Suppressed 24h',
  ].join('\n')
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
