import Database from 'better-sqlite3'
import { vi } from 'vitest'
import { initTraderTables } from '../db.js'
import { runTraderTick, _resetTickLockForTest, _resetHaltAlertForTest, _getAndResetZeroPollCountForTest,
  type TraderSchedulerDeps } from '../trader-scheduler.js'
import { isEquityMarketHours } from '../signal-poller.js'
import { logger } from '../../logger.js'
import * as strategies from '../strategy-manager.js'
import { createDraftCohort, activateCohort, type CohortAssetClass } from '../evaluation-cohort.js'
import { GATE_VERSION, gateConfigFingerprint } from '../go-live-gate.js'
import type { EngineClient } from '../engine-client.js'
import type { FakeEngine } from './fake-engine.js'

// Earnings lookups go to the network. vi.mock is hoisted per test file, not per imported
// module, so each *.replay.ts file must declare:
//   vi.mock('../earnings.js', async (orig) => ({ ...(await orig<typeof import('../earnings.js')>()), daysToEarnings: async () => null }))

export interface ReplayResult {
  ticks: number
  decisions: Array<{ id: string; asset: string; action: string; status: string; decided_at: number; strategy_id: string }>
  realized: Array<{ asset: string; pnl_net: number; exit_ts_ms: number }>
  signalStatus: Record<string, number>
  maxOpenPerAsset: Record<string, number>
  /** Errors the tick caught and logged (logger.error, or logger.warn with an err). Expected empty. */
  errors: string[]
}

const SEEDS: Record<string, (db: Database.Database) => void> = {
  'momentum-stocks': strategies.seedMomentumStrategy,
  'mean-reversion-stocks': strategies.seedMeanReversionStrategy,
  'momentum-crypto': strategies.seedCryptoMomentumStrategy,
  'mean-reversion-hourly-crypto': strategies.seedCryptoHourlyMeanReversionStrategy,
  'trend-4h-crypto': strategies.seedCryptoFourHourTrendStrategy,
  'momentum-vt-crypto': strategies.seedCryptoMomentumVtStrategy,
  'rsi2-stocks': strategies.seedRsi2Strategy,
  'ibs-stocks': strategies.seedIbsStrategy,
}

const DEFAULT_UNIVERSE = ['AAPL', 'MSFT', 'SPY', 'QQQ', 'IWM', 'VTI', 'EEM', 'EFA', 'GLD', 'IEF', 'TLT', 'DBC',
  'XLB', 'XLE', 'XLF', 'XLI', 'XLK', 'XLP', 'XLU', 'XLV', 'XLY']

/** In-memory bot DB with the listed strategies active, each with a running paper cohort. */
export function freshReplayDb(strategyIds: string[], universe: string[] = DEFAULT_UNIVERSE): Database.Database {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = OFF')
  initTraderTables(db)
  db.prepare('CREATE TABLE IF NOT EXISTS kv_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)').run()
  // Far-future "last fired" stamps keep the weekly report and weekly go-live gate quiet at any replay date.
  const never = String(Number.MAX_SAFE_INTEGER)
  db.prepare('INSERT OR REPLACE INTO kv_settings (key, value) VALUES (?, ?)').run('trader.lastWeeklyReport', never)
  db.prepare('INSERT OR REPLACE INTO kv_settings (key, value) VALUES (?, ?)').run('trader.gate.last_run_ms', never)
  for (const id of strategyIds) {
    const seed = SEEDS[id]
    if (!seed) throw new Error(`replay: no seed for strategy ${id}`)
    seed(db)
    db.prepare("UPDATE trader_strategies SET status='active' WHERE id=?").run(id)
    const { asset_class } = db.prepare('SELECT asset_class FROM trader_strategies WHERE id=?').get(id) as { asset_class: CohortAssetClass }
    const crypto = asset_class === 'crypto'
    // Limits and costs copied from the production running cohorts (stocks-momentum-paper-20261013-v3, stocks-rsi2-paper-20261012-v1).
    createDraftCohort(db, {
      id: `${id}-replay`, strategyId: id, assetClass: asset_class,
      universe: crypto ? ['BTC/USD'] : universe, dataVenue: crypto ? 'coinbase' : 'alpaca', executionVenue: crypto ? 'coinbase' : 'alpaca',
      feeBpsPerSide: 0, slippageBpsPerSide: 5, benchmarkAsset: 'SPY',
      maxPositionUsd: 10_000, dailyTradeCap: 5,
      claudepawRevision: '0000000', engineRevision: '0000000',
    })
    activateCohort(db, `${id}-replay`, {
      engineMode: 'paper', brokerConnected: true, dataVenueConnected: true, assetClassEnabled: true,
      reconcilerHalted: false, reconcileDriftDetected: false, reconcileFresh: true,
      ordersAvailable: true, positionsAvailable: true, openOrderCount: 0,
      conflictingPositionCount: 0, unknownOrderCount: 0, unexpectedShortCount: 0,
      quarantineLegacyPositions: true,
    }, 'replay')
  }
  // A current stored gate result, written after seeding so the config fingerprint matches.
  db.prepare('INSERT OR REPLACE INTO kv_settings (key, value) VALUES (?, ?)').run('trader.gate.last',
    JSON.stringify({ version: GATE_VERSION, configFingerprint: gateConfigFingerprint(db), passed: false, criteria: [], evaluatedAt: Date.now() }))
  return db
}

/** Committee stub that approves every signal at $150 (makeApproveCommittee in decision-dispatcher.test.ts). */
export const approveCommittee: NonNullable<TraderSchedulerDeps['runCommittee']> = async (s) => ({
  decision: 'approve',
  action: s.side,
  thesis: 'Stub approve: strong momentum + risk clear.',
  confidence: 0.78,
  size_usd: 150,
  transcript_id: 'tr-replay-approve',
  transcript: {
    signal_id: s.id,
    started_at: Date.now(),
    finished_at: Date.now(),
    rounds_executed: 1,
    round_1: [],
    risk_officer: { role: 'risk_officer', veto: false, reason: 'clear', concerns: [] },
    trader: { role: 'trader', action: s.side, thesis: 'ok', confidence: 0.78, size_multiplier: 1.5 },
    errors: [],
  },
})

const nyDate = (ms: number) => new Date(ms).toLocaleDateString('en-CA', { timeZone: 'America/New_York' })
const nyMinutes = (ms: number) => {
  const p = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(ms)
  return Number(p.find(x => x.type === 'hour')!.value) * 60 + Number(p.find(x => x.type === 'minute')!.value)
}
const CLOSE_TICK_MIN = 16 * 60 + 5

function errText(args: unknown[]): string | null {
  const [obj, msg] = args as [unknown, unknown]
  if (typeof obj === 'string') return obj
  const err = (obj as { err?: unknown } | null)?.err
  const detail = err instanceof Error ? err.message : err === undefined ? '' : String(err)
  return `${String(msg ?? '')}${detail ? ': ' + detail : ''}`
}

/**
 * Step a fake clock through [from, to] (NY dates) and run the real trader tick each step:
 * every in-session tick plus one after-close tick per trading day.
 * Callers wrap this in vi.useFakeTimers({ toFake: ['Date'] }) / vi.useRealTimers(); faking only Date keeps promises resolving.
 */
export async function replay(opts: {
  db: Database.Database; engine: FakeEngine; from: string; to: string; tickMinutes?: number
  runCommittee?: TraderSchedulerDeps['runCommittee']; beforeTick?: (nowMs: number) => void | Promise<void>
}): Promise<ReplayResult> {
  const step = (opts.tickMinutes ?? 15) * 60_000
  const deps: TraderSchedulerDeps = {
    db: opts.db, getEngineClient: () => opts.engine as unknown as EngineClient, send: async () => {},
    runCommittee: opts.runCommittee ?? approveCommittee,
  }
  // Scheduler counters are module state; start each replay clean so scenarios in one file do not leak.
  _resetHaltAlertForTest()
  _getAndResetZeroPollCountForTest()
  const errors: string[] = []
  const errorSpy = vi.spyOn(logger, 'error').mockImplementation((...a: unknown[]) => { errors.push(`error: ${errText(a)}`) })
  const warnSpy = vi.spyOn(logger, 'warn').mockImplementation((...a: unknown[]) => {
    if (a[0] && typeof a[0] === 'object' && 'err' in a[0]) errors.push(`warn: ${errText(a)}`)
  })
  // The tick probes the dashboard kill switch over HTTP. Answer "clear" and fail loudly on any other request.
  const realFetch = globalThis.fetch
  globalThis.fetch = (async (url: string | URL | Request) => {
    const u = String(url instanceof Request ? url.url : url)
    if (u.includes('/api/v1/system-state/kill-switch')) return new Response(JSON.stringify({ active: false }), { status: 200 })
    throw new Error(`replay: network blocked ${u}`)
  }) as typeof fetch

  let ticks = 0
  const maxOpen: Record<string, number> = {}
  let openedDay = '', closedDay = ''
  try {
    // Midnight UTC of `from` through the day after `to` covers every NY minute of the window in EDT and EST.
    const end = Date.parse(opts.to + 'T00:00:00Z') + 2 * 86_400_000
    for (let t = Date.parse(opts.from + 'T00:00:00Z'); t < end; t += step) {
      const day = nyDate(t)
      if (day < opts.from || day > opts.to) continue
      const inSession = isEquityMarketHours(t)
      const closeTick = !inSession && openedDay === day && closedDay !== day && nyMinutes(t) >= CLOSE_TICK_MIN
      if (!inSession && !closeTick) continue
      vi.setSystemTime(t)
      if (inSession && openedDay !== day) { openedDay = day; opts.engine.recordNav('day_open') }
      if (closeTick) { closedDay = day; opts.engine.recordNav('day_close') }
      await opts.beforeTick?.(t)
      opts.engine.settle()
      _resetTickLockForTest()
      await runTraderTick(deps)
      ticks++
      for (const p of await opts.engine.getPositions()) maxOpen[p.asset] = Math.max(maxOpen[p.asset] ?? 0, 1)
      const open = opts.db.prepare(`SELECT asset, COUNT(*) n FROM trader_decisions
        WHERE status IN ('executed','submitted','pending_fill','retry_pending') AND action='buy' GROUP BY asset`).all() as Array<{ asset: string; n: number }>
      for (const r of open) maxOpen[r.asset] = Math.max(maxOpen[r.asset] ?? 0, r.n)
    }
  } finally {
    globalThis.fetch = realFetch
    errorSpy.mockRestore()
    warnSpy.mockRestore()
  }

  const decisions = opts.db.prepare(`SELECT d.id, d.asset, d.action, d.status, d.decided_at, s.strategy_id
    FROM trader_decisions d JOIN trader_signals s ON s.id = d.signal_id ORDER BY d.decided_at`).all() as ReplayResult['decisions']
  const realized = opts.db.prepare('SELECT asset, pnl_net, exit_ts_ms FROM trader_realized_pnl ORDER BY exit_ts_ms').all() as ReplayResult['realized']
  const signalStatus: Record<string, number> = {}
  for (const r of opts.db.prepare('SELECT status, COUNT(*) n FROM trader_signals GROUP BY status').all() as Array<{ status: string; n: number }>) {
    signalStatus[r.status] = r.n
  }
  return { ticks, decisions, realized, signalStatus, maxOpenPerAsset: maxOpen, errors }
}
