/** Deterministic progress reporting. No order, risk, strategy or mode mutations. */
import type Database from 'better-sqlite3'
import type { HealthResponse } from './types.js'
import { ACCOUNTING_KV_KEY, GATE_RUN_INTERVAL_MS, GATE_VERSION, gateConfigFingerprint, readLastGateResult } from './go-live-gate.js'

export const PROGRESS_KV_KEY = 'trader.progress.last'
export const PROGRESS_DELIVERY_KEY = 'trader.progress.last_delivery'
const STALE_MS = 15 * 60 * 1000
const ZONE = 'America/New_York'
const clock = new Intl.DateTimeFormat('en-CA', {
  timeZone: ZONE, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23',
})
const sending = new WeakSet<Database.Database>()

function eastern(ms: number): { date: string; hour: number } {
  const p = Object.fromEntries(clock.formatToParts(ms).map(v => [v.type, v.value]))
  return {date: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour)}
}

function readJson(db: Database.Database, key: string): Record<string, unknown> | null {
  try {
    const row = db.prepare('SELECT value FROM kv_settings WHERE key=?').get(key) as {value: string} | undefined
    const parsed: unknown = row ? JSON.parse(row.value) : null
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null
  } catch { return null }
}

function save(db: Database.Database, key: string, value: unknown): void {
  db.prepare('CREATE TABLE IF NOT EXISTS kv_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)').run()
  db.prepare('INSERT OR REPLACE INTO kv_settings (key,value) VALUES (?,?)').run(key, JSON.stringify(value))
}

export interface ProgressSnapshot {
  checked_at: number
  mode: 'paper' | 'live' | 'unknown'
  broker_connected: boolean | null
  halted: boolean | null
  accounting_fresh: boolean
  completed_entries: number | null
  realized_recorded_fees: number | null
  uncertain_exits: number
  active_strategies: string[]
  paused_strategies: string[]
  gate_evaluated_at: number | null
  gate_current: boolean
  blockers: string[]
  schedule: string
}

export function buildProgressSnapshot(db: Database.Database, health: HealthResponse | null, nowMs: number): ProgressSnapshot {
  const accounting = readJson(db, ACCOUNTING_KV_KEY)
  const stamp = accounting?.evaluated_at
  const fresh = typeof stamp === 'number' && Number.isFinite(stamp) && stamp <= nowMs && nowMs - stamp <= STALE_MS
  const gate = readLastGateResult(db)
  const current = gate?.version === GATE_VERSION && gate.configFingerprint === gateConfigFingerprint(db) &&
    Number.isFinite(gate.evaluatedAt) && gate.evaluatedAt <= nowMs && nowMs - gate.evaluatedAt < GATE_RUN_INTERVAL_MS
  const strategies = db.prepare('SELECT id,status FROM trader_strategies ORDER BY id').all() as Array<{id: string; status: string}>
  const exits = db.prepare("SELECT count(*) AS n FROM trader_decisions WHERE status='exit_unknown'").get() as {n: number}
  const blockers = Array.isArray(gate?.criteria) ? gate.criteria.filter(c => !c.passed).map(c => `${c.name}: ${c.detail}`) : []
  if (!current) blockers.unshift('Readiness evaluation is missing, stale or belongs to different strategy settings.')
  if (!fresh) blockers.unshift('Accounting is unavailable or older than 15 minutes; do not infer zero profit or no positions.')
  if (accounting?.costs_complete !== true) blockers.push('Complete fees, spread/slippage and broker-ledger reconciliation are not verified.')
  if (!health || health.alpaca_connected !== true) blockers.unshift('Engine/broker connectivity is unknown or unavailable.')
  if (health?.reconciler_halted === true) blockers.unshift('Trading is halted; investigate the existing operational alert.')
  if (exits.n > 0) blockers.unshift(`${exits.n} exit intent(s) have unresolved broker acceptance; retain their IDs.`)
  return {
    checked_at: nowMs,
    mode: health?.alpaca_mode === 'paper' ? 'paper' : health?.alpaca_mode === 'live' ? 'live' : 'unknown',
    broker_connected: health?.alpaca_connected ?? null, halted: health?.reconciler_halted ?? null,
    accounting_fresh: fresh,
    completed_entries: fresh && typeof accounting?.round_trips === 'number' && Number.isFinite(accounting.round_trips) ? accounting.round_trips : null,
    realized_recorded_fees: fresh && typeof accounting?.realized_total === 'number' && Number.isFinite(accounting.realized_total) ? accounting.realized_total : null,
    uncertain_exits: exits.n, active_strategies: strategies.filter(s => s.status === 'active').map(s => s.id),
    paused_strategies: strategies.filter(s => s.status === 'paused').map(s => s.id),
    gate_evaluated_at: gate && Number.isFinite(gate.evaluatedAt) ? gate.evaluatedAt : null,
    gate_current: current, blockers,
    schedule: 'Health/progress: every 5 minutes while the bot runs. Daily summary: 17:00 America/New_York. Weekly review: Sunday 09:00 America/New_York.',
  }
}

export function renderProgressReport(snapshot: ProgressSnapshot, previousEntries: unknown): string {
  const delta = snapshot.completed_entries != null && typeof previousEntries === 'number' && Number.isFinite(previousEntries)
    ? snapshot.completed_entries - previousEntries : null
  const lines = [
    `PAWTRADER DAILY READINESS, ${eastern(snapshot.checked_at).date}`,
    `Mode: ${snapshot.mode}. Broker: ${snapshot.broker_connected == null ? 'unknown' : snapshot.broker_connected ? 'connected' : 'offline'}.`,
    `Completed entries: ${snapshot.completed_entries ?? 'unavailable'}${delta == null ? '' : ` (${delta >= 0 ? '+' : ''}${delta} since prior report; reconciliations can revise counts)`}.`,
    `Realized P&L, recorded fees only: ${snapshot.realized_recorded_fees == null ? 'unavailable/stale' : `$${snapshot.realized_recorded_fees.toFixed(2)}`}. Not verified net live returns.`,
    `Active: ${snapshot.active_strategies.join(', ') || 'none'}. Paused: ${snapshot.paused_strategies.join(', ') || 'none'}.`,
    `Readiness evaluated: ${snapshot.gate_evaluated_at == null ? 'never' : new Date(snapshot.gate_evaluated_at).toISOString()} (${snapshot.gate_current ? 'current' : 'stale/invalid'}).`,
    ...snapshot.blockers.map(b => `• ${b}`),
    'Next step: resolve evidence/engineering blockers, then assess a frozen prospective paper evaluation. More calendar time alone cannot clear missing evidence.',
    snapshot.schedule,
    'No automatic live switch. Even passing checks requires operator review; profits are not guaranteed.',
  ]
  return lines.join('\n')
}

/** Called each tick. Delivery catches up after the daily slot and survives restarts. */
export async function checkPaperProgress(
  db: Database.Database, health: HealthResponse | null, send: (text: string) => Promise<void>, nowMs = Date.now(),
): Promise<{sent: boolean; snapshot: ProgressSnapshot}> {
  const snapshot = buildProgressSnapshot(db, health, nowMs)
  save(db, PROGRESS_KV_KEY, snapshot)
  const slot = eastern(nowMs)
  const previous = readJson(db, PROGRESS_DELIVERY_KEY)
  if (slot.hour < 17 || (typeof previous?.date === 'string' && previous.date >= slot.date) || sending.has(db)) return {sent: false, snapshot}
  sending.add(db)
  try {
    // Precondition: Phase 1 Task 10 quiet-hours buffer (notify_quiet_buffer)
    // is the owner-facing gate; this call goes through the trader digest first.
    await send(renderProgressReport(snapshot, previous?.completed_entries))
    save(db, PROGRESS_DELIVERY_KEY, {date: slot.date, delivered_at: nowMs, completed_entries: snapshot.completed_entries})
    return {sent: true, snapshot}
  } finally { sending.delete(db) }
}
