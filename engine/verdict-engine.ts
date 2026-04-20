/**
 * Phase 3 Task 1 -- Verdict engine (pure functions only).
 *
 * Given the engine's order/position state for a closed decision, this
 * module computes the structured verdict that the close-out watcher
 * persists into trader_verdicts and the ReasoningBank.
 *
 * Two scope decisions documented for Phase 3 v1:
 *
 *  1. bench_return and hold_drawdown ship as 0 placeholders. Computing
 *     them requires historical price data the engine does not yet
 *     expose. Phase 3 Task 3 (XGBoost regime classifier) needs the
 *     same data, so we add the engine endpoint there and backfill the
 *     placeholders in the same engine pull. Until then, gradeThesis
 *     reduces to a pnl-only heuristic which is still a useful signal.
 *
 *  2. agent_attribution is recorded as deterministic data extracted
 *     from the committee transcript -- specialist confidences and
 *     concern counts plus the trader's action and right/wrong tag.
 *     No LLM call. This preserves the "tokens only in committee" rule
 *     and keeps the close-out path fast and cheap.
 */
import type { EngineOrder, PricePoint } from './types.js'
import type { CommitteeTranscript } from './committee.js'

const CRYPTO_BENCH = 'BTC/USD'
const STOCK_BENCH = 'SPY'

export type ThesisGrade = 'A' | 'B' | 'C' | 'D'

export interface FillRollup {
  qty: number
  weightedPrice: number
  fees: number
  firstFillMs: number | null
  lastFillMs: number | null
}

export interface VerdictInput {
  decisionId: string
  /** Direction the original decision intended -- 'buy' opens long, 'sell' opens short. */
  side: 'buy' | 'sell'
  buys: FillRollup
  sells: FillRollup
}

export interface VerdictOutcome {
  pnlGross: number
  pnlNet: number
  pnlPct: number
  benchReturn: number
  holdDrawdown: number
  thesisGrade: ThesisGrade
  closedAtMs: number
  fullyClosed: boolean
}

export interface AgentAttribution {
  role: string
  data: Record<string, unknown>
}

/**
 * Roll up a list of engine orders into a single side's totals. Skips
 * zero-quantity and unfilled orders. Returns the volume-weighted
 * average price for the matching side.
 */
export function rollUpFills(
  orders: EngineOrder[],
  side: 'buy' | 'sell',
): FillRollup {
  let qty = 0
  let weightedSum = 0
  let firstFillMs: number | null = null
  let lastFillMs: number | null = null
  for (const order of orders) {
    if (order.side !== side) continue
    if (order.filled_qty <= 0) continue
    if (order.filled_avg_price == null) continue
    qty += order.filled_qty
    weightedSum += order.filled_qty * order.filled_avg_price
    if (firstFillMs == null || order.updated_at < firstFillMs) firstFillMs = order.updated_at
    if (lastFillMs == null || order.updated_at > lastFillMs) lastFillMs = order.updated_at
  }
  return {
    qty,
    weightedPrice: qty > 0 ? weightedSum / qty : 0,
    fees: 0,
    firstFillMs,
    lastFillMs,
  }
}

/**
 * Compute a verdict from rolled-up fills.
 *
 * fullyClosed is true when sells.qty >= buys.qty (within float
 * tolerance) for a long, or buys.qty >= sells.qty for a short. Partial
 * closes return pnl_gross=0 and fullyClosed=false; the caller should
 * skip persisting and try again on the next sweep.
 */
export function computeVerdict(input: VerdictInput): VerdictOutcome {
  const { side, buys, sells } = input
  const tol = 1e-9
  const fullyClosed = side === 'buy'
    ? buys.qty > 0 && sells.qty + tol >= buys.qty
    : sells.qty > 0 && buys.qty + tol >= sells.qty

  const pnlGrossRaw = side === 'buy'
    ? (sells.weightedPrice - buys.weightedPrice) * buys.qty
    : (buys.weightedPrice - sells.weightedPrice) * sells.qty
  const pnlGross = fullyClosed ? pnlGrossRaw : 0
  const pnlNet = pnlGross - (buys.fees + sells.fees)

  const cost = side === 'buy'
    ? buys.weightedPrice * buys.qty
    : sells.weightedPrice * sells.qty
  const pnlPct = cost > 0 ? pnlGross / cost : 0

  const benchReturn = 0
  const holdDrawdown = 0
  const thesisGrade = gradeThesis(pnlPct, benchReturn)

  const closedAtMs = sells.lastFillMs ?? buys.lastFillMs ?? Date.now()

  return {
    pnlGross,
    pnlNet,
    pnlPct,
    benchReturn,
    holdDrawdown,
    thesisGrade,
    closedAtMs,
    fullyClosed,
  }
}

/**
 * Heuristic thesis grader.
 *
 *  A: pnl > 2% AND beat bench (strong + alpha)
 *  B: pnl > 0 AND beat bench (positive + alpha)
 *  C: pnl > 0 OR beat bench (one of two)
 *  D: pnl <= 0 AND did not beat bench
 *
 * With benchReturn=0 (Phase 3 v1 placeholder) the thresholds reduce to:
 *  A: pnl > 2%
 *  B: pnl > 0 (and 0 > 0 is false so this becomes redundant with A path test)
 *  C: pnl > 0
 *  D: pnl <= 0
 */
export function gradeThesis(pnlPct: number, benchReturn: number): ThesisGrade {
  const beatBench = pnlPct > benchReturn
  const positive = pnlPct > 0
  const strong = pnlPct > 0.02
  if (strong && beatBench) return 'A'
  if (positive && beatBench) return 'B'
  if (positive || beatBench) return 'C'
  return 'D'
}

/**
 * Extract deterministic per-agent data from the committee transcript.
 *
 * No LLM call -- just records confidences, concern counts, and the
 * realized right/wrong tag for the risk officer + trader. This gives
 * the dashboard enough signal to surface a "trader was right N times,
 * risk officer over-vetoed N times" report card later (Phase 4).
 */
export function attributeAgents(
  transcript: CommitteeTranscript,
  pnlGross: number,
): AgentAttribution[] {
  const positiveOutcome = pnlGross > 0
  const out: AgentAttribution[] = []
  for (const opinion of transcript.round_1) {
    out.push({
      role: opinion.role,
      data: {
        confidence: opinion.confidence,
        concerns_count: opinion.concerns?.length ?? 0,
      },
    })
  }
  out.push({
    role: 'risk_officer',
    data: {
      vetoed: transcript.risk_officer.veto,
      // Closed verdicts only exist when risk did NOT veto; "right" here
      // tracks whether allowing the trade was the correct call.
      right: positiveOutcome,
    },
  })
  out.push({
    role: 'trader',
    data: {
      action: transcript.trader.action,
      confidence: transcript.trader.confidence,
      size_multiplier: transcript.trader.size_multiplier,
      right: positiveOutcome,
    },
  })
  return out
}

/**
 * Pick the benchmark symbol for an asset. BTC for crypto, SPY for
 * equities. Crypto is detected via Alpaca-style `BASE/QUOTE` tickers
 * (e.g. `BTC/USD`, `ETH/USD`), `BASE-USD` suffixes, or a direct match
 * against the known crypto symbols list. Otherwise we fall back to the
 * equity benchmark. The caller may also pass `assetClass` explicitly
 * when they have a `trader_strategies.asset_class` row handy.
 *
 * The symbol strings returned here are what we pass to the engine's
 * `/prices` endpoint, so keep them aligned with what the engine
 * accepts (`SPY`, `BTC/USD`).
 */
export function pickBenchSymbol(
  asset: string,
  assetClass?: string | null,
): string {
  if (assetClass) {
    if (assetClass.toLowerCase() === 'crypto') return CRYPTO_BENCH
    if (assetClass.toLowerCase() === 'stocks') return STOCK_BENCH
  }
  const upper = asset.toUpperCase()
  if (upper.includes('/') || upper.endsWith('-USD')) return CRYPTO_BENCH
  const cryptoSymbols = ['BTC', 'ETH', 'SOL', 'ADA', 'DOGE', 'XRP', 'MATIC', 'AVAX', 'DOT', 'LINK']
  if (cryptoSymbols.includes(upper)) return CRYPTO_BENCH
  return STOCK_BENCH
}

/**
 * Compute the benchmark return over the hold window.
 *
 * bench_return = (last_close_near_close - first_close_near_decide) / first_close_near_decide
 *
 * Both endpoints are the first daily close at or after the timestamp
 * within a one-day window (so business-day gaps and weekends fall
 * through). Returns 0 when we do not have enough data to compute a
 * meaningful number -- the caller can treat 0 as "unknown" and leave
 * `returns_backfilled=0` if it prefers to retry later. This function
 * itself makes no decision about the flag.
 */
export function computeBenchReturn(benchPrices: PricePoint[]): number {
  if (benchPrices.length < 2) return 0
  const entry = benchPrices[0].close
  const exit = benchPrices[benchPrices.length - 1].close
  if (entry <= 0) return 0
  return (exit - entry) / entry
}

/**
 * Compute hold drawdown (closes-only approximation) for the asset.
 *
 * hold_drawdown = min(close - entry_close) / entry_close, clamped to
 * <= 0 so a monotonically-up trade registers 0 drawdown. `/prices`
 * only gives daily closes so this is an approximation -- real
 * intraday drawdown can be deeper. Good enough for grading and
 * reporting; the engine-side position sizer is the source of truth
 * for live risk limits.
 *
 * Returns 0 when the series is empty, single-point, or entry_close is
 * non-positive.
 */
export function computeHoldDrawdown(assetPrices: PricePoint[]): number {
  if (assetPrices.length < 2) return 0
  const entryClose = assetPrices[0].close
  if (entryClose <= 0) return 0
  let minClose = entryClose
  for (const p of assetPrices) {
    if (p.close < minClose) minClose = p.close
  }
  const dd = (minClose - entryClose) / entryClose
  return dd < 0 ? dd : 0
}

/**
 * Given a verdict's decided_at + closed_at, compute the
 * `/prices` query windows the close-out-watcher and backfill script
 * should use. Returned bounds are inclusive on both sides.
 *
 * - Benchmark entry window: [decidedAt, decidedAt + 1 day]
 * - Benchmark exit window:  [closedAt - 1 day, closedAt]
 *   (concatenated into a single [decidedAt, closedAt] range so we pull
 *   one bench series and let computeBenchReturn take first+last)
 * - Asset series: [decidedAt, closedAt] -- every close during hold
 */
export function priceWindows(decidedAtMs: number, closedAtMs: number): {
  benchFromMs: number
  benchToMs: number
  assetFromMs: number
  assetToMs: number
} {
  return {
    benchFromMs: decidedAtMs,
    benchToMs: closedAtMs,
    assetFromMs: decidedAtMs,
    assetToMs: closedAtMs,
  }
}

/**
 * Distill a verdict into a single-paragraph summary suitable for
 * ReasoningBank retrieval. Template-based, no LLM. The downstream
 * coordinator quotes this back into its synthesis prompt.
 */
export function summarizeForReasoningBank(args: {
  asset: string
  side: 'buy' | 'sell'
  strategy: string
  thesis: string
  outcome: VerdictOutcome
}): string {
  const { asset, side, strategy, thesis, outcome } = args
  const pnlPctStr = (outcome.pnlPct * 100).toFixed(2)
  const winLoss = outcome.pnlGross > 0
    ? 'win'
    : outcome.pnlGross < 0 ? 'loss' : 'breakeven'
  const cleanedThesis = thesis.trim().replace(/\s+/g, ' ')
  return `${asset} ${side} via ${strategy}: ${winLoss} (${pnlPctStr}% net). ` +
    `Thesis graded ${outcome.thesisGrade}. Original thesis: ${cleanedThesis}`
}
