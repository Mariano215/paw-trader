import { describe, it, expect, beforeEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import { initTraderTables } from './db.js'
import { seedMomentumStrategy } from './strategy-manager.js'
import { dispatchApproval } from './decision-dispatcher.js'
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
    expect(row.status).toBe('executed')
    expect(row.thesis).toContain('Stub approve')
    expect(row.committee_transcript_id).toBe('tr-test-approve')
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
    // getNav should not even be consulted here -- the explicit cap short-circuits.
    mockClient.getNav = vi.fn()
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
    expect(mockClient.getNav).not.toHaveBeenCalled()
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

  it('honors the $1000 hard ceiling even when NAV * 2% would allow more', async () => {
    const signalId = insertSignal(db)
    // NAV 1M * 2% = 20_000, but hard ceiling clamps to 1000.
    mockClient.getNav = vi.fn().mockResolvedValue(1_000_000)
    vi.mocked(mockClient.submitDecision!).mockResolvedValue({
      client_order_id: 'coid-ceil', broker_order_id: 'boid-ceil', status: 'placed', approved_size_usd: 1000,
    })
    await dispatchApproval(
      db,
      { action: 'approve', approvalId: 'ap-1', decisionId: signalId },
      mockClient as EngineClient,
      { runCommittee: makeApproveCommittee(5000), classifyTier: tierStub },
    )
    const submitCall = vi.mocked(mockClient.submitDecision!).mock.calls[0][0]
    expect(submitCall.size_usd).toBe(1000)
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
})
