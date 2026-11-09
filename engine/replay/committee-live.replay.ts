import { it, expect, vi } from 'vitest'
import rsi from './fixtures/signals-2026-10-19-rsi2.json' with { type: 'json' }
import bars from './fixtures/bars-2026.json' with { type: 'json' }
import { freshReplayDb } from './runner.js'
import { FakeEngine, type OhlcBar } from './fake-engine.js'
import { runCommittee, storeTranscript, type CommitteeSignalInput, type CommitteeResult } from '../committee.js'
import { enrichPendingSignals } from '../enrichment-fetcher.js'
import { retrievePastCases } from '../reasoning-bank.js'
import { DEFAULT_SIZE_USD } from '../approval-manager.js'
import type { EngineClient } from '../engine-client.js'

// vi.mock is hoisted per test file, so every *.replay.ts file declares it.
vi.mock('../earnings.js', async (orig) => ({ ...(await orig<typeof import('../earnings.js')>()), daysToEarnings: async () => null }))

type Fixture = { id: string; strategy: string; asset: string; side: 'buy' | 'sell'; raw_score: number; horizon_days: number; generated_at: number }

// Paid test: two real Claude committee runs through the real runAgent path (kill switch and cost gate included).
// A refusal (CommitteeGatedError, kill switch, cost cap, missing key) throws and fails the test with its reason.
it.skipIf(process.env.LIVE_COMMITTEE !== '1')('committee runs on the API key for the Oct 19 RSI(2) signals', async () => {
  const db = freshReplayDb(['rsi2-stocks'])
  // First signal per asset only: the fixture holds 52 repeat polls.
  const first = new Map<string, Fixture>()
  for (const s of rsi as Fixture[]) if (!first.has(s.asset)) first.set(s.asset, s)
  const picked = ['QQQ', 'XLK'].map(a => first.get(a)!)
  expect(picked.every(Boolean)).toBe(true)

  const ins = db.prepare(`INSERT INTO trader_signals (id, strategy_id, asset, side, raw_score, horizon_days, enrichment_json, generated_at, status)
    VALUES (?, 'rsi2-stocks', ?, ?, ?, ?, NULL, ?, 'pending')`)
  for (const s of picked) ins.run(s.id, s.asset, s.side, s.raw_score, s.horizon_days, s.generated_at)

  // Same enrichment helper the tick calls, fed fixture bars (no live engine).
  const engine = new FakeEngine({ bars: bars as Record<string, OhlcBar[]>, signals: [], startingCash: 100_000, now: () => picked[0].generated_at })
  await enrichPendingSignals(db, engine as unknown as EngineClient)

  const runAgent = (await import('../tracked-run-agent.js')).trackedRunAgent
  const results: Array<{ asset: string; r: CommitteeResult }> = []
  for (const s of picked) {
    const row = db.prepare('SELECT enrichment_json FROM trader_signals WHERE id = ?').get(s.id) as { enrichment_json: string | null }
    const input: CommitteeSignalInput = {
      id: s.id, asset: s.asset, side: s.side, raw_score: s.raw_score, horizon_days: s.horizon_days,
      enrichment_json: row.enrichment_json, strategy_id: 'rsi2-stocks',
    }
    const pastCases = retrievePastCases(db, { asset: s.asset, strategy: 'rsi2-stocks', side: s.side, k: 3 })
    const r = await runCommittee(input, { runAgent, defaultSizeUsd: DEFAULT_SIZE_USD, maxSizeUsd: 2500, pastCases, db }) // 2500 = dispatcher's COMMITTEE_MAX_SIZE_USD
    storeTranscript(db, r)
    results.push({ asset: s.asset, r })
    console.log(JSON.stringify({ asset: s.asset, decision: r.decision, confidence: r.confidence, thesis: r.thesis, errors: r.transcript.errors }))
    expect(['approve', 'abstain']).toContain(r.decision)
  }
  const t = db.prepare('SELECT COUNT(*) n, SUM(total_cost_usd) c FROM trader_committee_transcripts').get() as { n: number; c: number }
  console.log(t)
  expect(t.n).toBe(2)
  expect(t.c).toBeGreaterThan(0)
}, 300_000)
