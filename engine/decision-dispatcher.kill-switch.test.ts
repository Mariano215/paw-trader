/**
 * decision-dispatcher.kill-switch.test.ts -- Phase 4 Task A
 *
 * Regression: when the global kill switch is tripped, dispatchApproval
 * must NOT place a trade via the engine even on an explicit APPROVE.
 * The gate fires inside runAgent (src/agent.ts), which dispatchApproval
 * invokes indirectly through runCommittee. With every specialist gated,
 * the committee cannot reach quorum and returns abstain, so the
 * dispatcher records a committee_abstain row and never calls the engine.
 *
 * Control test: with the switch clear, the injected committee path
 * drives the dispatcher through to engineClient.submitDecision.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import Database from 'better-sqlite3'

import { initTraderTables } from './db.js'
import { seedMomentumStrategy } from './strategy-manager.js'
import { dispatchApproval } from './decision-dispatcher.js'
import type { EngineClient } from './engine-client.js'
import type { CommitteeResult, CommitteeSignalInput } from './committee.js'
import type { LadderResult } from './autonomy-ladder.js'
import type { AgentResult } from '../agent.js'
import * as killSwitch from '../cost/kill-switch-client.js'

function makeDb() {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = OFF')
  initTraderTables(db)
  seedMomentumStrategy(db)
  return db
}

function insertSignal(db: Database.Database): string {
  const id = 'sig-ks-1'
  db.prepare(`
    INSERT INTO trader_signals (id, strategy_id, asset, side, raw_score, horizon_days, generated_at, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, 'momentum-stocks', 'AAPL', 'buy', 0.72, 20, Date.now(), 'committee')
  return id
}

// Tier-1 ladder stub: full scale, no cold-start scaling in these tests.
const tierStub = (): LadderResult => ({ tier: 'tier-1', scale: 1.0, reason: 'test default' })

/**
 * runAgent stub that mirrors the real gate in src/agent.ts. When the
 * kill switch is tripped, returns a refusal AgentResult with the same
 * shape the real gate produces.
 *
 * This stub is ONLY used by the switch-tripped tests below. The clear
 * control test injects a `runCommittee` stub and never routes through
 * here, so the clear path deliberately throws to make accidental use
 * loud instead of silently returning fake specialist JSON.
 *
 * The real gate calls checkKillSwitch() inside runAgent; by mocking
 * that module, we let the dispatcher -> committee -> runAgent chain
 * flow naturally.
 */
async function gatedRunAgent(..._rest: unknown[]): Promise<AgentResult> {
  const sw = await killSwitch.checkKillSwitch()
  if (sw) {
    return {
      text: `System is paused. Kill switch tripped: ${sw.reason}. Ask an admin to clear it from the dashboard.`,
      emptyReason: `kill-switch active: ${sw.reason}`,
      resultSubtype: 'refused',
      eventCount: 0,
      assistantTurns: 0,
      toolUses: 0,
      durationSec: 0,
    }
  }
  throw new Error(
    'gatedRunAgent invoked with switch clear. Route control tests through a runCommittee stub instead so specialist JSON does not have to be faked here.',
  )
}

describe('decision-dispatcher kill-switch gate', () => {
  let db: ReturnType<typeof makeDb>
  let mockClient: Partial<EngineClient>

  beforeEach(() => {
    db = makeDb()
    // Phase 5 Task 1 -- dispatcher calls getNav() when strategy lacks
    // an explicit max_size_usd. Stub to null so the NAV fallback
    // degrades to DEFAULT_SIZE_USD (200) and does not break these
    // kill-switch assertions.
    mockClient = {
      submitDecision: vi.fn(),
      getRiskState: vi.fn(),
      getNav: vi.fn().mockResolvedValue(null),
    }
    vi.restoreAllMocks()
  })

  // -------------------------------------------------------------------------
  // Kill switch TRIPPED: engine must not be called, user-facing message must
  // reflect that no trade was placed. Path is committee -> runAgent -> gate.
  // -------------------------------------------------------------------------

  it('switch tripped: does NOT call engineClient.submitDecision on approve', async () => {
    vi.spyOn(killSwitch, 'checkKillSwitch').mockResolvedValue({
      set_at: Date.now(),
      reason: 'maintenance',
    })

    const signalId = insertSignal(db)

    const msg = await dispatchApproval(
      db,
      { action: 'approve', approvalId: 'ap-ks-1', decisionId: signalId },
      mockClient as EngineClient,
      { runAgent: gatedRunAgent as any, classifyTier: tierStub },
    )

    expect(mockClient.submitDecision).not.toHaveBeenCalled()
    // The committee abstains because quorum fails (every specialist
    // returns the refusal string, which is not valid JSON). That is
    // the natural "no trade placed" outcome behind the kill switch.
    expect(msg).toMatch(/abstained|Committee run failed|no trade/i)
  })

  it('switch tripped: returns a user-facing message explaining no trade was placed', async () => {
    vi.spyOn(killSwitch, 'checkKillSwitch').mockResolvedValue({
      set_at: Date.now(),
      reason: 'over budget',
    })

    const signalId = insertSignal(db)

    const msg = await dispatchApproval(
      db,
      { action: 'approve', approvalId: 'ap-ks-2', decisionId: signalId },
      mockClient as EngineClient,
      { runAgent: gatedRunAgent as any, classifyTier: tierStub },
    )

    // The dispatcher's user-facing messages never mention the kill switch
    // directly (that is surfaced by the runAgent refusal path). What we
    // must guarantee is: no mention of "Order placed" / "Trade placed"
    // and that engineClient.submitDecision was not reached.
    expect(msg).not.toMatch(/Order placed/i)
    expect(mockClient.submitDecision).not.toHaveBeenCalled()

    // And the dispatcher still records an audit trail -- either an
    // abstain row or nothing beyond the original signal. Either is
    // correct; what matters is the DB never records status='executed'.
    const executed = db.prepare(
      "SELECT COUNT(*) AS n FROM trader_decisions WHERE signal_id = ? AND status = 'executed'",
    ).get(signalId) as { n: number }
    expect(executed.n).toBe(0)
  })

  // -------------------------------------------------------------------------
  // Control: kill switch CLEAR. dispatchApproval proceeds normally via the
  // injected committee result path (we bypass the live agent chain here so
  // we can assert the full submit round-trip).
  // -------------------------------------------------------------------------

  it('switch clear: dispatchApproval proceeds normally and calls engineClient.submitDecision', async () => {
    vi.spyOn(killSwitch, 'checkKillSwitch').mockResolvedValue(null)

    const signalId = insertSignal(db)
    vi.mocked(mockClient.submitDecision!).mockResolvedValue({
      client_order_id: 'coid-ks-clear',
      broker_order_id: 'boid-ks-clear',
      status: 'placed',
      approved_size_usd: 150,
    })

    const approveCommittee = async (s: CommitteeSignalInput): Promise<CommitteeResult> => ({
      decision: 'approve',
      action: s.side,
      thesis: 'Stub approve: momentum clean.',
      confidence: 0.78,
      size_usd: 150,
      transcript_id: 'tr-ks-clear',
      transcript: {
        signal_id: s.id,
        started_at: Date.now(),
        finished_at: Date.now(),
        rounds_executed: 1,
        round_1: [],
        risk_officer: { role: 'risk_officer', veto: false, reason: 'ok', concerns: [] },
        trader: { role: 'trader', action: s.side, thesis: 'ok', confidence: 0.78, size_multiplier: 1 },
        errors: [],
      },
    })

    const msg = await dispatchApproval(
      db,
      { action: 'approve', approvalId: 'ap-ks-clear', decisionId: signalId },
      mockClient as EngineClient,
      { runCommittee: approveCommittee, classifyTier: tierStub },
    )

    expect(mockClient.submitDecision).toHaveBeenCalledOnce()
    expect(msg).toContain('placed')

    const row = db.prepare("SELECT status FROM trader_decisions WHERE signal_id = ?").get(signalId) as any
    expect(row.status).toBe('executed')
  })

})
