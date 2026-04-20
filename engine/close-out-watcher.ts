/**
 * Phase 3 Task 1 -- Close-out watcher.
 *
 * Detects when an executed trader_decision has fully closed on the
 * engine side and writes a verdict + ReasoningBank case for it. Runs
 * as a phase of the trader scheduler tick.
 *
 * Hot-path rules preserved:
 *  - No LLM calls. All grading is deterministic.
 *  - Each step wrapped in try/catch so one bad decision does not stop
 *    sweep progress.
 *  - DB writes happen one verdict at a time, so a crash mid-sweep
 *    leaves a clean partial state and the next tick picks up from
 *    where we left off.
 */
import { randomUUID } from 'crypto'
import type Database from 'better-sqlite3'
import type { EngineClient } from './engine-client.js'
import type { EnginePosition, EngineOrder, PricePoint } from './types.js'
import { logger } from '../logger.js'
import { insertCase } from './reasoning-bank.js'
import { recomputeTrackRecord } from './track-record.js'
import {
  computeVerdict,
  rollUpFills,
  attributeAgents,
  summarizeForReasoningBank,
  pickBenchSymbol,
  computeBenchReturn,
  computeHoldDrawdown,
  priceWindows,
  gradeThesis,
  type VerdictOutcome,
  type AgentAttribution,
} from './verdict-engine.js'
import type { CommitteeTranscript } from './committee.js'

interface StrategyRow {
  asset_class: string
}

export interface OpenDecisionRow {
  id: string
  signal_id: string
  asset: string
  action: string
  size_usd: number
  thesis: string
  decided_at: number
  committee_transcript_id: string | null
}

interface SignalRow {
  id: string
  strategy_id: string
  side: string
}

interface TranscriptRow {
  transcript_json: string
}

export interface ClosureResult {
  decisionId: string
  fullyClosed: boolean
  outcome: VerdictOutcome | null
  attribution: AgentAttribution[]
  reason: 'closed' | 'still-open' | 'no-fills' | 'partial'
}

/**
 * Outcome of a /prices fetch for one decision's hold window. Separated
 * from the numeric fields so `success=false` unambiguously means
 * "leave returns_backfilled=0 and let the migration script retry" --
 * even if benchReturn and holdDrawdown happen to be 0.
 */
export interface PriceFetchResult {
  success: boolean
  benchReturn: number
  holdDrawdown: number
}

/**
 * Decisions that opened a position and have no verdict yet.
 *
 * The dispatcher writes status='executed' on a successful submit and
 * status='committee_abstain' on an abstain. We only care about the
 * former -- abstains never opened a position.
 */
export function findOpenDecisions(db: Database.Database): OpenDecisionRow[] {
  return db.prepare(`
    SELECT id, signal_id, asset, action, size_usd, thesis, decided_at, committee_transcript_id
    FROM trader_decisions
    WHERE status = 'executed'
      AND id NOT IN (SELECT decision_id FROM trader_verdicts)
  `).all() as OpenDecisionRow[]
}

/** True if the asset has no open position in the engine snapshot. */
function isAssetClosed(asset: string, positions: EnginePosition[]): boolean {
  const pos = positions.find(p => p.asset === asset)
  if (!pos) return true
  return Math.abs(pos.qty) < 1e-9
}

/** Filter engine orders to those affecting one asset on or after a timestamp. */
function relevantOrders(
  asset: string,
  decidedAtMs: number,
  orders: EngineOrder[],
): EngineOrder[] {
  return orders.filter(o => o.asset === asset && o.created_at >= decidedAtMs)
}

/**
 * Process a single decision against the engine snapshot. Writes a
 * verdict row and ReasoningBank entry if the position is fully closed.
 *
 * Decisions are reported as:
 *  - 'still-open': asset still in engine positions, skip until next tick
 *  - 'no-fills':   asset closed but no engine orders match the decision
 *                  window (anomalous; log + skip)
 *  - 'partial':    closed but exit fills do not cover the entry qty
 *                  (rare; usually means a manual close. Skip + log.)
 *  - 'closed':     full verdict written
 *
 * Phase 4 Task B: when `engineClient` is supplied, the closed-path
 * additionally fetches `/prices` for the asset and benchmark over the
 * hold window and populates `bench_return` + `hold_drawdown`. When the
 * fetch fails or returns no bars, the verdict still writes with
 * zero placeholders and `returns_backfilled=0` so the backfill script
 * can retry later. When the fetch succeeds, `returns_backfilled=1`.
 */
export function processClosure(
  db: Database.Database,
  decision: OpenDecisionRow,
  positions: EnginePosition[],
  orders: EngineOrder[],
  priceFetchResult?: PriceFetchResult,
): ClosureResult {
  if (!isAssetClosed(decision.asset, positions)) {
    return {
      decisionId: decision.id,
      fullyClosed: false,
      outcome: null,
      attribution: [],
      reason: 'still-open',
    }
  }

  const relevant = relevantOrders(decision.asset, decision.decided_at, orders)
  const buys = rollUpFills(relevant, 'buy')
  const sells = rollUpFills(relevant, 'sell')

  if (buys.qty <= 0 && sells.qty <= 0) {
    logger.warn(
      { decisionId: decision.id, asset: decision.asset, decidedAt: decision.decided_at },
      'Close-out sweep: asset closed but no matching fills',
    )
    return {
      decisionId: decision.id,
      fullyClosed: false,
      outcome: null,
      attribution: [],
      reason: 'no-fills',
    }
  }

  const side: 'buy' | 'sell' = decision.action === 'sell' ? 'sell' : 'buy'
  const outcome = computeVerdict({
    decisionId: decision.id,
    side,
    buys,
    sells,
  })

  if (!outcome.fullyClosed) {
    logger.info(
      { decisionId: decision.id, buyQty: buys.qty, sellQty: sells.qty },
      'Close-out sweep: position partially closed, deferring verdict',
    )
    return {
      decisionId: decision.id,
      fullyClosed: false,
      outcome,
      attribution: [],
      reason: 'partial',
    }
  }

  let transcript: CommitteeTranscript | null = null
  if (decision.committee_transcript_id) {
    try {
      const row = db.prepare(
        `SELECT transcript_json FROM trader_committee_transcripts WHERE id = ?`,
      ).get(decision.committee_transcript_id) as TranscriptRow | undefined
      if (row?.transcript_json) {
        transcript = JSON.parse(row.transcript_json) as CommitteeTranscript
      }
    } catch (err) {
      logger.warn(
        { err, decisionId: decision.id, transcriptId: decision.committee_transcript_id },
        'Close-out sweep: failed to load committee transcript',
      )
    }
  }

  const attribution = transcript ? attributeAgents(transcript, outcome.pnlGross) : []

  // Phase 4 Task B: promote placeholder bench_return + hold_drawdown
  // to real numbers when we have /prices data on hand. The caller
  // pre-fetched prices in runCloseOutSweep so processClosure stays
  // synchronous; null/undefined means "skipped" (no engine client in
  // tests or fetch failed upstream).
  //
  // When bench_return is promoted from 0, the thesis_grade computed
  // inside computeVerdict (which used the 0 placeholder) is stale.
  // Regrade with the real benchmark so the stored grade is internally
  // consistent with the stored bench_return. Downstream consumers
  // (ReasoningBank summary, dashboard report card) read the grade
  // directly and assume it matches bench_return.
  let benchReturn = outcome.benchReturn
  let holdDrawdown = outcome.holdDrawdown
  let thesisGrade = outcome.thesisGrade
  let returnsBackfilled = 0
  if (priceFetchResult && priceFetchResult.success) {
    benchReturn = priceFetchResult.benchReturn
    holdDrawdown = priceFetchResult.holdDrawdown
    thesisGrade = gradeThesis(outcome.pnlPct, benchReturn)
    returnsBackfilled = 1
  }

  // Build the canonical outcome so downstream consumers (ReasoningBank
  // summarizer, insertCase thesis_grade, ClosureResult.outcome returned
  // to the caller) all read the same numbers that were written to the
  // verdict row.
  const canonicalOutcome: VerdictOutcome = {
    ...outcome,
    benchReturn,
    holdDrawdown,
    thesisGrade,
  }

  const verdictId = randomUUID()
  db.prepare(`
    INSERT INTO trader_verdicts
      (id, decision_id, pnl_gross, pnl_net, bench_return, hold_drawdown,
       thesis_grade, agent_attribution_json, embedding_id, closed_at,
       returns_backfilled)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    verdictId,
    decision.id,
    canonicalOutcome.pnlGross,
    canonicalOutcome.pnlNet,
    canonicalOutcome.benchReturn,
    canonicalOutcome.holdDrawdown,
    canonicalOutcome.thesisGrade,
    JSON.stringify(attribution),
    null,
    canonicalOutcome.closedAtMs,
    returnsBackfilled,
  )

  db.prepare(`UPDATE trader_decisions SET status = 'closed' WHERE id = ?`).run(decision.id)

  // ReasoningBank insert + track-record recompute. Both must NOT roll
  // back the verdict on failure -- the verdict is the source of truth
  // and the downstream consumers (Phase 2 retrieval, dashboard rollup)
  // tolerate stale/missing rows.
  let strategyId: string | null = null
  try {
    const signal = db.prepare(
      `SELECT id, strategy_id, side FROM trader_signals WHERE id = ?`,
    ).get(decision.signal_id) as SignalRow | undefined
    if (!signal) {
      logger.warn(
        { decisionId: decision.id, signalId: decision.signal_id },
        'Close-out sweep: verdict written but signal missing for ReasoningBank insert',
      )
    } else {
      strategyId = signal.strategy_id
      const summary = summarizeForReasoningBank({
        asset: decision.asset,
        side,
        strategy: signal.strategy_id,
        thesis: decision.thesis,
        outcome: canonicalOutcome,
      })
      const winLoss = canonicalOutcome.pnlGross > 0
        ? 'win'
        : canonicalOutcome.pnlGross < 0 ? 'loss' : 'breakeven'
      insertCase(db, {
        id: randomUUID(),
        decision_id: decision.id,
        signal_id: signal.id,
        asset: decision.asset,
        side,
        strategy: signal.strategy_id,
        summary,
        thesis_grade: canonicalOutcome.thesisGrade,
        outcome: winLoss,
        pnl_net: canonicalOutcome.pnlNet,
        embedding_id: null,
        created_at: canonicalOutcome.closedAtMs,
      })
    }
  } catch (err) {
    logger.warn(
      { err, decisionId: decision.id },
      'Close-out sweep: ReasoningBank insert failed; verdict already persisted',
    )
  }

  // Phase 3 Task 2 -- recompute the strategy's track record so the
  // dashboard + autonomy ladder (Task 5) read fresh aggregates. The
  // recompute helper swallows its own errors; we just skip when the
  // signal lookup above didn't find a strategy_id.
  if (strategyId) {
    recomputeTrackRecord(db, strategyId)
  }

  return {
    decisionId: decision.id,
    fullyClosed: true,
    outcome: canonicalOutcome,
    attribution,
    reason: 'closed',
  }
}

/**
 * Fetch daily closes for the asset + its benchmark over the hold
 * window and compute bench_return + hold_drawdown. Any failure path
 * (engine unreachable, empty series, unknown error) returns
 * `success=false` with zero numbers -- the caller writes zeros and
 * leaves `returns_backfilled=0` for the migration script to pick up.
 *
 * Exported so the Phase 4 Task B backfill script can use the same
 * logic off the same engine client.
 */
export async function fetchReturnsForDecision(
  engineClient: EngineClient,
  args: {
    asset: string
    assetClass?: string | null
    decidedAtMs: number
    closedAtMs: number
  },
): Promise<PriceFetchResult> {
  const { asset, assetClass, decidedAtMs, closedAtMs } = args
  if (closedAtMs <= decidedAtMs) {
    return { success: false, benchReturn: 0, holdDrawdown: 0 }
  }

  const win = priceWindows(decidedAtMs, closedAtMs)
  const benchSymbol = pickBenchSymbol(asset, assetClass)
  let assetPrices: PricePoint[] = []
  let benchPrices: PricePoint[] = []
  try {
    [assetPrices, benchPrices] = await Promise.all([
      engineClient.getPrices(asset, win.assetFromMs, win.assetToMs),
      engineClient.getPrices(benchSymbol, win.benchFromMs, win.benchToMs),
    ])
  } catch (err) {
    logger.warn(
      { err, asset, benchSymbol, decidedAtMs, closedAtMs },
      'Close-out sweep: /prices fetch failed; will retry via backfill',
    )
    return { success: false, benchReturn: 0, holdDrawdown: 0 }
  }
  if (assetPrices.length < 2 || benchPrices.length < 2) {
    logger.info(
      { asset, benchSymbol, assetBars: assetPrices.length, benchBars: benchPrices.length },
      'Close-out sweep: /prices returned insufficient bars; keeping placeholders',
    )
    return { success: false, benchReturn: 0, holdDrawdown: 0 }
  }

  const benchReturn = computeBenchReturn(benchPrices)
  const holdDrawdown = computeHoldDrawdown(assetPrices)
  return { success: true, benchReturn, holdDrawdown }
}

/**
 * Walk all open decisions, process any that are closed on the engine
 * side. One positions+orders round-trip per sweep; prices are fetched
 * per-decision only when a decision is actually closing in this pass
 * (typically 0 or 1 decisions per tick).
 */
export async function runCloseOutSweep(
  db: Database.Database,
  engineClient: EngineClient,
): Promise<{ processed: number; stillOpen: number; errors: number }> {
  const open = findOpenDecisions(db)
  if (open.length === 0) {
    return { processed: 0, stillOpen: 0, errors: 0 }
  }

  let positions: EnginePosition[]
  let orders: EngineOrder[]
  try {
    [positions, orders] = await Promise.all([
      engineClient.getPositions(),
      engineClient.getOrders(),
    ])
  } catch (err) {
    logger.warn({ err, openDecisions: open.length }, 'Close-out sweep: engine fetch failed')
    return { processed: 0, stillOpen: 0, errors: 1 }
  }

  let processed = 0
  let stillOpen = 0
  let errors = 0
  for (const decision of open) {
    try {
      // Only closed decisions actually need a /prices round-trip.
      // Prescreen with the same logic processClosure uses so we skip
      // the network call for still-open / no-fills / partial decisions.
      let priceFetchResult: PriceFetchResult | undefined
      if (isAssetClosed(decision.asset, positions)) {
        const relevant = relevantOrders(decision.asset, decision.decided_at, orders)
        const buys = rollUpFills(relevant, 'buy')
        const sells = rollUpFills(relevant, 'sell')
        const side: 'buy' | 'sell' = decision.action === 'sell' ? 'sell' : 'buy'
        const probableClose = side === 'buy'
          ? buys.qty > 0 && sells.qty + 1e-9 >= buys.qty
          : sells.qty > 0 && buys.qty + 1e-9 >= sells.qty
        if (probableClose) {
          const closedAtMs = sells.lastFillMs ?? buys.lastFillMs ?? Date.now()
          const assetClass = lookupAssetClass(db, decision.signal_id)
          priceFetchResult = await fetchReturnsForDecision(engineClient, {
            asset: decision.asset,
            assetClass,
            decidedAtMs: decision.decided_at,
            closedAtMs,
          })
        }
      }

      const result = processClosure(db, decision, positions, orders, priceFetchResult)
      if (result.reason === 'closed') processed += 1
      else if (result.reason === 'still-open') stillOpen += 1
      else errors += 1
    } catch (err) {
      logger.error(
        { err, decisionId: decision.id },
        'Close-out sweep: processClosure threw',
      )
      errors += 1
    }
  }
  return { processed, stillOpen, errors }
}

/**
 * Resolve the strategy's asset_class via the signal->strategy join.
 * Returns null when any join step fails so the caller can fall back
 * to symbol-based detection in pickBenchSymbol.
 */
function lookupAssetClass(db: Database.Database, signalId: string): string | null {
  try {
    const row = db.prepare(`
      SELECT s.asset_class AS asset_class
      FROM trader_signals sig
      JOIN trader_strategies s ON s.id = sig.strategy_id
      WHERE sig.id = ?
    `).get(signalId) as StrategyRow | undefined
    return row?.asset_class ?? null
  } catch {
    return null
  }
}
