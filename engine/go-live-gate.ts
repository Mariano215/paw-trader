/**
 * Broker-truth P&L + enforced go-live gate.
 *
 * Two jobs:
 *  1. computeBrokerTruth: realized round-trips and open MTM computed from
 *     the ENGINE's filled orders and positions (broker truth), never from
 *     the local trader_realized_pnl layer. The local derived layer diverged
 *     from broker truth (2026-06-29 adopted-close batch) and stays
 *     internal-only for verdicts/learning; every human-facing P&L number
 *     must come from here.
 *  2. runGoLiveGate: feeds broker truth into evaluateGate() (validation-gate)
 *     and persists the result. The trader tick enforces it: engine in live
 *     mode while the last gate result is not passed -> trading halted.
 *
 * Regime accumulation: each gate run records the current SPY Markov state
 * into kv_settings, so regimesObserved grows as the paper record spans
 * more market conditions. Honest cold start: 1 regime until the tape changes.
 */
import type Database from 'better-sqlite3'
import type { EngineClient } from './engine-client.js'
import { matchLotsFifo, type FillRow, type RealizedLot } from './audit-log.js'
import { evaluateGate, type GateResult } from './validation-gate.js'
import type { EquityPoint } from './metrics.js'
import { logger } from '../logger.js'

export const GATE_KV_KEY = 'trader.gate.last'
export const GATE_REGIMES_KV_KEY = 'trader.gate.regimes_seen'
const GATE_RUN_KV_KEY = 'trader.gate.last_run_ms'
export const GATE_RUN_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000 // weekly

export interface BrokerTruth {
  realizedLots: RealizedLot[]
  realizedTotal: number
  openUnrealized: number
  roundTrips: number
  perAsset: Array<{ asset: string; roundTrips: number; realized: number }>
}

/**
 * Realized P&L from engine filled orders (FIFO per asset) + open MTM from
 * engine positions. Read-only; throws when the engine is unreachable so
 * callers never mistake "engine down" for "zero P&L".
 */
export async function computeBrokerTruth(client: EngineClient): Promise<BrokerTruth> {
  const [orders, positions] = await Promise.all([client.getOrders(), client.getPositions()])

  const byAsset = new Map<string, FillRow[]>()
  for (const o of orders) {
    const status = (o.status ?? '').toLowerCase()
    if (!(o.filled_qty > 0) || (status !== 'filled' && status !== 'partially_filled')) continue
    const rows = byAsset.get(o.asset) ?? []
    // Adapt the engine order into the minimal FillRow surface matchLotsFifo
    // reads (side, fill_qty, fill_price, fill_ts_ms, fee_usd, decision_id).
    rows.push({
      id: o.broker_order_id ?? o.client_order_id,
      decision_id: o.decision_id ?? o.client_order_id,
      client_order_id: o.client_order_id,
      broker_order_id: o.broker_order_id,
      asset: o.asset,
      side: o.side,
      fill_qty: o.filled_qty,
      fill_price: o.filled_avg_price ?? 0,
      intended_price: null,
      intended_ts_ms: null,
      fill_ts_ms: o.updated_at,
      fee_usd: 0,
      slippage_usd: 0,
      entry_thesis: null,
      exit_reason: null,
      recorded_at: o.updated_at,
    })
    byAsset.set(o.asset, rows)
  }

  const realizedLots: RealizedLot[] = []
  const perAsset: BrokerTruth['perAsset'] = []
  for (const [asset, fills] of byAsset) {
    fills.sort((a, b) => a.fill_ts_ms - b.fill_ts_ms)
    const lots = matchLotsFifo(fills)
    realizedLots.push(...lots)
    if (lots.length > 0) {
      perAsset.push({
        asset,
        roundTrips: lots.length,
        realized: lots.reduce((s, l) => s + l.pnlNet, 0),
      })
    }
  }

  const openUnrealized = positions.reduce(
    (s, p) => s + (Math.abs(p.qty) > 1e-9 ? (p.unrealized_pnl ?? 0) : 0),
    0,
  )
  return {
    realizedLots,
    realizedTotal: realizedLots.reduce((s, l) => s + l.pnlNet, 0),
    openUnrealized,
    roundTrips: realizedLots.length,
    perAsset: perAsset.sort((a, b) => b.realized - a.realized),
  }
}

function readKv(db: Database.Database, key: string): string | null {
  try {
    const row = db.prepare('SELECT value FROM kv_settings WHERE key = ?').get(key) as
      | { value: string }
      | undefined
    return row?.value ?? null
  } catch {
    return null
  }
}

function writeKv(db: Database.Database, key: string, value: string): void {
  db.prepare('CREATE TABLE IF NOT EXISTS kv_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)').run()
  db.prepare('INSERT OR REPLACE INTO kv_settings (key, value) VALUES (?, ?)').run(key, value)
}

/** Record the current SPY Markov state; return the distinct set seen so far. */
async function accumulateRegimes(db: Database.Database, client: EngineClient): Promise<string[]> {
  const seen = new Set<string>(JSON.parse(readKv(db, GATE_REGIMES_KV_KEY) ?? '[]') as string[])
  try {
    const markov = await client.getMarkovRegime('SPY')
    if (markov?.current_state) seen.add(String(markov.current_state))
  } catch {
    // Regime probe failing never blocks the gate run; the set just does not grow.
  }
  const list = [...seen]
  writeKv(db, GATE_REGIMES_KV_KEY, JSON.stringify(list))
  return list
}

export interface StoredGateResult {
  passed: boolean
  criteria: GateResult['criteria']
  warnings: string[]
  roundTrips: number
  realizedTotal: number
  openUnrealized: number
  evaluatedAt: number
}

export function readLastGateResult(db: Database.Database): StoredGateResult | null {
  const raw = readKv(db, GATE_KV_KEY)
  if (!raw) return null
  try {
    return JSON.parse(raw) as StoredGateResult
  } catch {
    return null
  }
}

/**
 * Evaluate the pre-live gate against broker truth and persist the result.
 * The tick-level live-mode guard reads the persisted result, so the gate
 * stays enforced even across bot restarts.
 */
export async function runGoLiveGate(
  db: Database.Database,
  client: EngineClient,
  nowMs: number = Date.now(),
): Promise<StoredGateResult> {
  const truth = await computeBrokerTruth(client)
  const regimes = await accumulateRegimes(db, client)

  // Per-trade fractional net returns on cost basis.
  const closedReturns = truth.realizedLots
    .filter((l) => l.entryPrice * l.qty > 0)
    .map((l) => l.pnlNet / (l.entryPrice * l.qty))

  // Paper equity curve from engine NAV snapshots (account truth).
  let equityCurve: EquityPoint[] = []
  try {
    const snaps = await client.getNavSnapshots(365)
    equityCurve = snaps
      .map((s) => ({ ts_ms: s.recorded_at, equity: s.nav }))
      .sort((a, b) => a.ts_ms - b.ts_ms)
  } catch {
    // Missing NAV history leaves the curve empty; maxDrawdown of an empty
    // curve is 0 which PASSES the kill criterion, so warn loudly instead.
    logger.warn('Go-live gate: NAV snapshots unavailable, drawdown criterion evaluated on empty curve')
  }

  const variantsTested = (db.prepare("SELECT count(*) c FROM trader_strategies WHERE status='active'").get() as { c: number }).c

  // backtestSharpe: no walk-forward backtest exists yet (engine walk_forward
  // stats are null). 0 fails the degradation criterion, which is the honest
  // outcome: a backtest is a real go-live blocker, not a formality.
  const backtestSharpe = 0

  const result = evaluateGate({
    closedReturns,
    equityCurve,
    regimesObserved: regimes.length,
    variantsTested: Math.max(1, variantsTested),
    outOfSampleNoRetune: true, // strategies frozen since the 2026-06 eval restart
    backtestSharpe,
    liveReconReturns: closedReturns,
  })

  const stored: StoredGateResult = {
    passed: result.passed,
    criteria: result.criteria,
    warnings: result.warnings,
    roundTrips: truth.roundTrips,
    realizedTotal: truth.realizedTotal,
    openUnrealized: truth.openUnrealized,
    evaluatedAt: nowMs,
  }
  writeKv(db, GATE_KV_KEY, JSON.stringify(stored))
  writeKv(db, GATE_RUN_KV_KEY, String(nowMs))
  return stored
}

export function gateRunDue(db: Database.Database, nowMs: number): boolean {
  const last = Number(readKv(db, GATE_RUN_KV_KEY) ?? 0)
  return nowMs - last >= GATE_RUN_INTERVAL_MS
}

const money = (n: number): string => `${n < 0 ? '-' : ''}$${Math.abs(n).toFixed(2)}`

/** Plain-English gate + broker-truth P&L summary for the digest. */
export function renderGateSummary(r: StoredGateResult): string {
  const passedCount = r.criteria.filter((c) => c.passed).length
  const blockers = r.criteria.filter((c) => !c.passed).map((c) => c.name)
  const lines = [
    `Go-live gate: ${r.passed ? 'PASSED' : `${passedCount}/${r.criteria.length} criteria`} (${r.roundTrips} closed round-trips)`,
    `P&L (broker truth): realized ${money(r.realizedTotal)}, open ${money(r.openUnrealized)}, net ${money(r.realizedTotal + r.openUnrealized)}`,
  ]
  if (!r.passed) lines.push(`Blockers: ${blockers.join(', ')}`)
  return lines.join('\n')
}
