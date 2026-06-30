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
import { recomputeTrackRecord, listOpenPositions, summarizeOpenPositions } from './track-record.js'
import { recomputeRealizedPnlForAsset } from './audit-log.js'
import { insertPnlSnapshot, getLastCumulativePnl } from './db.js'
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
  /** This decision's own confirmed fill (cached by the order reconciler).
   *  Required for a verdict: grading against pooled asset orders multi-counts
   *  an aggregate close across every open decision for the asset. */
  filled_qty: number | null
  filled_avg_price: number | null
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
  reason: 'closed' | 'still-open' | 'no-fills' | 'partial' | 'closed-no-fill-data'
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
 * The order reconciler promotes to status='executed' on confirmed fill
 * (filled_qty>0). status='committee_abstain' rows are also excluded --
 * abstains never opened a position.
 */
export function findOpenDecisions(db: Database.Database): OpenDecisionRow[] {
  // status='executed' now means CONFIRMED FILLED (set only by the order
  // reconciler on filled_qty>0). The submit-ACK no longer lands here.
  return db.prepare(`
    SELECT id, signal_id, asset, action, size_usd, thesis, decided_at, committee_transcript_id,
           filled_qty, filled_avg_price
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
  let buys = rollUpFills(relevant, 'buy')
  let sells = rollUpFills(relevant, 'sell')

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

  // Per-decision lot attribution (2026-06-11): grading a decision against the
  // asset's POOLED orders stamps the full aggregate-close PnL on EVERY open
  // decision for that asset -- 68 verdicts each claiming the whole position's
  // loss in one sweep. A verdict is only honest when this decision's own
  // confirmed fill is known: grade that lot against the pooled close price.
  // Decisions without cached fill data (legacy, pre-fill-tracking) get NO
  // verdict; the caller closes them out via 'closed-no-fill-data'.
  if (decision.filled_qty == null || decision.filled_qty <= 0 || decision.filled_avg_price == null) {
    return {
      decisionId: decision.id,
      fullyClosed: true,
      outcome: null,
      attribution: [],
      reason: 'closed-no-fill-data',
    }
  }
  const lot = {
    qty: decision.filled_qty,
    weightedPrice: decision.filled_avg_price,
    fees: 0,
    firstFillMs: decision.decided_at,
    lastFillMs: decision.decided_at,
  }
  if (side === 'buy') {
    buys = lot
  } else {
    sells = lot
  }

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

  // Populate the derived realized-P&L layer from the immutable fills written
  // by the order-reconciler. Matched PER ASSET, not per decision: an exit is a
  // SEPARATE decision from its entry, so the sell fill lives under a different
  // decision id than the buy. Per-decision matching never sees both legs and
  // yields zero realized rows -- the months-long "P&L always empty" bug. FIFO
  // across the asset closes oldest buy lots first. Errors must not roll back
  // the verdict -- the verdict is the source of truth; P&L recomputes later.
  try {
    recomputeRealizedPnlForAsset(db, decision.asset)
  } catch (err) {
    logger.warn(
      { err, decisionId: decision.id, asset: decision.asset },
      'Close-out sweep: recomputeRealizedPnlForAsset failed; verdict already persisted',
    )
  }

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
  opts: { nowMs?: number } = {},
): Promise<{ processed: number; stillOpen: number; errors: number }> {
  const open = findOpenDecisions(db)
  const nowMs = opts.nowMs ?? Date.now()

  let processed = 0
  let stillOpen = 0
  let errors = 0

  if (open.length > 0) {
    let positions: EnginePosition[]
    let orders: EngineOrder[]
    try {
      [positions, orders] = await Promise.all([
        engineClient.getPositions(),
        engineClient.getOrders(),
      ])
    } catch (err) {
      logger.warn({ err, openDecisions: open.length }, 'Close-out sweep: engine fetch failed')
      // Still write snapshot even when close-out fetch fails.
      await writeDailySnapshot(db, engineClient, nowMs)
      return { processed: 0, stillOpen: 0, errors: 1 }
    }

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
        else if (result.reason === 'closed-no-fill-data') {
          // Position closed but this decision has no cached fill of its own
          // (legacy pre-fill-tracking row). No honest verdict is possible --
          // flip to 'closed' so it leaves the candidate set instead of being
          // re-graded with pooled aggregate PnL every sweep.
          db.prepare(`UPDATE trader_decisions SET status = 'closed' WHERE id = ?`).run(decision.id)
          // Even without a per-decision verdict, the asset's pooled fills may
          // now form a complete round-trip -- recompute realized P&L per asset
          // so a legacy close still books money instead of vanishing.
          try {
            recomputeRealizedPnlForAsset(db, decision.asset)
          } catch (err) {
            logger.warn(
              { err, decisionId: decision.id, asset: decision.asset },
              'Close-out sweep: recomputeRealizedPnlForAsset failed on no-fill-data close',
            )
          }
          logger.info(
            { decisionId: decision.id, asset: decision.asset },
            'Close-out sweep: closed without verdict (no per-decision fill data)',
          )
          processed += 1
        }
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
  }

  // Write a daily PnL snapshot EVERY sweep, not just when something closed.
  // Previously this was gated on processed > 0; since almost nothing closes
  // (engine never confirms fills), the table stayed empty and the equity
  // curve had no data. Now every tick records: realized pnl_day (closed
  // verdicts today), open unrealized MTM (live positions), and account NAV
  // (broker equity) in separate columns. nav_open/nav_close + MTM are
  // best-effort; on engine failure they fall back to 0 and the realized
  // pnl_day + trade count still land.
  await writeDailySnapshot(db, engineClient, nowMs)

  if (errors > 0) {
    logger.warn(
      { errors, processed, stillOpen },
      'Close-out sweep: completed with errors -- decisions stuck on no-fills or partial may accumulate',
    )
  }

  return { processed, stillOpen, errors }
}

/**
 * Write (or overwrite) the daily PnL snapshot row for today (America/New_York
 * calendar date). Called every sweep so the equity curve has data even when
 * nothing closes. Best-effort: nav and open-MTM fall back to 0 on engine
 * failure; the realized pnl_day + trade count always land.
 *
 * `nowMs` is injectable for testing; defaults to Date.now(). This also
 * drives the verdict-sum query so that both the row key (todayNY) and the
 * verdict filter use exactly the same NY calendar day, regardless of the
 * host OS timezone (e.g. UTC on Hostinger / CI).
 */
async function writeDailySnapshot(
  db: Database.Database,
  engineClient: EngineClient,
  nowMs: number,
): Promise<void> {
  try {
    const todayNY = new Date(nowMs).toLocaleDateString('en-CA', { timeZone: 'America/New_York' })

    // Compute the NY calendar day's ms bounds so the verdict-sum query
    // uses the same America/New_York day basis as todayNY -- not the OS
    // 'localtime' modifier, which diverges on UTC hosts (Hostinger, CI).
    //
    // Strategy: binary-search for the UTC ms that renders as todayNY
    // midnight in America/New_York. We know NY is UTC-5 (EST) or UTC-4
    // (EDT). Try both offsets; the one whose NY date string matches
    // todayNY is correct. DST transitions never fall at midnight so one
    // of the two will always match.
    const nyMidnightMs = (() => {
      for (const offsetH of [4, 5]) {
        const candidateMs = Date.parse(todayNY + 'T00:00:00Z') + offsetH * 3_600_000
        if (new Date(candidateMs).toLocaleDateString('en-CA', { timeZone: 'America/New_York' }) === todayNY) {
          return candidateMs
        }
      }
      // Should never happen; fall back to UTC midnight of the date string.
      return Date.parse(todayNY + 'T00:00:00Z')
    })()
    const dayStartMs = nyMidnightMs
    const dayEndMs = dayStartMs + 86_400_000

    // Sum pnl_net for verdicts closed today -- pull from DB so we
    // capture verdicts written in prior ticks on the same calendar day,
    // not just the ones written this pass. Use ms bounds (not OS
    // 'localtime') so the filter agrees with todayNY on any host TZ.
    const pnlRow = db.prepare(`
      SELECT COALESCE(SUM(pnl_net), 0) AS total_pnl, COUNT(*) AS cnt
      FROM trader_verdicts
      WHERE closed_at >= ? AND closed_at < ?
    `).get(dayStartMs, dayEndMs) as { total_pnl: number; cnt: number }

    let navOpen = 0
    let navClose = 0
    let accountNav = 0
    let openUnrealizedPnl = 0
    try {
      const [openSnap, closeSnap] = await Promise.all([
        engineClient.getNavLatest('day_open'),
        engineClient.getNavLatest('day_close'),
      ])
      navOpen = openSnap?.nav ?? 0
      navClose = closeSnap?.nav ?? 0
      // account_nav = the freshest broker equity we have. Prefer day_close
      // (set at 4pm), else day_open. This is account equity, distinct from
      // realized pnl_day.
      accountNav = navClose || navOpen
    } catch {
      // engine unreachable -- fall through to the carry-forward below
    }
    if (accountNav === 0) {
      // Engine unreachable (or returned nothing). NEVER write a zero-NAV row:
      // the Jun 9 2026 outage day recorded nav 0 and collapsed the equity
      // curve + cumulative PnL chain. Carry the last known equity forward;
      // a flat day is honest, a $0 account is not.
      const lastKnown = db.prepare(`
        SELECT nav_open, nav_close, account_nav FROM trader_pnl_snapshots
        WHERE account_nav > 0 AND date < ?
        ORDER BY date DESC LIMIT 1
      `).get(todayNY) as { nav_open: number; nav_close: number; account_nav: number } | undefined
      if (lastKnown) {
        accountNav = lastKnown.account_nav
        if (navOpen === 0) navOpen = lastKnown.account_nav
        if (navClose === 0) navClose = lastKnown.account_nav
        logger.warn(
          { date: todayNY, carriedNav: accountNav },
          'Close-out sweep: engine NAV unavailable, carried last known equity forward',
        )
      }
    }
    try {
      const openDecisions = listOpenPositions(db)
      // Second getPositions call per tick (the first is in the close-out
      // loop above). Intentional: the close-out loop may have written new
      // verdicts that shrink the open set, so we need a fresh snapshot
      // here to compute open MTM on the post-closure position state.
      const positions = await engineClient.getPositions()
      openUnrealizedPnl = summarizeOpenPositions(openDecisions, positions).totalUnrealizedPnlUsd
    } catch {
      // engine unreachable -- leave open MTM at 0
    }

    const prior = getLastCumulativePnl(db)
    // Avoid double-counting: subtract any prior cumulative that already
    // includes today's row (INSERT OR REPLACE will overwrite it).
    const priorRow = db.prepare(
      `SELECT cumulative_pnl FROM trader_pnl_snapshots WHERE date = ?`,
    ).get(todayNY) as { cumulative_pnl: number } | undefined
    const priorToday = priorRow?.cumulative_pnl ?? 0
    const priorBase = prior - priorToday

    insertPnlSnapshot(db, {
      date: todayNY,
      navOpen,
      navClose,
      pnlDay: pnlRow.total_pnl,
      tradesCount: pnlRow.cnt,
      benchReturn: 0,   // backfilled later when /prices available
      cumulativePnl: priorBase + pnlRow.total_pnl,
      openUnrealizedPnl,
      accountNav,
    })

    logger.info(
      { date: todayNY, pnlDay: pnlRow.total_pnl, tradesCount: pnlRow.cnt, openUnrealizedPnl, accountNav },
      'Close-out sweep: daily PnL snapshot written',
    )
  } catch (err) {
    logger.warn({ err }, 'Close-out sweep: PnL snapshot write failed')
  }
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
