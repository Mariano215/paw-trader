import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import { initTraderTables } from './db.js'
import { seedMomentumStrategy } from './strategy-manager.js'
import {
  initTraderScheduler,
  stopTraderScheduler,
  runTraderTick,
  _resetHaltAlertForTest,
  _resetTickLockForTest,
} from './trader-scheduler.js'
import * as loggerModule from '../logger.js'
import type { EngineClient } from './engine-client.js'
import type { TraderApprovalKeyboard } from './approval-manager.js'

function makeDb() {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = OFF')
  initTraderTables(db)
  seedMomentumStrategy(db)
  // Phase 4 Task C -- pre-mark the weekly report as already fired today
  // so the Sunday 09:00 NY gate inside runTraderTick is a no-op in these
  // tests. The weekly report itself is exercised in weekly-report.test.ts.
  // kv_settings table + the known key are created on demand.
  db.prepare(`
    CREATE TABLE IF NOT EXISTS kv_settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `).run()
  db.prepare('INSERT OR REPLACE INTO kv_settings (key, value) VALUES (?, ?)')
    .run('trader.lastWeeklyReport', String(Date.now()))
  return db
}

function insertSignal(db: Database.Database, id: string, score = 0.72) {
  db.prepare(`
    INSERT INTO trader_signals (id, strategy_id, asset, side, raw_score, horizon_days, generated_at, status)
    VALUES (?, 'momentum-stocks', 'AAPL', 'buy', ?, 20, ?, 'pending')
  `).run(id, score, Date.now())
}

const healthOk = {
  status: 'ok',
  version: '0.1.0',
  alpaca_connected: true,
  alpaca_mode: 'paper' as const,
  reconciler_halted: false,
  halt_reason: null,
  coinbase_connected: true,
}

describe('trader-scheduler', () => {
  let db: ReturnType<typeof makeDb>
  let sendMock: ReturnType<typeof vi.fn>
  let sendWithKeyboardMock: ReturnType<typeof vi.fn>
  let engineClient: Partial<EngineClient>
  let getEngineClientMock: ReturnType<typeof vi.fn>

  /** Plain-text alert send (halt alerts, etc.). */
  const send = (text: string): Promise<void> =>
    (sendMock as unknown as (text: string) => Promise<void>)(text)

  /** Approval card send with inline keyboard. */
  const sendWithKeyboard = (text: string, keyboard: TraderApprovalKeyboard): Promise<void> =>
    (sendWithKeyboardMock as unknown as (t: string, k: TraderApprovalKeyboard) => Promise<void>)(text, keyboard)

  const getEngineClient = (): EngineClient =>
    (getEngineClientMock as unknown as () => EngineClient)()

  beforeEach(() => {
    db = makeDb()
    sendMock = vi.fn().mockResolvedValue(undefined)
    sendWithKeyboardMock = vi.fn().mockResolvedValue(undefined)
    engineClient = {
      getHealth: vi.fn().mockResolvedValue(healthOk),
      getSignals: vi.fn().mockResolvedValue([]),
      getPositions: vi.fn().mockResolvedValue([]),
      getOrders: vi.fn().mockResolvedValue([]),
      // Phase 4 Task B: close-out watcher calls /prices when a decision
      // closes in a given tick. Stub as empty so the trader-scheduler
      // tests stay focused on scheduler behaviour, not price math.
      getPrices: vi.fn().mockResolvedValue([]),
    }
    getEngineClientMock = vi.fn().mockReturnValue(engineClient)
    _resetHaltAlertForTest()
    _resetTickLockForTest()
  })

  afterEach(() => {
    stopTraderScheduler()
    vi.useRealTimers()
  })

  describe('runTraderTick', () => {
    it('runs all phases successfully with no signals', async () => {
      const result = await runTraderTick({ db, getEngineClient, send, sendWithKeyboard })
      expect(result.polled).toBe(true)
      expect(result.sent).toBe(0)
      expect(result.timedOut).toBe(0)
      expect(result.reconcilerHalted).toBe(false)
      expect(sendMock).not.toHaveBeenCalled()
      expect(sendWithKeyboardMock).not.toHaveBeenCalled()
    })

    it('polls engine and sends approval card for new signals', async () => {
      vi.mocked(engineClient.getSignals!).mockResolvedValue([
        {
          id: 'sig-1', strategy: 'momentum', asset: 'AAPL', side: 'buy',
          raw_score: 0.72, horizon_days: 20, generated_at: Date.now(),
        },
      ])
      const result = await runTraderTick({ db, getEngineClient, send, sendWithKeyboard })
      expect(result.polled).toBe(true)
      expect(result.sent).toBe(1)
      expect(sendWithKeyboardMock).toHaveBeenCalledTimes(1)
      expect(sendWithKeyboardMock.mock.calls[0][0]).toContain('AAPL')
    })

    it('times out approvals older than 30 min', async () => {
      const thirtyOneMinAgo = Date.now() - 31 * 60 * 1000
      db.prepare('INSERT INTO trader_approvals (id, decision_id, sent_at) VALUES (?, ?, ?)')
        .run('ap-stale', 'sig-x', thirtyOneMinAgo)

      const result = await runTraderTick({ db, getEngineClient, send, sendWithKeyboard })
      expect(result.timedOut).toBe(1)

      const row = db.prepare("SELECT response FROM trader_approvals WHERE id='ap-stale'").get() as any
      expect(row.response).toBe('timeout')
      // Orphan approval (no signal row) -- metadata is null so no Telegram notice is sent.
      expect(sendMock).not.toHaveBeenCalled()
    })

    it('sends a plain-text expiry notice when a joined signal row is present', async () => {
      const thirtyOneMinAgo = Date.now() - 31 * 60 * 1000
      db.prepare(`
        INSERT INTO trader_signals (id, strategy_id, asset, side, raw_score, horizon_days, generated_at, status)
        VALUES (?, 'momentum-stocks', 'NVDA', 'buy', 0.73, 20, ?, 'pending')
      `).run('sig-expire', Date.now())
      db.prepare('INSERT INTO trader_approvals (id, decision_id, sent_at) VALUES (?, ?, ?)')
        .run('ap-expire', 'sig-expire', thirtyOneMinAgo)

      const result = await runTraderTick({ db, getEngineClient, send, sendWithKeyboard })
      expect(result.timedOut).toBe(1)
      expect(sendMock).toHaveBeenCalledTimes(1)
      const text = sendMock.mock.calls[0][0] as string
      expect(text).toBe('Signal expired: NVDA BUY $200 - no trade placed.')
    })

    it('continues when the timeout notifier throws', async () => {
      const thirtyOneMinAgo = Date.now() - 31 * 60 * 1000
      db.prepare(`
        INSERT INTO trader_signals (id, strategy_id, asset, side, raw_score, horizon_days, generated_at, status)
        VALUES (?, 'momentum-stocks', 'TSLA', 'sell', 0.65, 20, ?, 'pending')
      `).run('sig-e2', Date.now())
      db.prepare('INSERT INTO trader_approvals (id, decision_id, sent_at) VALUES (?, ?, ?)')
        .run('ap-e2', 'sig-e2', thirtyOneMinAgo)

      sendMock.mockRejectedValueOnce(new Error('telegram 503'))

      const result = await runTraderTick({ db, getEngineClient, send, sendWithKeyboard })
      expect(result.timedOut).toBe(1)
      const row = db.prepare("SELECT response FROM trader_approvals WHERE id='ap-e2'").get() as any
      expect(row.response).toBe('timeout') // DB transition still committed
    })

    it('continues even when engine poll fails', async () => {
      vi.mocked(engineClient.getSignals!).mockRejectedValue(new Error('engine down'))
      insertSignal(db, 'sig-preexisting')

      const result = await runTraderTick({ db, getEngineClient, send, sendWithKeyboard })
      expect(result.polled).toBe(true)
      expect(result.sent).toBe(1)
      expect(sendWithKeyboardMock).toHaveBeenCalled()
    })

    it('continues when getEngineClient throws (credentials missing)', async () => {
      getEngineClientMock.mockImplementation(() => {
        throw new Error('credentials not configured')
      })
      insertSignal(db, 'sig-preexisting')

      const result = await runTraderTick({ db, getEngineClient, send, sendWithKeyboard })
      expect(result.polled).toBe(false)
      expect(result.sent).toBe(1)
    })

    it('continues when sendWithKeyboard fails for one signal', async () => {
      insertSignal(db, 'sig-1', 0.9)
      insertSignal(db, 'sig-2', 0.8)
      let calls = 0
      const flakySwk = async (): Promise<void> => {
        calls++
        if (calls === 1) throw new Error('telegram 503')
      }

      const result = await runTraderTick({ db, getEngineClient, send, sendWithKeyboard: flakySwk })
      expect(result.sent).toBe(1)
    })

    it('sends halt alert via plain send when reconciler_halted is true', async () => {
      vi.mocked(engineClient.getHealth!).mockResolvedValue({
        ...healthOk,
        reconciler_halted: true,
        halt_reason: 'daily_loss_limit',
      })

      const result = await runTraderTick({ db, getEngineClient, send, sendWithKeyboard })
      expect(result.reconcilerHalted).toBe(true)
      expect(sendMock).toHaveBeenCalledWith(expect.stringContaining('reconciler halted'))
      expect(sendMock.mock.calls[0][0]).toContain('daily_loss_limit')
      // Approval cards go through sendWithKeyboard, not send
      expect(sendWithKeyboardMock).not.toHaveBeenCalled()
    })

    it('does not spam halt alerts on repeated ticks when halted', async () => {
      vi.mocked(engineClient.getHealth!).mockResolvedValue({
        ...healthOk,
        reconciler_halted: true,
        halt_reason: 'daily_loss_limit',
      })

      await runTraderTick({ db, getEngineClient, send, sendWithKeyboard })
      sendMock.mockClear()
      await runTraderTick({ db, getEngineClient, send, sendWithKeyboard })

      const haltCalls = sendMock.mock.calls.filter((args: unknown[]) => typeof args[0] === 'string' && args[0].includes('reconciler halted'))
      expect(haltCalls).toHaveLength(0)
    })

    it('resets halt flag and re-alerts when reconciler recovers then halts again', async () => {
      vi.mocked(engineClient.getHealth!).mockResolvedValue({ ...healthOk, reconciler_halted: true, halt_reason: 'r1' })
      await runTraderTick({ db, getEngineClient, send, sendWithKeyboard })
      expect(sendMock.mock.calls.filter((args: unknown[]) => typeof args[0] === 'string' && args[0].includes('reconciler halted'))).toHaveLength(1)

      sendMock.mockClear()
      vi.mocked(engineClient.getHealth!).mockResolvedValue({ ...healthOk, reconciler_halted: false })
      await runTraderTick({ db, getEngineClient, send, sendWithKeyboard })
      expect(sendMock.mock.calls.filter((args: unknown[]) => typeof args[0] === 'string' && args[0].includes('reconciler halted'))).toHaveLength(0)

      sendMock.mockClear()
      vi.mocked(engineClient.getHealth!).mockResolvedValue({ ...healthOk, reconciler_halted: true, halt_reason: 'r2' })
      await runTraderTick({ db, getEngineClient, send, sendWithKeyboard })
      expect(sendMock.mock.calls.filter((args: unknown[]) => typeof args[0] === 'string' && args[0].includes('reconciler halted'))).toHaveLength(1)
    })

    it('continues when health check fails', async () => {
      vi.mocked(engineClient.getHealth!).mockRejectedValue(new Error('health endpoint down'))
      insertSignal(db, 'sig-1')

      const result = await runTraderTick({ db, getEngineClient, send, sendWithKeyboard })
      expect(result.polled).toBe(true)
      expect(result.sent).toBe(1)
    })

    it('runs close-out sweep and reports processed count when a position closed', async () => {
      // Seed an executed decision whose asset is no longer in engine positions,
      // and provide matching buy+sell fills so the verdict path completes.
      insertSignal(db, 'sig-c')
      db.prepare(`
        INSERT INTO trader_decisions
          (id, signal_id, action, asset, size_usd, entry_type, thesis, confidence,
           committee_transcript_id, decided_at, status)
        VALUES ('dec-c', 'sig-c', 'buy', 'AAPL', 100, 'limit', 't', 0.7, NULL, 1000, 'executed')
      `).run()
      vi.mocked(engineClient.getPositions!).mockResolvedValue([])
      vi.mocked(engineClient.getOrders!).mockResolvedValue([
        { client_order_id: 'b', broker_order_id: null, asset: 'AAPL', side: 'buy',
          qty: 1, order_type: 'limit', limit_price: null, status: 'filled',
          filled_qty: 1, filled_avg_price: 100, source: 't', created_at: 1100, updated_at: 1100 },
        { client_order_id: 's', broker_order_id: null, asset: 'AAPL', side: 'sell',
          qty: 1, order_type: 'limit', limit_price: null, status: 'filled',
          filled_qty: 1, filled_avg_price: 110, source: 't', created_at: 5000, updated_at: 5000 },
      ])

      const result = await runTraderTick({ db, getEngineClient, send, sendWithKeyboard })
      expect(result.closedOut).toBe(1)

      const verdict = db.prepare('SELECT pnl_gross FROM trader_verdicts WHERE decision_id=?').get('dec-c') as any
      expect(verdict.pnl_gross).toBe(10)
    })

    it('close-out failure does not halt other phases', async () => {
      insertSignal(db, 'sig-poll')
      vi.mocked(engineClient.getPositions!).mockRejectedValue(new Error('positions endpoint down'))

      // An executed decision must exist for runCloseOutSweep to even call getPositions.
      db.prepare(`
        INSERT INTO trader_decisions
          (id, signal_id, action, asset, size_usd, entry_type, thesis, confidence,
           committee_transcript_id, decided_at, status)
        VALUES ('dec-x', 'sig-poll', 'buy', 'AAPL', 100, 'limit', 't', 0.7, NULL, 1000, 'executed')
      `).run()

      const result = await runTraderTick({ db, getEngineClient, send, sendWithKeyboard })
      expect(result.polled).toBe(true)
      expect(result.sent).toBe(1)
      expect(result.closedOut).toBe(0)
    })
  })

  // Phase 5 Task 2 Dispatch C -- monitoring alerts wire-in (Phase 6).
  //
  // Each tick now runs four monitor checks after the weekly-report gate:
  //   1. abstain digest      (read-only, recorded on fire)
  //   2. sharpe flip         (self-records sign every tick)
  //   3. coinbase health     (self-tracks first_down marker, recorded on fire)
  //   4. NAV drop halt       (recorded on fire, also calls engineClient.haltEngine)
  //
  // Each check is wrapped in its own try/catch so one throwing check
  // cannot starve the others.  Telegram emission is via deps.send (the
  // same plain-text path the engine-halt alert uses).
  describe('runTraderTick phase 6: monitoring alerts', () => {
    function insertAbstain(
      d: Database.Database,
      idx: number,
      asset = 'AAPL',
      thesis = 'committee could not agree',
    ) {
      const sigId = `sig-ab-${idx}`
      d.prepare(`
        INSERT INTO trader_signals (id, strategy_id, asset, side, raw_score, horizon_days, generated_at, status)
        VALUES (?, 'momentum-stocks', ?, 'buy', 0.5, 20, ?, 'decided')
      `).run(sigId, asset, Date.now())
      d.prepare(`
        INSERT INTO trader_decisions
          (id, signal_id, action, asset, size_usd, entry_type, thesis, confidence,
           committee_transcript_id, decided_at, status)
        VALUES (?, ?, 'abstain', ?, 0, 'none', ?, 0.1, NULL, ?, 'committee_abstain')
      `).run(`dec-ab-${idx}`, sigId, asset, thesis, Date.now() - 1000)
    }

    function upsertTrack(d: Database.Database, strategyId: string, tradeCount: number, sharpe: number) {
      d.prepare(`
        INSERT INTO trader_strategy_track_record
          (strategy_id, trade_count, win_count, rolling_sharpe,
           avg_winner_pct, avg_loser_pct, max_dd_pct, net_pnl_usd, computed_at)
        VALUES (?, ?, 0, ?, 0, 0, 0, 0, ?)
        ON CONFLICT(strategy_id) DO UPDATE SET
          trade_count = excluded.trade_count,
          rolling_sharpe = excluded.rolling_sharpe,
          computed_at = excluded.computed_at
      `).run(strategyId, tradeCount, sharpe, Date.now())
    }

    it('abstain digest fires -> send called with message AND recordAlertFired row exists', async () => {
      // 4 abstains in the past 24h, no prior alert row.
      for (let i = 0; i < 4; i++) insertAbstain(db, i)

      const result = await runTraderTick({ db, getEngineClient, send, sendWithKeyboard })
      expect(result).toBeDefined()

      // The abstain digest must have been sent via the plain-text channel.
      const abstainCalls = sendMock.mock.calls.filter(
        (args: unknown[]) => typeof args[0] === 'string' && (args[0] as string).includes('abstained'),
      )
      expect(abstainCalls.length).toBeGreaterThanOrEqual(1)

      // Bookkeeping: the dedup row must now exist with a timestamp value.
      const row = db
        .prepare("SELECT last_alerted_at FROM trader_alert_state WHERE alert_id='abstain_digest'")
        .get() as { last_alerted_at: number } | undefined
      expect(row).toBeDefined()
      expect(row!.last_alerted_at).toBeGreaterThan(Date.now() - 5 * 60 * 1000)
    })

    it('sharpe flip fires -> send called with the flip message', async () => {
      // Active strategy with prior +1 sign and current -0.4 rolling_sharpe.
      upsertTrack(db, 'momentum-stocks', 40, -0.4)
      db.prepare(`
        INSERT INTO trader_alert_state (alert_id, last_alerted_at)
        VALUES ('sharpe_last_sign:momentum-stocks', 1)
      `).run()

      await runTraderTick({ db, getEngineClient, send, sendWithKeyboard })

      const flipCalls = sendMock.mock.calls.filter(
        (args: unknown[]) => typeof args[0] === 'string' && (args[0] as string).includes('Sharpe flip'),
      )
      expect(flipCalls.length).toBe(1)
      expect(flipCalls[0][0]).toContain('momentum-stocks')
    })

    it('coinbase outage past grace fires -> send called AND coinbase_alert row exists', async () => {
      // Seed first_down 20 minutes ago so the 15-min grace has passed.
      const twentyMinAgo = Date.now() - 20 * 60 * 1000
      db.prepare(
        "INSERT INTO trader_alert_state (alert_id, last_alerted_at) VALUES ('coinbase_first_down', ?)",
      ).run(twentyMinAgo)

      // Health says Coinbase is still down.
      vi.mocked(engineClient.getHealth!).mockResolvedValue({
        ...healthOk,
        coinbase_connected: false,
      })

      await runTraderTick({ db, getEngineClient, send, sendWithKeyboard })

      const coinbaseCalls = sendMock.mock.calls.filter(
        (args: unknown[]) => typeof args[0] === 'string' && (args[0] as string).includes('Coinbase connection down'),
      )
      expect(coinbaseCalls.length).toBe(1)

      const row = db
        .prepare("SELECT last_alerted_at FROM trader_alert_state WHERE alert_id='coinbase_alert'")
        .get() as { last_alerted_at: number } | undefined
      expect(row).toBeDefined()
    })

    it('NAV drop fires -> send called AND haltEngine called AND nav_drop_alert row exists', async () => {
      const NOW = Date.now()
      const DAY = 24 * 60 * 60 * 1000
      // Snapshots: current 9400, 7-day-old 10000 -> 6% drop.
      vi.mocked(engineClient.getNavSnapshots = vi.fn() as any).mockResolvedValue([
        { date: '2026-04-19', period: 'day_open', nav: 9400, recorded_at: NOW },
        { date: '2026-04-12', period: 'day_open', nav: 10000, recorded_at: NOW - 7 * DAY + 60_000 },
      ])
      const haltMock = vi.fn().mockResolvedValue({ status: 'halted' })
      ;(engineClient as any).haltEngine = haltMock

      await runTraderTick({ db, getEngineClient, send, sendWithKeyboard })

      // The Telegram alert and the engine halt call BOTH happen.
      const navCalls = sendMock.mock.calls.filter(
        (args: unknown[]) => typeof args[0] === 'string' && (args[0] as string).includes('NAV drop halt'),
      )
      expect(navCalls.length).toBe(1)
      expect(navCalls[0][0]).toContain('10000.00')
      expect(navCalls[0][0]).toContain('9400.00')
      expect(haltMock).toHaveBeenCalledTimes(1)
      expect(haltMock.mock.calls[0][0]).toContain('NAV drop halt')

      // Bookkeeping: dedup row exists with a timestamp.
      const row = db
        .prepare("SELECT last_alerted_at FROM trader_alert_state WHERE alert_id='nav_drop_alert'")
        .get() as { last_alerted_at: number } | undefined
      expect(row).toBeDefined()
      expect(row!.last_alerted_at).toBeGreaterThan(NOW - 5 * 60 * 1000)
    })

    it('a throwing monitor check does not stall the other checks', async () => {
      // Force the coinbase getHealth to throw on the SECOND health call.
      // Phase 0 already calls getHealth once (reconciler-halt check); the
      // monitor calls it again.  Coinbase check swallows the throw and
      // returns fire=false; abstain + sharpe + nav must still complete.
      let healthCalls = 0
      vi.mocked(engineClient.getHealth!).mockImplementation(async () => {
        healthCalls++
        if (healthCalls === 1) return healthOk  // phase 0 happy
        throw new Error('health endpoint flaked')
      })

      // Seed conditions so the OTHER three checks would all fire.
      for (let i = 0; i < 4; i++) insertAbstain(db, i)
      upsertTrack(db, 'momentum-stocks', 40, -0.4)
      db.prepare(`
        INSERT INTO trader_alert_state (alert_id, last_alerted_at)
        VALUES ('sharpe_last_sign:momentum-stocks', 1)
      `).run()
      const NOW = Date.now()
      const DAY = 24 * 60 * 60 * 1000
      vi.mocked(engineClient.getNavSnapshots = vi.fn() as any).mockResolvedValue([
        { date: '2026-04-19', period: 'day_open', nav: 9400, recorded_at: NOW },
        { date: '2026-04-12', period: 'day_open', nav: 10000, recorded_at: NOW - 7 * DAY + 60_000 },
      ])
      ;(engineClient as any).haltEngine = vi.fn().mockResolvedValue({ status: 'halted' })

      await runTraderTick({ db, getEngineClient, send, sendWithKeyboard })

      // Abstain, sharpe, and NAV-drop alerts must all have fired even
      // though the Coinbase check threw.
      const messages = sendMock.mock.calls.map((c: unknown[]) => c[0] as string)
      expect(messages.some((m: string) => m.includes('abstained'))).toBe(true)
      expect(messages.some((m: string) => m.includes('Sharpe flip'))).toBe(true)
      expect(messages.some((m: string) => m.includes('NAV drop halt'))).toBe(true)
    })

    it('when getEngineClient throws, abstain + sharpe still run; coinbase + NAV silently skip', async () => {
      // Force the engine-client factory to throw so both network-dependent
      // checks should be skipped in a single pass.  abstain + sharpe do
      // not touch the engine at all and must still fire + send.  This
      // also pins that we resolve the client ONCE per tick (rework fix
      // from the Dispatch C code review -- previously there were two
      // separate resolve-and-null-check blocks, one for each network
      // check).
      getEngineClientMock.mockImplementation(() => {
        throw new Error('credentials not configured')
      })

      // Seed conditions so abstain + sharpe would both fire.
      for (let i = 0; i < 4; i++) insertAbstain(db, i)
      upsertTrack(db, 'momentum-stocks', 40, -0.4)
      db.prepare(`
        INSERT INTO trader_alert_state (alert_id, last_alerted_at)
        VALUES ('sharpe_last_sign:momentum-stocks', 1)
      `).run()

      // These would fire if the engine calls actually ran.  Spy them so
      // we can assert they never got invoked.
      const getHealthSpy = vi.fn().mockResolvedValue({ ...healthOk, coinbase_connected: false })
      const getNavSpy = vi.fn().mockResolvedValue([
        { date: '2026-04-19', period: 'day_open', nav: 9400, recorded_at: Date.now() },
        { date: '2026-04-12', period: 'day_open', nav: 10000, recorded_at: Date.now() - 7 * 24 * 60 * 60 * 1000 + 60_000 },
      ])
      const haltSpy = vi.fn().mockResolvedValue({ status: 'halted' })
      ;(engineClient as any).getHealth = getHealthSpy
      ;(engineClient as any).getNavSnapshots = getNavSpy
      ;(engineClient as any).haltEngine = haltSpy

      await runTraderTick({ db, getEngineClient, send, sendWithKeyboard })

      // Abstain + sharpe must have fired via deps.send.
      const messages = sendMock.mock.calls.map((c: unknown[]) => c[0] as string)
      expect(messages.some((m: string) => m.includes('abstained'))).toBe(true)
      expect(messages.some((m: string) => m.includes('Sharpe flip'))).toBe(true)

      // Coinbase + NAV must NOT have fired; no engine calls reached.
      expect(messages.some((m: string) => m.includes('Coinbase connection down'))).toBe(false)
      expect(messages.some((m: string) => m.includes('NAV drop halt'))).toBe(false)
      expect(getHealthSpy).not.toHaveBeenCalled()
      expect(getNavSpy).not.toHaveBeenCalled()
      expect(haltSpy).not.toHaveBeenCalled()
    })

    it('haltEngine failure emits a follow-up Telegram notice', async () => {
      const NOW = Date.now()
      const DAY = 24 * 60 * 60 * 1000
      vi.mocked(engineClient.getNavSnapshots = vi.fn() as any).mockResolvedValue([
        { date: '2026-04-19', period: 'day_open', nav: 9400, recorded_at: NOW },
        { date: '2026-04-12', period: 'day_open', nav: 10000, recorded_at: NOW - 7 * DAY + 60_000 },
      ])
      // Halt call throws.
      ;(engineClient as any).haltEngine = vi.fn().mockRejectedValue(new Error('engine 503'))

      await runTraderTick({ db, getEngineClient, send, sendWithKeyboard })

      // Two sends: the original NAV drop alert + the halt-failure follow-up.
      const navCalls = sendMock.mock.calls.filter(
        (args: unknown[]) => typeof args[0] === 'string' && (args[0] as string).includes('NAV drop halt'),
      )
      expect(navCalls.length).toBe(1)

      const followUpCalls = sendMock.mock.calls.filter(
        (args: unknown[]) =>
          typeof args[0] === 'string' &&
          (args[0] as string).includes('engine halt call failed'),
      )
      expect(followUpCalls.length).toBe(1)
    })
  })

  // Phase 6 Task 3 -- overlapping-tick concurrency guard.
  //
  // setInterval does not prevent tick overlap.  Two overlapping ticks
  // in the monitor phase can duplicate Telegram sends (halt itself is
  // idempotent engine-side).  The lock is a module-level boolean flag
  // set at the top of runTraderTick and cleared in a finally block.
  // A skipped tick returns a sentinel payload (all phase counters zero,
  // skipped=true) and MUST NOT touch any phase.
  describe('runTraderTick concurrency guard', () => {
    it('skips a second tick while the first is still running', async () => {
      // Block the first tick inside the signal-poll phase by making
      // getSignals hang until we release it.  The second tick fires
      // during that window and must return early with skipped=true.
      let releaseFirst: () => void = () => {}
      const firstBlocker = new Promise<void>((resolve) => {
        releaseFirst = resolve
      })

      vi.mocked(engineClient.getSignals!).mockImplementation(async () => {
        await firstBlocker
        return []
      })

      const firstPromise = runTraderTick({ db, getEngineClient, send, sendWithKeyboard })

      // Yield so the first tick enters its phases before we fire the second.
      await new Promise((resolve) => setImmediate(resolve))

      const secondResult = await runTraderTick({ db, getEngineClient, send, sendWithKeyboard })
      expect(secondResult.skipped).toBe(true)
      expect(secondResult.polled).toBe(false)
      expect(secondResult.sent).toBe(0)
      expect(secondResult.timedOut).toBe(0)
      expect(secondResult.reconcilerHalted).toBe(false)
      expect(secondResult.closedOut).toBe(0)
      expect(secondResult.weeklyReportFired).toBe(false)

      // Core guarantee of the lock: nothing touched the Telegram channel
      // for the skipped tick.  The first tick is still blocked on the
      // getSignals hang, so any Telegram activity here would have come
      // from the skipped second tick.
      expect(sendMock).not.toHaveBeenCalled()
      expect(sendWithKeyboardMock).not.toHaveBeenCalled()

      // Let the first tick finish cleanly.
      releaseFirst()
      const firstResult = await firstPromise
      expect(firstResult.polled).toBe(true)
      expect(firstResult.skipped).toBeFalsy()
    })

    it('allows a subsequent tick once the first has resolved', async () => {
      const first = await runTraderTick({ db, getEngineClient, send, sendWithKeyboard })
      expect(first.polled).toBe(true)
      expect(first.skipped).toBeFalsy()

      const second = await runTraderTick({ db, getEngineClient, send, sendWithKeyboard })
      expect(second.polled).toBe(true)
      expect(second.skipped).toBeFalsy()
    })

    it('runs a second tick cleanly after a tick where all phases errored', async () => {
      // Every phase inside runTraderTick is wrapped in its own
      // try/catch, so individual phase failures never propagate out of
      // the tick.  That means we cannot inject a real throw through the
      // outer try block without production-code changes, which are out
      // of scope for this test.  What we CAN assert is the weaker but
      // still meaningful guarantee: after a tick in which every phase's
      // underlying engine call rejected, a follow-up tick still
      // acquires the lock and runs normally.  The finally block in
      // runTraderTick is insurance against a future regression that
      // lets a throw escape a phase boundary.
      vi.mocked(engineClient.getSignals!).mockRejectedValue(new Error('poll boom'))
      vi.mocked(engineClient.getHealth!).mockRejectedValue(new Error('health boom'))

      const first = await runTraderTick({ db, getEngineClient, send, sendWithKeyboard })
      expect(first.skipped).toBeFalsy()

      // Restore a happy engine for the second tick.
      vi.mocked(engineClient.getSignals!).mockResolvedValue([])
      vi.mocked(engineClient.getHealth!).mockResolvedValue(healthOk)

      const second = await runTraderTick({ db, getEngineClient, send, sendWithKeyboard })
      expect(second.skipped).toBeFalsy()
      expect(second.polled).toBe(true)
    })

    it('logs info when a tick is skipped', async () => {
      const infoSpy = vi.spyOn(loggerModule.logger, 'info')

      let releaseFirst: () => void = () => {}
      const firstBlocker = new Promise<void>((resolve) => {
        releaseFirst = resolve
      })
      vi.mocked(engineClient.getSignals!).mockImplementation(async () => {
        await firstBlocker
        return []
      })

      const firstPromise = runTraderTick({ db, getEngineClient, send, sendWithKeyboard })
      await new Promise((resolve) => setImmediate(resolve))

      await runTraderTick({ db, getEngineClient, send, sendWithKeyboard })

      const skipLog = infoSpy.mock.calls.find((args: unknown[]) => {
        const message = typeof args[0] === 'string' ? args[0] : args[1]
        return typeof message === 'string' && message.includes('Trader tick skipped')
      })
      expect(skipLog).toBeDefined()

      releaseFirst()
      await firstPromise
      infoSpy.mockRestore()
    })
  })

  describe('initTraderScheduler', () => {
    it('runs an immediate tick on start', async () => {
      insertSignal(db, 'sig-1')
      initTraderScheduler({ db, getEngineClient, send, sendWithKeyboard, tickMs: 60_000 })
      await new Promise((resolve) => setTimeout(resolve, 10))
      expect(sendWithKeyboardMock).toHaveBeenCalledTimes(1)
    })

    it('does not start twice', async () => {
      initTraderScheduler({ db, getEngineClient, send, sendWithKeyboard, tickMs: 60_000 })
      const firstCount = getEngineClientMock.mock.calls.length

      initTraderScheduler({ db, getEngineClient, send, sendWithKeyboard, tickMs: 60_000 })
      await new Promise((resolve) => setTimeout(resolve, 10))

      // Each tick makes up to 6 getEngineClient() calls across its phases
      // (health check, signal poll, close-out sweep, weekly-report gate,
      // monitor coinbase check, monitor NAV drop check).  The second init
      // should be a no-op; we tolerate a small slack in case the first
      // tick's async chain finishes after firstCount is captured.  If a
      // second init did leak through we would see another full tick's
      // worth of calls (+6 or more).
      expect(getEngineClientMock.mock.calls.length).toBeLessThanOrEqual(firstCount + 5)
    })

    it('stopTraderScheduler halts future ticks', async () => {
      vi.useFakeTimers()
      initTraderScheduler({ db, getEngineClient, send, sendWithKeyboard, tickMs: 1000 })

      // The initial tick fires synchronously at the end of
      // initTraderScheduler and its runTraderTick awaits ~5 engine-
      // client phases back-to-back.  A single advanceTimersByTimeAsync(0)
      // flushes the timer queue plus one microtask batch, which does
      // not walk the full await chain: if we capture the count before
      // every phase has resolved, a later phase lands after the stop
      // call and the assertion trips ("expected 5 to be 4").  Spin on
      // a zero-time timer advance until the mock call count stops
      // moving so countAfterInitial includes every call this tick is
      // ever going to make.
      await vi.advanceTimersByTimeAsync(0)
      let prev = -1
      while (prev !== getEngineClientMock.mock.calls.length) {
        prev = getEngineClientMock.mock.calls.length
        await vi.advanceTimersByTimeAsync(0)
      }
      const countAfterInitial = getEngineClientMock.mock.calls.length

      stopTraderScheduler()
      // Advance well past several tick intervals and drain any residual
      // microtasks, then assert no further tick landed on top.
      await vi.advanceTimersByTimeAsync(5000)
      for (let i = 0; i < 20; i++) {
        await Promise.resolve()
      }

      expect(getEngineClientMock.mock.calls.length).toBe(countAfterInitial)
    })
  })
})
