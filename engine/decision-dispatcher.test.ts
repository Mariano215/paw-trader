import { describe, it, expect, beforeEach, vi } from 'vitest'

// Mock config to disable bypass for tests that exercise the committee path.
// Bypass-gates tests live in decision-dispatcher.bypass.test.ts with their own mock.
vi.mock('../config.js', async () => {
  const actual = await vi.importActual<typeof import('../config.js')>('../config.js')
  return {
    ...actual,
    TRADER_COMMITTEE_BYPASS: false,
    TRADER_BYPASS_TRADE_TARGET: 20,
    TRADER_DAILY_TRADE_CAP: 20,
  }
})

import Database from 'better-sqlite3'
import { initTraderTables } from './db.js'
import { seedMomentumStrategy } from './strategy-manager.js'
import { dispatchApproval, autoDispatchPendingSignals } from './decision-dispatcher.js'
import { HARD_CEILING_USD } from './trader-constants.js'
import type { EngineClient } from './engine-client.js'
import type { CommitteeResult, CommitteeSignalInput } from './committee.js'
import type { LadderResult } from './autonomy-ladder.js'

function makeDb() {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = OFF')
  initTraderTables(db)
  seedMomentumStrategy(db)
  return db
}

function insertSignal(db: Database.Database): string {
  const id = 'sig-dispatch-1'
  db.prepare(`
    INSERT INTO trader_signals (id, strategy_id, asset, side, raw_score, horizon_days, generated_at, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, 'momentum-stocks', 'AAPL', 'buy', 0.72, 20, Date.now(), 'committee')
  return id
}

/**
 * Default-tier stub: tier-1 with full scale. Existing dispatcher tests
 * rely on the committee's chosen size making it through unchanged; the
 * autonomy ladder adds scaling that would otherwise break those size
 * assertions. Phase 3 Task 5 adds dedicated ladder tests that exercise
 * cold-start + tier-0 paths explicitly.
 */
const tier1: LadderResult = { tier: 'tier-1', scale: 1.0, reason: 'test default' }
const tierStub = (): LadderResult => tier1

/** Stub committee returning a high-confidence approve result. */
function makeApproveCommittee(sizeUsd = 150): (s: CommitteeSignalInput) => Promise<CommitteeResult> {
  return async (s) => ({
    decision: 'approve',
    action: s.side,
    thesis: 'Stub approve: strong momentum + risk clear.',
    confidence: 0.78,
    size_usd: sizeUsd,
    transcript_id: 'tr-test-approve',
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
}

function makeAbstainCommittee(reason = 'Risk officer veto: late-cycle crowded trade.') {
  return async (s: CommitteeSignalInput): Promise<CommitteeResult> => ({
    decision: 'abstain',
    action: null,
    thesis: reason,
    confidence: 0,
    size_usd: 0,
    transcript_id: 'tr-test-abstain',
    transcript: {
      signal_id: s.id,
      started_at: Date.now(),
      finished_at: Date.now(),
      rounds_executed: 1,
      round_1: [],
      risk_officer: { role: 'risk_officer', veto: true, reason, concerns: [] },
      trader: { role: 'trader', action: 'abstain', thesis: reason, confidence: 0, size_multiplier: 0 },
      errors: [],
    },
  })
}

describe('decision-dispatcher', () => {
  let db: ReturnType<typeof makeDb>
  let mockClient: Partial<EngineClient>

  beforeEach(() => {
    db = makeDb()
    // Phase 5 Task 1 -- per-strategy live cap. Default getNav to null
    // so pre-existing tests fall back to DEFAULT_SIZE_USD (200) as
    // their cap. Cap tests override getNav explicitly to exercise
    // the NAV fallback and $1000 hard ceiling paths.
    mockClient = {
      submitDecision: vi.fn(),
      getRiskState: vi.fn(),
      getNav: vi.fn().mockResolvedValue(null),
      // Default: no open positions, so the cluster gate is a no-op for all
      // existing tests that don't exercise cluster-cap suppression.
      getPositions: vi.fn().mockResolvedValue([]),
    }
  })

  it('dispatches APPROVE to engine and stores trader_decisions row (committee approve path)', async () => {
    const signalId = insertSignal(db)
    vi.mocked(mockClient.submitDecision!).mockResolvedValue({
      client_order_id: 'coid-1', broker_order_id: 'boid-1', status: 'placed', approved_size_usd: 150,
    })
    const msg = await dispatchApproval(
      db,
      { action: 'approve', approvalId: 'ap-1', decisionId: signalId },
      mockClient as EngineClient,
      { runCommittee: makeApproveCommittee(150), classifyTier: tierStub },
    )
    expect(msg).toContain('placed')
    const row = db.prepare("SELECT * FROM trader_decisions WHERE signal_id = ?").get(signalId) as any
    expect(row).not.toBeNull()
    expect(row.status).toBe('submitted')
    expect(row.thesis).toContain('Stub approve')
    expect(row.committee_transcript_id).toBe('tr-test-approve')
  })

  it('auto-dispatch lands a submitted (not executed) decision after engine ACK', async () => {
    db.prepare(`
      INSERT INTO trader_signals (id, strategy_id, asset, side, raw_score, horizon_days, generated_at, status)
      VALUES ('sig-auto-1', 'momentum-stocks', 'MSFT', 'buy', 0.7, 20, ?, 'pending')
    `).run(Date.now())
    vi.mocked(mockClient.submitDecision!).mockResolvedValue({
      client_order_id: 'coid-9', broker_order_id: 'boid-9', status: 'placed', approved_size_usd: 150,
    })
    await autoDispatchPendingSignals(
      db,
      { send: async () => {}, runCommittee: makeApproveCommittee(150) },
      mockClient as EngineClient,
    )
    const row = db.prepare("SELECT status, engine_order_id FROM trader_decisions WHERE signal_id = 'sig-auto-1'").get() as any
    expect(row.status).toBe('submitted')
    expect(row.engine_order_id).toBe('boid-9')
  })

  it('passes committee-sized amount to the engine (not Phase-1 default) when committee returns size_usd', async () => {
    const signalId = insertSignal(db)
    vi.mocked(mockClient.submitDecision!).mockResolvedValue({
      client_order_id: 'coid-2', broker_order_id: 'boid-2', status: 'placed', approved_size_usd: 150,
    })
    await dispatchApproval(
      db,
      { action: 'approve', approvalId: 'ap-1', decisionId: signalId },
      mockClient as EngineClient,
      { runCommittee: makeApproveCommittee(150), classifyTier: tierStub },
    )
    const submitCall = vi.mocked(mockClient.submitDecision!).mock.calls[0][0]
    expect(submitCall.size_usd).toBe(150)
    expect(submitCall.confidence).toBe(0.78)
  })

  it('records committee_abstain decision and does not call engine when committee abstains', async () => {
    const signalId = insertSignal(db)
    const msg = await dispatchApproval(
      db,
      { action: 'approve', approvalId: 'ap-1', decisionId: signalId },
      mockClient as EngineClient,
      { runCommittee: makeAbstainCommittee('Risk veto: pending earnings.') },
    )
    expect(msg).toContain('abstained')
    expect(mockClient.submitDecision).not.toHaveBeenCalled()
    const row = db.prepare("SELECT * FROM trader_decisions WHERE signal_id = ?").get(signalId) as any
    expect(row.status).toBe('committee_abstain')
    expect(row.size_usd).toBe(0)
    expect(row.committee_transcript_id).toBe('tr-test-abstain')
    const suppression = db.prepare(`
      SELECT reason FROM trader_signal_suppressions
      WHERE strategy_id = 'momentum-stocks' AND asset = 'AAPL' AND side = 'buy'
    `).get() as any
    expect(suppression.reason).toBe('committee_abstain')
  })

  it('persists committee transcript for both approve and abstain paths', async () => {
    const signalId = insertSignal(db)
    vi.mocked(mockClient.submitDecision!).mockResolvedValue({
      client_order_id: 'coid-3', broker_order_id: 'boid-3', status: 'placed', approved_size_usd: 150,
    })
    await dispatchApproval(
      db,
      { action: 'approve', approvalId: 'ap-a', decisionId: signalId },
      mockClient as EngineClient,
      { runCommittee: makeApproveCommittee(150), classifyTier: tierStub },
    )
    const row = db.prepare("SELECT id, signal_id, rounds FROM trader_committee_transcripts WHERE id = 'tr-test-approve'").get() as any
    expect(row).not.toBeNull()
    expect(row.signal_id).toBe(signalId)
    expect(row.rounds).toBe(1)
  })

  it('returns skip confirmation without calling committee or engine', async () => {
    const committeeStub = vi.fn()
    const msg = await dispatchApproval(
      db,
      { action: 'skip', approvalId: 'ap-1', decisionId: 'sig-x' },
      mockClient as EngineClient,
      { runCommittee: committeeStub as any },
    )
    expect(msg).toContain('Skipped')
    expect(mockClient.submitDecision).not.toHaveBeenCalled()
    expect(committeeStub).not.toHaveBeenCalled()
  })

  it('pauses the correct strategy (dynamic, not hardcoded)', async () => {
    const signalId = insertSignal(db)
    const msg = await dispatchApproval(
      db,
      { action: 'pause', approvalId: 'ap-1', decisionId: signalId },
      mockClient as EngineClient,
      { runCommittee: vi.fn() as any },
    )
    const strat = db.prepare("SELECT status FROM trader_strategies WHERE id='momentum-stocks'").get() as any
    expect(strat.status).toBe('paused')
    expect(msg).toContain('momentum-stocks')
  })

  it('does not pause an unrelated strategy', async () => {
    db.prepare(`
      INSERT INTO trader_strategies (id, name, asset_class, tier, status, params_json, created_at, updated_at)
      VALUES ('other-strategy', 'Other', 'equity', 0, 'active', '{}', ?, ?)
    `).run(Date.now(), Date.now())
    const signalId = insertSignal(db)
    await dispatchApproval(
      db,
      { action: 'pause', approvalId: 'ap-1', decisionId: signalId },
      mockClient as EngineClient,
      { runCommittee: vi.fn() as any },
    )
    const other = db.prepare("SELECT status FROM trader_strategies WHERE id='other-strategy'").get() as any
    expect(other.status).toBe('active')
  })

  it('handles engine rejection gracefully (after committee approve)', async () => {
    insertSignal(db)
    vi.mocked(mockClient.submitDecision!).mockRejectedValue(new Error('422 blocked_by: daily_loss'))
    const msg = await dispatchApproval(
      db,
      { action: 'approve', approvalId: 'ap-1', decisionId: 'sig-dispatch-1' },
      mockClient as EngineClient,
      { runCommittee: makeApproveCommittee(150), classifyTier: tierStub },
    )
    expect(msg).toContain('blocked')
  })

  it('returns committee-failure message when runCommittee throws', async () => {
    const signalId = insertSignal(db)
    const failing = async (): Promise<CommitteeResult> => { throw new Error('committee boom') }
    const msg = await dispatchApproval(
      db,
      { action: 'approve', approvalId: 'ap-1', decisionId: signalId },
      mockClient as EngineClient,
      { runCommittee: failing },
    )
    expect(msg).toContain('Committee run failed')
    expect(mockClient.submitDecision).not.toHaveBeenCalled()
  })

  // -------------------------------------------------------------------------
  // Phase 3 Task 5 -- Autonomy ladder integration in dispatcher.
  // -------------------------------------------------------------------------

  it('cold-start ladder scales committee size to 25%', async () => {
    const signalId = insertSignal(db)
    vi.mocked(mockClient.submitDecision!).mockResolvedValue({
      client_order_id: 'coid-cs', broker_order_id: 'boid-cs', status: 'placed', approved_size_usd: 25,
    })
    await dispatchApproval(
      db,
      { action: 'approve', approvalId: 'ap-1', decisionId: signalId },
      mockClient as EngineClient,
      {
        runCommittee: makeApproveCommittee(100),
        classifyTier: () => ({ tier: 'cold-start', scale: 0.25, reason: 'cold start (3 of 30 trades)' }),
      },
    )
    const submitCall = vi.mocked(mockClient.submitDecision!).mock.calls[0][0]
    expect(submitCall.size_usd).toBe(25)
  })

  it('tier-0 ladder scales committee size to 50%', async () => {
    const signalId = insertSignal(db)
    vi.mocked(mockClient.submitDecision!).mockResolvedValue({
      client_order_id: 'coid-t0', broker_order_id: 'boid-t0', status: 'placed', approved_size_usd: 100,
    })
    await dispatchApproval(
      db,
      { action: 'approve', approvalId: 'ap-1', decisionId: signalId },
      mockClient as EngineClient,
      {
        runCommittee: makeApproveCommittee(200),
        classifyTier: () => ({ tier: 'tier-0', scale: 0.5, reason: 'tier 0: drawdown breach' }),
      },
    )
    const submitCall = vi.mocked(mockClient.submitDecision!).mock.calls[0][0]
    expect(submitCall.size_usd).toBe(100)
  })

  it('tier-1 ladder passes committee size through unchanged', async () => {
    const signalId = insertSignal(db)
    vi.mocked(mockClient.submitDecision!).mockResolvedValue({
      client_order_id: 'coid-t1', broker_order_id: 'boid-t1', status: 'placed', approved_size_usd: 150,
    })
    await dispatchApproval(
      db,
      { action: 'approve', approvalId: 'ap-1', decisionId: signalId },
      mockClient as EngineClient,
      {
        runCommittee: makeApproveCommittee(150),
        classifyTier: tierStub,
      },
    )
    const submitCall = vi.mocked(mockClient.submitDecision!).mock.calls[0][0]
    expect(submitCall.size_usd).toBe(150)
  })

  it('uses default-size when committee returns 0 and ladder still applies', async () => {
    const signalId = insertSignal(db)
    vi.mocked(mockClient.submitDecision!).mockResolvedValue({
      client_order_id: 'coid-d', broker_order_id: 'boid-d', status: 'placed', approved_size_usd: 50,
    })
    // Committee returns size_usd=0 -> dispatcher falls back to DEFAULT_SIZE_USD ($200)
    // -> ladder cold-start scales to $50 (200 * 0.25).
    await dispatchApproval(
      db,
      { action: 'approve', approvalId: 'ap-1', decisionId: signalId },
      mockClient as EngineClient,
      {
        runCommittee: makeApproveCommittee(0),
        classifyTier: () => ({ tier: 'cold-start', scale: 0.25, reason: 'cold start' }),
      },
    )
    const submitCall = vi.mocked(mockClient.submitDecision!).mock.calls[0][0]
    expect(submitCall.size_usd).toBe(50)
  })

  it('falls back to live classifyStrategyTier when no stub provided (cold-start by default)', async () => {
    const signalId = insertSignal(db)
    vi.mocked(mockClient.submitDecision!).mockResolvedValue({
      client_order_id: 'coid-live', broker_order_id: 'boid-live', status: 'placed', approved_size_usd: 25,
    })
    // No track record seeded -> live classifier returns cold-start, scale 0.25.
    // Committee size 100 * 0.25 = 25.
    await dispatchApproval(
      db,
      { action: 'approve', approvalId: 'ap-1', decisionId: signalId },
      mockClient as EngineClient,
      { runCommittee: makeApproveCommittee(100) },
    )
    const submitCall = vi.mocked(mockClient.submitDecision!).mock.calls[0][0]
    expect(submitCall.size_usd).toBe(25)
  })

  // -------------------------------------------------------------------------
  // Phase 5 Task 1 -- per-strategy live cap.
  // Three cap sources, checked in priority order:
  //   1. trader_strategies.max_size_usd (explicit per-strategy ceiling)
  //   2. NAV * 2% risk multiplier (default when column is NULL)
  //   3. $1000 hard ceiling (applied on top of either of the above)
  // -------------------------------------------------------------------------

  it('clamps size to max_size_usd when the strategy has an explicit cap', async () => {
    const signalId = insertSignal(db)
    // Set explicit cap below the committee's requested 300 so the clamp is visible.
    db.prepare("UPDATE trader_strategies SET max_size_usd = ? WHERE id = 'momentum-stocks'").run(150)
    // The per-strategy cap path skips getNav for sizing. The cluster gate still
    // calls getNav (returns null -> cluster gate is a no-op pass), so we mock it.
    mockClient.getNav = vi.fn().mockResolvedValue(null)
    vi.mocked(mockClient.submitDecision!).mockResolvedValue({
      client_order_id: 'coid-cap', broker_order_id: 'boid-cap', status: 'placed', approved_size_usd: 150,
    })
    await dispatchApproval(
      db,
      { action: 'approve', approvalId: 'ap-1', decisionId: signalId },
      mockClient as EngineClient,
      { runCommittee: makeApproveCommittee(300), classifyTier: tierStub },
    )
    const submitCall = vi.mocked(mockClient.submitDecision!).mock.calls[0][0]
    expect(submitCall.size_usd).toBe(150)
  })

  it('falls back to NAV * 2% when max_size_usd is NULL', async () => {
    const signalId = insertSignal(db)
    // Strategy has no explicit cap -- momentum-stocks seeded without max_size_usd.
    mockClient.getNav = vi.fn().mockResolvedValue(10_000)  // 10k NAV -> 200 cap
    vi.mocked(mockClient.submitDecision!).mockResolvedValue({
      client_order_id: 'coid-nav', broker_order_id: 'boid-nav', status: 'placed', approved_size_usd: 200,
    })
    await dispatchApproval(
      db,
      { action: 'approve', approvalId: 'ap-1', decisionId: signalId },
      mockClient as EngineClient,
      { runCommittee: makeApproveCommittee(500), classifyTier: tierStub },
    )
    const submitCall = vi.mocked(mockClient.submitDecision!).mock.calls[0][0]
    expect(submitCall.size_usd).toBe(200)
    expect(mockClient.getNav).toHaveBeenCalled()
  })

  it('honors the HARD_CEILING_USD hard ceiling even when NAV * 2% would allow more', async () => {
    const signalId = insertSignal(db)
    // NAV 1M * 2% = 20_000, but the hard ceiling clamps to HARD_CEILING_USD.
    mockClient.getNav = vi.fn().mockResolvedValue(1_000_000)
    vi.mocked(mockClient.submitDecision!).mockResolvedValue({
      client_order_id: 'coid-ceil', broker_order_id: 'boid-ceil', status: 'placed', approved_size_usd: HARD_CEILING_USD,
    })
    await dispatchApproval(
      db,
      { action: 'approve', approvalId: 'ap-1', decisionId: signalId },
      mockClient as EngineClient,
      { runCommittee: makeApproveCommittee(HARD_CEILING_USD * 5), classifyTier: tierStub },
    )
    const submitCall = vi.mocked(mockClient.submitDecision!).mock.calls[0][0]
    expect(submitCall.size_usd).toBe(HARD_CEILING_USD)
  })

  it('treats max_size_usd = 0 as "cap disabled" and falls through to the NAV path', async () => {
    // Footgun guard: if an operator zeros the column to reset it, the
    // dispatcher must not submit a $0 order. Behavior should match the
    // NULL case exactly -- NAV * 2% fallback kicks in.
    const signalId = insertSignal(db)
    db.prepare("UPDATE trader_strategies SET max_size_usd = 0 WHERE id = 'momentum-stocks'").run()
    mockClient.getNav = vi.fn().mockResolvedValue(10_000)  // 10k NAV -> 200 cap
    vi.mocked(mockClient.submitDecision!).mockResolvedValue({
      client_order_id: 'coid-zero', broker_order_id: 'boid-zero', status: 'placed', approved_size_usd: 200,
    })
    await dispatchApproval(
      db,
      { action: 'approve', approvalId: 'ap-1', decisionId: signalId },
      mockClient as EngineClient,
      { runCommittee: makeApproveCommittee(500), classifyTier: tierStub },
    )
    const submitCall = vi.mocked(mockClient.submitDecision!).mock.calls[0][0]
    expect(submitCall.size_usd).toBe(200)
    // getNav must be consulted -- zero means "no explicit cap", not "cap at zero"
    expect(mockClient.getNav).toHaveBeenCalled()
  })

  it('attaches exits to the manual-approval payload and decision row', async () => {
    // M2: use a clearly distinct signal id; dispatchApproval's parsed.decisionId
    // is the signal id looked up in trader_signals, not a trader_decisions.id.
    const signalId = 'sig-me-exit'
    db.prepare(`
      INSERT INTO trader_signals (id, strategy_id, asset, side, raw_score, horizon_days, enrichment_json, generated_at, status)
      VALUES (?, 'momentum-stocks','AAPL','buy',0.72,20,?, ?,'committee')
    `).run(signalId, JSON.stringify({ price_current: 100, window_high: 120, window_low: 80 }), Date.now())
    vi.mocked(mockClient.submitDecision!).mockResolvedValue({
      client_order_id: 'coid-me', broker_order_id: 'boid-me', status: 'placed', approved_size_usd: 150,
    })
    await dispatchApproval(
      db,
      { action: 'approve', approvalId: 'ap-exits-manual', decisionId: signalId },
      mockClient as EngineClient,
      { runCommittee: makeApproveCommittee(150), classifyTier: tierStub },
    )
    const payload = vi.mocked(mockClient.submitDecision!).mock.calls[0][0]
    expect(payload.entry_price).toBe(100)
    expect(payload.stop_loss).toBeCloseTo(80, 5)
    expect(payload.take_profit).toBeCloseTo(140, 5)
    const row = db.prepare('SELECT entry_price, stop_loss, take_profit FROM trader_decisions WHERE signal_id=?').get(signalId) as any
    expect(row.entry_price).toBe(100)
    expect(row.stop_loss).toBeCloseTo(80, 5)
    expect(row.take_profit).toBeCloseTo(140, 5)
  })
})

// ---------------------------------------------------------------------------
// autoDispatchPendingSignals
// ---------------------------------------------------------------------------

describe('autoDispatchPendingSignals', () => {
  let testDb: Database.Database

  beforeEach(() => {
    testDb = new Database(':memory:')
    testDb.pragma('foreign_keys = OFF')
    initTraderTables(testDb)
  })

  it('marks signal suppressed_committee_abstain when committee abstains', async () => {
    testDb.prepare(`INSERT OR IGNORE INTO trader_strategies
      (id, name, asset_class, tier, status, params_json, created_at, updated_at)
      VALUES ('momentum-stocks','Momentum','stocks',1,'active','{}',?,?)`).run(Date.now(), Date.now())
    testDb.prepare(`INSERT INTO trader_signals
      (id, strategy_id, asset, side, raw_score, horizon_days, generated_at, status)
      VALUES ('auto-s1','momentum-stocks','AAPL','buy',0.8,3,?,'pending')`).run(Date.now())

    const send = vi.fn().mockResolvedValue(undefined)
    const stubCommittee = vi.fn().mockResolvedValue({
      decision: 'abstain', action: null, thesis: 'low conviction', confidence: 0, size_usd: 0,
      transcript_id: 'tc-auto-1',
      transcript: {
        signal_id: 'auto-s1', started_at: Date.now(), finished_at: Date.now(), rounds_executed: 1,
        round_1: [], risk_officer: { role: 'risk_officer', veto: true, reason: 'low conviction', concerns: [] },
        trader: { role: 'trader', action: 'abstain', thesis: 'low conviction', confidence: 0, size_multiplier: 0 },
        errors: [],
      },
    })
    await autoDispatchPendingSignals(testDb, { send, runCommittee: stubCommittee })
    const row = testDb.prepare("SELECT status FROM trader_signals WHERE id='auto-s1'").get() as any
    expect(row.status).toBe('suppressed_committee_abstain')
  })

  it('sends a Telegram alert after suppression when alertOnReject=true', async () => {
    testDb.prepare(`INSERT OR IGNORE INTO trader_strategies
      (id, name, asset_class, tier, status, params_json, created_at, updated_at)
      VALUES ('momentum-stocks','Momentum','stocks',1,'active','{}',?,?)`).run(Date.now(), Date.now())
    testDb.prepare(`INSERT INTO trader_signals
      (id, strategy_id, asset, side, raw_score, horizon_days, generated_at, status)
      VALUES ('auto-s2','momentum-stocks','MSFT','buy',0.75,3,?,'pending')`).run(Date.now())
    const send = vi.fn().mockResolvedValue(undefined)
    const stubCommittee = vi.fn().mockResolvedValue({
      decision: 'abstain', action: null, thesis: 'thin data', confidence: 0, size_usd: 0,
      transcript_id: 'tc-auto-2',
      transcript: {
        signal_id: 'auto-s2', started_at: Date.now(), finished_at: Date.now(), rounds_executed: 1,
        round_1: [], risk_officer: { role: 'risk_officer', veto: true, reason: 'thin data', concerns: [] },
        trader: { role: 'trader', action: 'abstain', thesis: 'thin data', confidence: 0, size_multiplier: 0 },
        errors: [],
      },
    })
    await autoDispatchPendingSignals(testDb, { send, runCommittee: stubCommittee, alertOnReject: true })
    expect(send).toHaveBeenCalledTimes(1)
    expect(send.mock.calls[0][0]).toContain('MSFT')
  })

  it('does not double-dispatch: atomic claim prevents concurrent duplicates', async () => {
    testDb.prepare(`INSERT OR IGNORE INTO trader_strategies
      (id, name, asset_class, tier, status, params_json, created_at, updated_at)
      VALUES ('momentum-stocks','Momentum','stocks',1,'active','{}',?,?)`).run(Date.now(), Date.now())
    testDb.prepare(`INSERT INTO trader_signals
      (id, strategy_id, asset, side, raw_score, horizon_days, generated_at, status)
      VALUES ('auto-s3','momentum-stocks','AMZN','buy',0.8,3,?,'pending')`).run(Date.now())
    const send = vi.fn().mockResolvedValue(undefined)
    const stubCommittee = vi.fn().mockResolvedValue({
      decision: 'abstain', action: null, thesis: 'ok', confidence: 0, size_usd: 0,
      transcript_id: 'tc-auto-3',
      transcript: {
        signal_id: 'auto-s3', started_at: Date.now(), finished_at: Date.now(), rounds_executed: 1,
        round_1: [], risk_officer: { role: 'risk_officer', veto: true, reason: 'ok', concerns: [] },
        trader: { role: 'trader', action: 'abstain', thesis: 'ok', confidence: 0, size_multiplier: 0 },
        errors: [],
      },
    })
    // Call twice sequentially (not concurrent -- SQLite is single-threaded)
    // First call should process, second should find no pending signals
    await autoDispatchPendingSignals(testDb, { send, runCommittee: stubCommittee })
    await autoDispatchPendingSignals(testDb, { send, runCommittee: stubCommittee })
    expect(stubCommittee).toHaveBeenCalledTimes(1)
  })

  it('marks the signal failed (not pending) when the duplicate guard query throws', async () => {
    testDb.prepare(
      `INSERT INTO trader_strategies (id, name, asset_class, tier, status, params_json, created_at, updated_at)
       VALUES ('momentum-stocks','Momentum','stocks',0,'active','{}',?,?)`,
    ).run(Date.now(), Date.now())
    testDb.prepare(
      `INSERT INTO trader_signals (id, strategy_id, asset, side, raw_score, horizon_days, generated_at, status)
       VALUES ('sig-guard','momentum-stocks','AAPL','buy',0.9,3,?,'pending')`,
    ).run(Date.now())

    // Force the guard SELECT (... AND engine_order_id IS NOT NULL ...) to throw
    // by rebuilding trader_decisions WITHOUT that column.
    testDb.exec(`
      ALTER TABLE trader_decisions RENAME TO trader_decisions_full;
      CREATE TABLE trader_decisions (
        id TEXT PRIMARY KEY, signal_id TEXT NOT NULL, action TEXT NOT NULL, asset TEXT NOT NULL,
        size_usd REAL, entry_type TEXT, entry_price REAL, stop_loss REAL, take_profit REAL,
        thesis TEXT NOT NULL, confidence REAL NOT NULL, committee_transcript_id TEXT,
        decided_at INTEGER NOT NULL, status TEXT NOT NULL
      );
    `)

    const sent: string[] = []
    const stubCommittee = async () => ({
      decision: 'approve' as const,
      action: 'buy' as const,
      size_usd: 50,
      confidence: 0.9,
      thesis: 'test',
      transcript_id: 'tx-guard',
      transcript: {
        signal_id: 'sig-guard', started_at: Date.now(), finished_at: Date.now(),
        rounds_executed: 0, round_1: [],
        risk_officer: { role: 'risk_officer' as const, veto: false, reason: 'ok', concerns: [] },
        trader: { role: 'trader' as const, action: 'buy' as const, thesis: 'ok', confidence: 0.9, size_multiplier: 1 },
        errors: [],
      },
    })
    const fakeEngine = { submitDecision: async () => ({ client_order_id: 'x', status: 'placed', approved_size_usd: 50, broker_order_id: 'b1' }) } as any

    await autoDispatchPendingSignals(
      testDb,
      { send: async (t: string) => { sent.push(t) }, runCommittee: stubCommittee as any, runAgent: (async () => '') as any },
      fakeEngine,
    )

    const sig = testDb.prepare(`SELECT status FROM trader_signals WHERE id='sig-guard'`).get() as { status: string }
    expect(sig.status).toBe('failed')
    expect(sig.status).not.toBe('pending')
    expect(sent.some((m) => m.includes('TRADER ALERT'))).toBe(true)
  })

  it('does not re-dispatch a signal across ticks when engine_order_id is missing (loop guard)', async () => {
    testDb.prepare(
      `INSERT INTO trader_strategies (id, name, asset_class, tier, status, params_json, created_at, updated_at)
       VALUES ('momentum-stocks','Momentum','stocks',0,'active','{}',?,?)`,
    ).run(Date.now(), Date.now())
    testDb.prepare(
      `INSERT INTO trader_signals (id, strategy_id, asset, side, raw_score, horizon_days, generated_at, status)
       VALUES ('sig-loop','momentum-stocks','NVDA','buy',0.95,3,?,'pending')`,
    ).run(Date.now())
    testDb.exec(`
      ALTER TABLE trader_decisions RENAME TO trader_decisions_full;
      CREATE TABLE trader_decisions (
        id TEXT PRIMARY KEY, signal_id TEXT NOT NULL, action TEXT NOT NULL, asset TEXT NOT NULL,
        size_usd REAL, entry_type TEXT, entry_price REAL, stop_loss REAL, take_profit REAL,
        thesis TEXT NOT NULL, confidence REAL NOT NULL, committee_transcript_id TEXT,
        decided_at INTEGER NOT NULL, status TEXT NOT NULL
      );
    `)

    const stubCommittee = async () => ({
      decision: 'approve' as const, action: 'buy' as const, size_usd: 50, confidence: 0.9,
      thesis: 'x', transcript_id: 'tx',
      transcript: {
        signal_id: 'sig-loop', started_at: 0, finished_at: 0, rounds_executed: 0, round_1: [],
        risk_officer: { role: 'risk_officer' as const, veto: false, reason: 'ok', concerns: [] },
        trader: { role: 'trader' as const, action: 'buy' as const, thesis: 'ok', confidence: 0.9, size_multiplier: 1 },
        errors: [],
      },
    })
    const fakeEngine = { submitDecision: async () => ({ client_order_id: 'x', status: 'placed', approved_size_usd: 50, broker_order_id: 'b1' }) } as any
    const deps = { send: async () => {}, runCommittee: stubCommittee as any, runAgent: (async () => '') as any }

    await autoDispatchPendingSignals(testDb, deps, fakeEngine)
    const afterTick1 = testDb.prepare(`SELECT status FROM trader_signals WHERE id='sig-loop'`).get() as { status: string }
    expect(afterTick1.status).toBe('failed')

    // Tick 2 must NOT pick the signal up again -- it is no longer 'pending'.
    const tick2 = await autoDispatchPendingSignals(testDb, deps, fakeEngine)
    expect(tick2.length).toBe(0)
    const afterTick2 = testDb.prepare(`SELECT status FROM trader_signals WHERE id='sig-loop'`).get() as { status: string }
    expect(afterTick2.status).toBe('failed')
  })

  it('outer loop catch: marks signal failed, cleans up stranded submitting decisions, and sends alert', async () => {
    // Seed a signal and a pre-existing 'submitting' decision (simulates a crash
    // between the INSERT and the engine call that left the row stranded).
    testDb.prepare(
      `INSERT INTO trader_strategies (id, name, asset_class, tier, status, params_json, created_at, updated_at)
       VALUES ('momentum-stocks','Momentum','stocks',0,'active','{}',?,?)`,
    ).run(Date.now(), Date.now())
    testDb.prepare(
      `INSERT INTO trader_signals (id, strategy_id, asset, side, raw_score, horizon_days, generated_at, status)
       VALUES ('sig-outer','momentum-stocks','TSLA','buy',0.88,3,?,'pending')`,
    ).run(Date.now())

    // Force the outer catch to fire by corrupting trader_strategies after the
    // signal is claimed. The strategy SELECT (outer try, before inner try)
    // will throw, hitting the outer catch directly.
    const origRun = testDb.prepare(
      "UPDATE trader_signals SET status = 'dispatching' WHERE id = ? AND status = 'pending'",
    ).run.bind(testDb.prepare(
      "UPDATE trader_signals SET status = 'dispatching' WHERE id = ? AND status = 'pending'",
    ))

    // Simpler approach: pre-insert a 'submitting' decision row, then drop
    // trader_strategies so the strategy lookup throws in the outer try.
    testDb.prepare(
      `INSERT INTO trader_decisions (id, signal_id, action, asset, size_usd, entry_type, thesis, confidence,
         committee_transcript_id, decided_at, status)
       VALUES ('dec-outer','sig-outer','buy','TSLA',50,'market','test',0.8,null,?,'submitting')`,
    ).run(Date.now())

    // Drop trader_strategies -- the outer try's strategy SELECT will throw.
    testDb.exec('DROP TABLE trader_strategies')

    const sent: string[] = []
    const deps = {
      send: async (m: string) => { sent.push(m) },
      runCommittee: async () => { throw new Error('should not reach committee') },
      runAgent: async () => ({ text: null }),
    }

    await autoDispatchPendingSignals(testDb, deps)

    const sig = testDb.prepare(`SELECT status FROM trader_signals WHERE id='sig-outer'`).get() as { status: string }
    expect(sig.status).toBe('failed')

    const dec = testDb.prepare(`SELECT status FROM trader_decisions WHERE id='dec-outer'`).get() as { status: string }
    expect(dec.status).toBe('failed')

    expect(sent.some((m) => m.includes('TRADER ALERT'))).toBe(true)
  })

  it('parks a network-timeout submit at retry_pending (no terminal fail, no resend)', async () => {
    testDb.prepare(`INSERT OR IGNORE INTO trader_strategies
      (id, name, asset_class, tier, status, params_json, created_at, updated_at)
      VALUES ('momentum-stocks','Momentum','stocks',1,'active','{}',?,?)`).run(Date.now(), Date.now())
    testDb.prepare(`INSERT INTO trader_signals (id, strategy_id, asset, side, raw_score, horizon_days, generated_at, status)
      VALUES ('sig-t1','momentum-stocks','TSLA','buy',0.7,20,?, 'pending')`).run(Date.now())
    const sendSpy = vi.fn(async () => {})
    const fakeEngine = {
      submitDecision: vi.fn().mockRejectedValue(new Error('The operation was aborted due to timeout')),
      getNav: vi.fn().mockResolvedValue(null),
      getPositions: vi.fn().mockResolvedValue([]),
    } as any
    await autoDispatchPendingSignals(
      testDb,
      { send: sendSpy, runCommittee: makeApproveCommittee(150) },
      fakeEngine,
    )
    const dec = testDb.prepare("SELECT status, submit_attempts, next_retry_at FROM trader_decisions WHERE signal_id='sig-t1'").get() as any
    expect(dec.status).toBe('retry_pending')
    expect(dec.submit_attempts).toBe(1)
    expect(dec.next_retry_at).toBeGreaterThan(0)
    // submitDecision called exactly once -- a timed-out order is never resent in-tick.
    expect(vi.mocked(fakeEngine.submitDecision)).toHaveBeenCalledTimes(1)
  })

  it('marks a 4xx submit reject as terminal failed and alerts', async () => {
    testDb.prepare(`INSERT OR IGNORE INTO trader_strategies
      (id, name, asset_class, tier, status, params_json, created_at, updated_at)
      VALUES ('momentum-stocks','Momentum','stocks',1,'active','{}',?,?)`).run(Date.now(), Date.now())
    testDb.prepare(`INSERT INTO trader_signals (id, strategy_id, asset, side, raw_score, horizon_days, generated_at, status)
      VALUES ('sig-t2','momentum-stocks','NVDA','buy',0.7,20,?, 'pending')`).run(Date.now())
    const sendSpy = vi.fn(async () => {})
    const fakeEngine = {
      submitDecision: vi.fn().mockRejectedValue(new Error('Engine API error 422 on /decisions/submit :: position_sizer')),
      getNav: vi.fn().mockResolvedValue(null),
      getPositions: vi.fn().mockResolvedValue([]),
    } as any
    await autoDispatchPendingSignals(
      testDb,
      { send: sendSpy, runCommittee: makeApproveCommittee(150) },
      fakeEngine,
    )
    const dec = testDb.prepare("SELECT status FROM trader_decisions WHERE signal_id='sig-t2'").get() as any
    const sig = testDb.prepare("SELECT status FROM trader_signals WHERE id='sig-t2'").get() as any
    expect(dec.status).toBe('failed')
    expect(sig.status).toBe('failed')
    expect(sendSpy).toHaveBeenCalledTimes(1)
  })

  it('suppresses a signal when cluster headroom is zero (already at/over cap)', async () => {
    testDb.prepare(`INSERT OR IGNORE INTO trader_strategies
      (id, name, asset_class, tier, status, params_json, created_at, updated_at)
      VALUES ('momentum-stocks','Momentum','stocks',1,'active','{}',?,?)`).run(Date.now(), Date.now())
    testDb.prepare(`INSERT INTO trader_signals (id, strategy_id, asset, side, raw_score, horizon_days, generated_at, status)
      VALUES ('sig-cluster','momentum-stocks','AAPL','buy',0.7,20,?,'pending')`).run(Date.now())

    const sendSpy = vi.fn(async () => {})
    // NAV=2000, cluster cap 50%=$1000. Existing SPY+QQQ exposure=$1200, already over cap -> headroom=0.
    const fakeEngine = {
      submitDecision: vi.fn(),
      getNav: vi.fn().mockResolvedValue(2000),
      getPositions: vi.fn().mockResolvedValue([
        { asset: 'SPY', qty: 1, avg_entry_price: 600, market_value: 700, unrealized_pnl: 100, source: 'test', updated_at: Date.now() },
        { asset: 'QQQ', qty: 1, avg_entry_price: 450, market_value: 500, unrealized_pnl: 50, source: 'test', updated_at: Date.now() },
      ]),
    } as any

    await autoDispatchPendingSignals(
      testDb,
      { send: sendSpy, runCommittee: makeApproveCommittee(150) },
      fakeEngine,
    )

    const sig = testDb.prepare("SELECT status FROM trader_signals WHERE id='sig-cluster'").get() as any
    expect(sig.status).toBe('suppressed_cluster_cap')
    expect(fakeEngine.submitDecision).not.toHaveBeenCalled()
  })

  it('trims (not blocks) when cluster headroom is positive but smaller than proposed size', async () => {
    testDb.prepare(`INSERT OR IGNORE INTO trader_strategies
      (id, name, asset_class, tier, status, params_json, created_at, updated_at)
      VALUES ('momentum-stocks','Momentum','stocks',1,'active','{}',?,?)`).run(Date.now(), Date.now())
    // Explicit max_size_usd=150 so risk sizing produces $150 (no NAV needed).
    testDb.prepare("UPDATE trader_strategies SET max_size_usd=150 WHERE id='momentum-stocks'").run()
    testDb.prepare(`INSERT INTO trader_signals (id, strategy_id, asset, side, raw_score, horizon_days, generated_at, status)
      VALUES ('sig-trim','momentum-stocks','AAPL','buy',0.7,20,?,'pending')`).run(Date.now())

    // NAV=2000, cluster cap 50%=$1000. Existing SPY market_value=$900 ->
    // cluster exposure=$900, headroom=$100. Risk sizing: explicit cap=$150 ->
    // sizeUsd=$150 (no heat issue). Cluster gate: 150 > 100 headroom -> TRIM to 100.
    const fakeEngine = {
      submitDecision: vi.fn().mockResolvedValue({
        client_order_id: 'coid-trim', broker_order_id: 'boid-trim', status: 'placed', approved_size_usd: 100,
      }),
      getNav: vi.fn().mockResolvedValue(2000),
      getPositions: vi.fn().mockResolvedValue([
        { asset: 'SPY', qty: 1, avg_entry_price: 900, market_value: 900, unrealized_pnl: 0, source: 'test', updated_at: Date.now() },
      ]),
    } as any

    await autoDispatchPendingSignals(
      testDb,
      { send: vi.fn().mockResolvedValue(undefined), runCommittee: makeApproveCommittee(150) },
      fakeEngine,
    )

    // Signal should NOT be suppressed -- it was trimmed and submitted.
    const sig = testDb.prepare("SELECT status FROM trader_signals WHERE id='sig-trim'").get() as any
    expect(sig.status).toBe('submitted')
    expect(fakeEngine.submitDecision).toHaveBeenCalledTimes(1)
    // Engine was called with size <= 100 (the headroom: 1000 - 900 = 100).
    const call = vi.mocked(fakeEngine.submitDecision).mock.calls[0][0]
    expect(call.size_usd).toBeLessThanOrEqual(100)
    expect(call.size_usd).toBeGreaterThan(0)
  })

  it('dispatches highest-score signal first (rank-aware daily cap)', async () => {
    testDb.prepare(`INSERT OR IGNORE INTO trader_strategies
      (id, name, asset_class, tier, status, params_json, created_at, updated_at)
      VALUES ('momentum-stocks','Momentum','stocks',1,'active','{}',?,?)`).run(Date.now(), Date.now())
    // Three signals with different scores; insert in low-to-high order to confirm
    // ordering is by raw_score DESC, not insertion order.
    testDb.prepare(`INSERT INTO trader_signals (id, strategy_id, asset, side, raw_score, horizon_days, generated_at, status)
      VALUES ('sig-low','momentum-stocks','MSFT','buy',0.3,20,?,'pending')`).run(Date.now())
    testDb.prepare(`INSERT INTO trader_signals (id, strategy_id, asset, side, raw_score, horizon_days, generated_at, status)
      VALUES ('sig-mid','momentum-stocks','AAPL','buy',0.5,20,?,'pending')`).run(Date.now())
    testDb.prepare(`INSERT INTO trader_signals (id, strategy_id, asset, side, raw_score, horizon_days, generated_at, status)
      VALUES ('sig-high','momentum-stocks','NVDA','buy',0.9,20,?,'pending')`).run(Date.now())

    const dispatchOrder: string[] = []
    const trackingCommittee = async (s: CommitteeSignalInput): Promise<CommitteeResult> => {
      dispatchOrder.push(s.id)
      return makeApproveCommittee(150)(s)
    }

    const fakeEngine = {
      submitDecision: vi.fn().mockResolvedValue({
        client_order_id: 'coid-rank', broker_order_id: 'boid-rank', status: 'placed', approved_size_usd: 150,
      }),
      getNav: vi.fn().mockResolvedValue(null),
      getPositions: vi.fn().mockResolvedValue([]),
    } as any

    await autoDispatchPendingSignals(
      testDb,
      { send: vi.fn().mockResolvedValue(undefined), runCommittee: trackingCommittee },
      fakeEngine,
    )

    // Highest-score signal must be dispatched first.
    expect(dispatchOrder[0]).toBe('sig-high')
    expect(dispatchOrder[1]).toBe('sig-mid')
    expect(dispatchOrder[2]).toBe('sig-low')
  })

  it('attaches vol-aware stop_loss + take_profit to the engine payload and the decision row', async () => {
    testDb.prepare(`INSERT OR IGNORE INTO trader_strategies
      (id, name, asset_class, tier, status, params_json, created_at, updated_at)
      VALUES ('momentum-stocks','Momentum','stocks',1,'active','{}',?,?)`).run(Date.now(), Date.now())
    // enrichment with a price window so the calculator uses the volatility path.
    const enrich = JSON.stringify({ price_current: 100, window_high: 120, window_low: 80 })
    testDb.prepare(`INSERT INTO trader_signals
      (id, strategy_id, asset, side, raw_score, horizon_days, enrichment_json, generated_at, status)
      VALUES ('auto-exit-1','momentum-stocks','AAPL','buy',0.8,20,?, ?,'pending')`).run(enrich, Date.now())

    const send = vi.fn().mockResolvedValue(undefined)
    const approve = vi.fn().mockResolvedValue({
      decision: 'approve', action: 'buy', thesis: 'ok', confidence: 0.7, size_usd: 150,
      transcript_id: 'tc-exit-1',
      transcript: {
        signal_id: 'auto-exit-1', started_at: Date.now(), finished_at: Date.now(), rounds_executed: 1,
        round_1: [], risk_officer: { role: 'risk_officer', veto: false, reason: 'clear', concerns: [] },
        trader: { role: 'trader', action: 'buy', thesis: 'ok', confidence: 0.7, size_multiplier: 1 },
        errors: [],
      },
    })
    const submitDecision = vi.fn().mockResolvedValue({
      client_order_id: 'coid-e1', broker_order_id: 'boid-e1', status: 'placed', approved_size_usd: 150,
    })
    const mockClient = { submitDecision, getNav: vi.fn().mockResolvedValue(null), getPositions: vi.fn().mockResolvedValue([]) }

    await autoDispatchPendingSignals(
      testDb,
      { send, runCommittee: approve },
      mockClient as unknown as EngineClient,
    )

    const payload = submitDecision.mock.calls[0][0]
    // entry_price resolved from enrichment price_current
    expect(payload.entry_price).toBe(100)
    // vol stop: range 40/100 *0.5 = 0.20 -> stop 80, 2R target 140
    expect(payload.stop_loss).toBeCloseTo(80, 5)
    expect(payload.take_profit).toBeCloseTo(140, 5)

    const row = testDb.prepare("SELECT entry_price, stop_loss, take_profit FROM trader_decisions WHERE signal_id='auto-exit-1'").get() as any
    expect(row.entry_price).toBe(100)
    expect(row.stop_loss).toBeCloseTo(80, 5)
    expect(row.take_profit).toBeCloseTo(140, 5)
  })

  it('still executes with null exits when enrichment is missing and price is unknown', async () => {
    testDb.prepare(`INSERT OR IGNORE INTO trader_strategies
      (id, name, asset_class, tier, status, params_json, created_at, updated_at)
      VALUES ('momentum-stocks','Momentum','stocks',1,'active','{}',?,?)`).run(Date.now(), Date.now())
    testDb.prepare(`INSERT INTO trader_signals
      (id, strategy_id, asset, side, raw_score, horizon_days, generated_at, status)
      VALUES ('auto-exit-2','momentum-stocks','MSFT','buy',0.8,20,?,'pending')`).run(Date.now())

    const send = vi.fn().mockResolvedValue(undefined)
    const approve = vi.fn().mockResolvedValue({
      decision: 'approve', action: 'buy', thesis: 'ok', confidence: 0.7, size_usd: 150,
      transcript_id: 'tc-exit-2',
      transcript: {
        signal_id: 'auto-exit-2', started_at: Date.now(), finished_at: Date.now(), rounds_executed: 1,
        round_1: [], risk_officer: { role: 'risk_officer', veto: false, reason: 'clear', concerns: [] },
        trader: { role: 'trader', action: 'buy', thesis: 'ok', confidence: 0.7, size_multiplier: 1 },
        errors: [],
      },
    })
    const submitDecision = vi.fn().mockResolvedValue({
      client_order_id: 'coid-e2', broker_order_id: 'boid-e2', status: 'placed', approved_size_usd: 150,
    })
    const mockClient = { submitDecision, getNav: vi.fn().mockResolvedValue(null), getPositions: vi.fn().mockResolvedValue([]) }

    await autoDispatchPendingSignals(
      testDb,
      { send, runCommittee: approve },
      mockClient as unknown as EngineClient,
    )

    const payload = submitDecision.mock.calls[0][0]
    expect(payload.stop_loss).toBeUndefined()
    expect(payload.take_profit).toBeUndefined()
    const row = testDb.prepare("SELECT status, stop_loss, take_profit FROM trader_decisions WHERE signal_id='auto-exit-2'").get() as any
    expect(row.status).toBe('submitted')
    expect(row.stop_loss).toBeNull()
    expect(row.take_profit).toBeNull()
  })
})
