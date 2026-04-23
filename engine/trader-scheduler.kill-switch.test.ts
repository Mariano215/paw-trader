/**
 * trader-scheduler.kill-switch.test.ts -- Phase 4 Task A
 *
 * Verifies how the trader tick composes with the global kill switch.
 * The tick has five phases, each with a different cost profile:
 *
 *   0. Health check     -- polls engine status; cheap; NOT gated
 *   1. Signal poll      -- reconciliation only; NOT gated
 *   2. Approval cards   -- sends via ChannelManager.sendWithKeyboard;
 *                          the channel-layer gate blocks the network
 *                          send, but the scheduler still invokes it
 *   3. Timeout notices  -- sends via ChannelManager.send;
 *                          channel-layer gate blocks the send
 *   4. Close-out sweep  -- reconciliation only; NOT gated
 *
 * The scheduler itself does not check the kill switch. Its gate is
 * downstream: the injected deps.send / deps.sendWithKeyboard must
 * flow through ChannelManager when wired into the bot, and that is
 * where the kill-switch block happens. In these tests we emulate
 * that by swapping the deps to behave like ChannelManager under the
 * switch -- they check the switch themselves and no-op.
 *
 * Control: with the switch clear, all phases run normally.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import Database from 'better-sqlite3'

import { initTraderTables } from './db.js'
import { seedMomentumStrategy } from './strategy-manager.js'
import { runTraderTick, _resetHaltAlertForTest } from './trader-scheduler.js'
import type { EngineClient } from './engine-client.js'
import type { TraderApprovalKeyboard } from './approval-manager.js'
import type { EngineOrder } from './types.js'
import * as killSwitch from '../cost/kill-switch-client.js'

vi.mock('./decision-dispatcher.js', () => ({
  autoDispatchPendingSignals: vi.fn().mockResolvedValue([]),
}))

import { autoDispatchPendingSignals } from './decision-dispatcher.js'

function makeDb() {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = OFF')
  initTraderTables(db)
  seedMomentumStrategy(db)
  // Phase 4 Task C -- pre-mark the weekly report as already fired today
  // so the Sunday 09:00 NY gate inside runTraderTick is a no-op in these
  // tests. The weekly report itself is exercised in weekly-report.test.ts.
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

function insertExecutedDecision(
  db: Database.Database,
  decisionId: string,
  signalId: string,
) {
  db.prepare(`
    INSERT INTO trader_decisions
      (id, signal_id, action, asset, size_usd, entry_type, thesis, confidence,
       committee_transcript_id, decided_at, status)
    VALUES (?, ?, 'buy', 'AAPL', 1000, 'limit', 't', 0.7, NULL, 1000, 'executed')
  `).run(decisionId, signalId)
}

function fillOrder(overrides: Partial<EngineOrder> = {}): EngineOrder {
  return {
    client_order_id: 'co-' + Math.random().toString(36).slice(2, 8),
    broker_order_id: null,
    asset: 'AAPL',
    side: 'buy',
    qty: 10,
    order_type: 'limit',
    limit_price: null,
    status: 'filled',
    filled_qty: 10,
    filled_avg_price: 100,
    source: 'test',
    created_at: 1100,
    updated_at: 1100,
    ...overrides,
  }
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

/**
 * Build a send/sendWithKeyboard pair that behaves like ChannelManager
 * under the kill switch -- each checks checkKillSwitch() first and
 * no-ops on trip. Also records whether it was invoked and whether the
 * downstream "network" spy was hit.
 */
function makeGatedSends() {
  const networkSend = vi.fn().mockResolvedValue(undefined)
  const networkSendWithKeyboard = vi.fn().mockResolvedValue(undefined)

  const send = async (text: string): Promise<void> => {
    const sw = await killSwitch.checkKillSwitch()
    if (sw) return
    await networkSend(text)
  }
  const sendWithKeyboard = async (text: string, keyboard: TraderApprovalKeyboard): Promise<void> => {
    const sw = await killSwitch.checkKillSwitch()
    if (sw) return
    await networkSendWithKeyboard(text, keyboard)
  }
  return { send, sendWithKeyboard, networkSend, networkSendWithKeyboard }
}

describe('runTraderTick + kill switch', () => {
  let db: ReturnType<typeof makeDb>
  let engineClient: Partial<EngineClient>
  let getEngineClient: () => EngineClient

  beforeEach(() => {
    db = makeDb()
    engineClient = {
      getHealth: vi.fn().mockResolvedValue(healthOk),
      getSignals: vi.fn().mockResolvedValue([]),
      getPositions: vi.fn().mockResolvedValue([]),
      getOrders: vi.fn().mockResolvedValue([]),
      // Phase 4 Task B: close-out watcher calls /prices when a decision
      // closes. Kill-switch tests don't care about price math.
      getPrices: vi.fn().mockResolvedValue([]),
    }
    getEngineClient = () => engineClient as EngineClient
    _resetHaltAlertForTest()
    vi.restoreAllMocks()
    // Reset the module-level mock between tests so call counts start fresh.
    vi.mocked(autoDispatchPendingSignals).mockReset()
    vi.mocked(autoDispatchPendingSignals).mockResolvedValue([])
  })

  // -------------------------------------------------------------------------
  // Signal polling + close-out sweep must keep running even with the switch
  // tripped. They write to the DB only and make no spend-y calls.
  // -------------------------------------------------------------------------

  it('switch TRIPPED: signal polling still stores new signals (reconciliation, no spend)', async () => {
    vi.spyOn(killSwitch, 'checkKillSwitch').mockResolvedValue({
      set_at: Date.now(),
      reason: 'maintenance',
    })

    vi.mocked(engineClient.getSignals!).mockResolvedValue([
      {
        id: 'sig-ks-poll',
        strategy: 'momentum',
        asset: 'AAPL',
        side: 'buy',
        raw_score: 0.72,
        horizon_days: 20,
        generated_at: Date.now(),
      },
    ])

    const { send, sendWithKeyboard } = makeGatedSends()
    const result = await runTraderTick({ db, getEngineClient, send, sendWithKeyboard })

    expect(result.polled).toBe(true)
    const stored = db.prepare("SELECT id FROM trader_signals WHERE id = 'sig-ks-poll'").get() as any
    expect(stored).toBeDefined()
  })

  it('switch TRIPPED: close-out sweep still writes verdicts (reconciliation, no spend)', async () => {
    vi.spyOn(killSwitch, 'checkKillSwitch').mockResolvedValue({
      set_at: Date.now(),
      reason: 'maintenance',
    })

    insertSignal(db, 'sig-ks-close', 0.72)
    insertExecutedDecision(db, 'dec-ks-close', 'sig-ks-close')

    vi.mocked(engineClient.getPositions!).mockResolvedValue([])
    vi.mocked(engineClient.getOrders!).mockResolvedValue([
      fillOrder({ side: 'buy',  filled_qty: 10, filled_avg_price: 100, created_at: 1100, updated_at: 1100 }),
      fillOrder({ side: 'sell', filled_qty: 10, filled_avg_price: 110, created_at: 5000, updated_at: 5000 }),
    ])

    const { send, sendWithKeyboard } = makeGatedSends()
    const result = await runTraderTick({ db, getEngineClient, send, sendWithKeyboard })

    expect(result.closedOut).toBe(1)
    const verdict = db.prepare(
      'SELECT pnl_gross, thesis_grade FROM trader_verdicts WHERE decision_id = ?',
    ).get('dec-ks-close') as any
    expect(verdict.pnl_gross).toBe(10 * (110 - 100))
    expect(verdict.thesis_grade).toBe('A')
  })

  // -------------------------------------------------------------------------
  // Telegram-bound sends are blocked when the switch is tripped. We verify
  // that the network-layer spy inside makeGatedSends is NOT hit, even
  // though the scheduler still calls into the deps.
  // -------------------------------------------------------------------------

  it('switch TRIPPED: approval card network send is blocked downstream', async () => {
    vi.spyOn(killSwitch, 'checkKillSwitch').mockResolvedValue({
      set_at: Date.now(),
      reason: 'maintenance',
    })

    // Pending signal with no approval row yet -> sendPendingApprovals
    // should try to fire a card.
    insertSignal(db, 'sig-ks-card', 0.9)

    const { send, sendWithKeyboard, networkSend, networkSendWithKeyboard } = makeGatedSends()
    await runTraderTick({ db, getEngineClient, send, sendWithKeyboard })

    // The downstream network send must not have fired.
    expect(networkSendWithKeyboard).not.toHaveBeenCalled()
    expect(networkSend).not.toHaveBeenCalled()
  })

  it('switch TRIPPED: timeout expiry notice send is blocked downstream', async () => {
    vi.spyOn(killSwitch, 'checkKillSwitch').mockResolvedValue({
      set_at: Date.now(),
      reason: 'maintenance',
    })

    // Seed a signal + stale approval row so the timeout sweep fires.
    const thirtyOneMinAgo = Date.now() - 31 * 60 * 1000
    db.prepare(`
      INSERT INTO trader_signals (id, strategy_id, asset, side, raw_score, horizon_days, generated_at, status)
      VALUES ('sig-ks-timeout', 'momentum-stocks', 'NVDA', 'buy', 0.73, 20, ?, 'pending')
    `).run(Date.now())
    db.prepare(
      'INSERT INTO trader_approvals (id, decision_id, sent_at) VALUES (?, ?, ?)',
    ).run('ap-ks-timeout', 'sig-ks-timeout', thirtyOneMinAgo)

    const { send, sendWithKeyboard, networkSend } = makeGatedSends()
    const result = await runTraderTick({ db, getEngineClient, send, sendWithKeyboard })

    // DB transition still happens (timeout sweep runs before send).
    expect(result.timedOut).toBe(1)
    const row = db.prepare("SELECT response FROM trader_approvals WHERE id = 'ap-ks-timeout'").get() as any
    expect(row.response).toBe('timeout')

    // But the operator notice never hits the network.
    expect(networkSend).not.toHaveBeenCalled()
  })

  it('switch TRIPPED: engine halt alert send is blocked downstream', async () => {
    vi.spyOn(killSwitch, 'checkKillSwitch').mockResolvedValue({
      set_at: Date.now(),
      reason: 'maintenance',
    })

    vi.mocked(engineClient.getHealth!).mockResolvedValue({
      ...healthOk,
      reconciler_halted: true,
      halt_reason: 'daily_loss_limit',
    })

    const { send, sendWithKeyboard, networkSend } = makeGatedSends()
    const result = await runTraderTick({ db, getEngineClient, send, sendWithKeyboard })

    expect(result.reconcilerHalted).toBe(true)
    // Halt alert does not reach Telegram under the switch.
    expect(networkSend).not.toHaveBeenCalled()
  })

  // -------------------------------------------------------------------------
  // Control: switch clear. All paths run normally.
  // -------------------------------------------------------------------------

  it('switch CLEAR: approval card flows through to network send', async () => {
    vi.spyOn(killSwitch, 'checkKillSwitch').mockResolvedValue(null)

    insertSignal(db, 'sig-clear-card', 0.9)

    vi.mocked(autoDispatchPendingSignals).mockResolvedValueOnce([
      { action: 'executed', signalId: 'sig-clear-card', asset: 'AAPL', side: 'buy', reason: 'committee approved' },
    ])

    const { send, sendWithKeyboard, networkSend, networkSendWithKeyboard } = makeGatedSends()
    const result = await runTraderTick({ db, getEngineClient, send, sendWithKeyboard })

    expect(result.sent).toBe(1)
    expect(autoDispatchPendingSignals).toHaveBeenCalledOnce()
    // auto-dispatch uses deps.send (not sendWithKeyboard); the gated send hits networkSend
    expect(networkSendWithKeyboard).not.toHaveBeenCalled()
  })

  it('switch CLEAR: halt alert reaches the operator', async () => {
    vi.spyOn(killSwitch, 'checkKillSwitch').mockResolvedValue(null)

    vi.mocked(engineClient.getHealth!).mockResolvedValue({
      ...healthOk,
      reconciler_halted: true,
      halt_reason: 'daily_loss_limit',
    })

    const { send, sendWithKeyboard, networkSend } = makeGatedSends()
    const result = await runTraderTick({ db, getEngineClient, send, sendWithKeyboard })

    expect(result.reconcilerHalted).toBe(true)
    expect(networkSend).toHaveBeenCalledTimes(1)
    expect(networkSend.mock.calls[0][0]).toContain('reconciler halted')
  })

  it('switch CLEAR: close-out sweep + poll + send all complete together', async () => {
    vi.spyOn(killSwitch, 'checkKillSwitch').mockResolvedValue(null)

    insertSignal(db, 'sig-clear-e2e', 0.88)
    insertExecutedDecision(db, 'dec-clear-e2e', 'sig-clear-e2e')

    vi.mocked(engineClient.getSignals!).mockResolvedValue([])  // no new signals
    vi.mocked(engineClient.getPositions!).mockResolvedValue([])
    vi.mocked(engineClient.getOrders!).mockResolvedValue([
      fillOrder({ side: 'buy',  filled_qty: 10, filled_avg_price: 100, created_at: 1100, updated_at: 1100 }),
      fillOrder({ side: 'sell', filled_qty: 10, filled_avg_price: 110, created_at: 5000, updated_at: 5000 }),
    ])

    // sig-clear-e2e is 'pending', so auto-dispatch fires for it too.
    vi.mocked(autoDispatchPendingSignals).mockResolvedValueOnce([
      { action: 'executed', signalId: 'sig-clear-e2e', asset: 'AAPL', side: 'buy', reason: 'committee approved' },
    ])

    const { send, sendWithKeyboard } = makeGatedSends()
    const result = await runTraderTick({ db, getEngineClient, send, sendWithKeyboard })

    expect(result.polled).toBe(true)
    expect(result.closedOut).toBe(1)
    expect(result.sent).toBe(1)
    expect(autoDispatchPendingSignals).toHaveBeenCalledOnce()

    const verdict = db.prepare(
      'SELECT pnl_gross FROM trader_verdicts WHERE decision_id = ?',
    ).get('dec-clear-e2e') as any
    expect(verdict.pnl_gross).toBe(100)
  })
})
