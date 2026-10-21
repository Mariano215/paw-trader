import { it, expect, vi } from 'vitest'
import type Database from 'better-sqlite3'
import bars from './fixtures/bars-2026.json' with { type: 'json' }
import sigs from './fixtures/signals-parity-momentum.json' with { type: 'json' }
import bt from './fixtures/backtest-momentum-2026-06-09.json' with { type: 'json' }
import { FakeEngine } from './fake-engine.js'
import { replay, freshReplayDb } from './runner.js'
import type { Candidate } from '../types.js'

// vi.mock is hoisted per test file, so every *.replay.ts file declares it.
vi.mock('../earnings.js', async (orig) => ({ ...(await orig<typeof import('../earnings.js')>()), daysToEarnings: async () => null }))

type Bt = { asset: string; entry_date: string; exit_date: string; reason: string; return_net: number }
type Category = 'suppressed_already_held' | 'stale' | 'committee_abstain' | 'fill_missed' | 'exit_rule_differs' | 'sizing_skipped' | 'reentry_timing'
const DAY = 86_400_000

type Bar = { date: string; low: number }
const barsBy = bars as unknown as Record<string, Bar[]>
const nyDate = (ms: number) => new Date(ms).toLocaleDateString('en-CA', { timeZone: 'America/New_York' })

it('parity: live momentum replay vs honest backtest, Jun-Oct 2026', async () => {
  const trades = bt as Bt[]
  // The backtest walks years of history, so on 2026-06-01 it may still hold a position opened in May; the fixture keeps
  // only in-window entries. Signals and backtest share one score function, so every qualifying day before an asset's first
  // in-window entry was blocked by that carried-in position. Drop those signals so both books start flat together.
  const firstEntry: Record<string, string> = {}
  for (const t of trades) if (!firstEntry[t.asset] || t.entry_date < firstEntry[t.asset]) firstEntry[t.asset] = t.entry_date
  const all = sigs as Candidate[]
  // Self-check of that argument: each first backtest entry has a signal on its own day.
  for (const [a, d] of Object.entries(firstEntry)) expect(all.some(s => s.asset === a && nyDate(s.generated_at) === d), `${a} ${d}`).toBe(true)
  const signals = all.filter(s => !firstEntry[s.asset] || nyDate(s.generated_at) >= firstEntry[s.asset])

  vi.useFakeTimers({ toFake: ['Date'] })
  const db = freshReplayDb(['momentum-stocks'])
  const e = new FakeEngine({ bars: bars as never, signals, startingCash: 100_000, now: () => Date.now() })
  const r = await replay({ db, engine: e, from: '2026-06-01', to: '2026-10-30', tickMinutes: 30 })
  vi.useRealTimers()
  if (r.errors.length) console.log(r.errors)
  expect(r.errors).toEqual([])

  // Pair each buy with the next sell of the same asset in fill order (a same-day re-entry must not reuse the earlier exit).
  const live = e.fills.flatMap((b, i) => b.side !== 'buy' ? [] : [{
    asset: b.asset, entry_date: b.date, usd: b.qty * b.price,
    exit_date: e.fills.slice(i + 1).find(s => s.side === 'sell' && s.asset === b.asset)?.date ?? 'open',
  }])
  const diffs: Array<{ kind: string; asset: string; entry: string; detail: string; category: Category | null }> = []
  for (const t of trades) {
    const m = live.find(l => l.asset === t.asset && l.entry_date === t.entry_date)
    if (!m) {
      const why = classifyMissing(db, t)
      diffs.push({ kind: 'missing_live', asset: t.asset, entry: t.entry_date, detail: `${t.reason}, signal ${why.status}`, category: why.category })
    } else if (m.exit_date !== t.exit_date) diffs.push({ kind: 'exit_date', asset: t.asset, entry: t.entry_date, detail: `${m.exit_date} vs ${t.exit_date} (${t.reason})`, category: 'exit_rule_differs' })
  }
  for (const l of live) if (!trades.some(t => t.asset === l.asset && t.entry_date === l.entry_date)) {
    const mine = trades.filter(t => t.asset === l.asset)
    // The backtest resumes scanning at i = exit_idx (engine 100deb1), so its earliest re-entry is the next bar's open, never the exit day.
    const reentry = mine.some(t => l.entry_date >= t.exit_date && l.entry_date <= nextBarDate(t.asset, t.exit_date))
    // The backtest's own one-position rule: it still held the asset that day (after an earlier divergence).
    const held = mine.some(t => t.entry_date < l.entry_date && l.entry_date < t.exit_date)
    diffs.push({ kind: 'extra_live', asset: l.asset, entry: l.entry_date, detail: `exit ${l.exit_date}`,
      category: reentry ? 'reentry_timing' : held ? 'suppressed_already_held' : null })
  }
  console.table(diffs)
  console.log({ backtest: trades.length, live: live.length, diffs: diffs.length })
  const avgUsd = live.reduce((s, l) => s + l.usd, 0) / Math.max(live.length, 1)
  console.log({ live_realized_pnl: r.realized.reduce((s, x) => s + x.pnl_net, 0), backtest_pnl_at_avg_size: trades.reduce((s, t) => s + t.return_net, 0) * avgUsd, avg_position_usd: avgUsd })
  expect(diffs.filter(d => d.category === null)).toEqual([])
  // Pinned: the books match, so any new diff, categorized or not, is a regression.
  expect(diffs).toEqual([])
})

const nextBarDate = (asset: string, date: string) => barsBy[asset].find(b => b.date > date)?.date ?? date

/** Why a backtest trade has no live twin, read from the signal row the replay stored. */
function classifyMissing(db: Database.Database, t: Bt): { status: string; category: Category | null } {
  const day0 = Date.parse(t.entry_date + 'T04:00:00Z')
  const row = db.prepare(`SELECT s.status, d.entry_type, d.entry_price FROM trader_signals s LEFT JOIN trader_decisions d ON d.signal_id = s.id AND d.action = 'buy'
    WHERE s.asset=? AND s.generated_at BETWEEN ? AND ? ORDER BY s.generated_at LIMIT 1`)
    .get(t.asset, day0, day0 + DAY) as { status: string; entry_type: string | null; entry_price: number | null } | undefined
  if (!row) return { status: 'none', category: null }
  const cat = ((): Category | null => {
    if (row.status === 'suppressed_already_held') return 'suppressed_already_held'
    if (row.status === 'suppressed_stale') return 'stale'
    if (row.status === 'suppressed_committee_abstain') return 'committee_abstain'
    if (row.status === 'suppressed_same_day_reentry') return 'reentry_timing'
    // A limit buy the entry bar never traded down to; the backtest fills at the open regardless.
    const bar = barsBy[t.asset].find(b => b.date === t.entry_date)
    if (row.status === 'failed' && row.entry_type === 'limit' && bar && row.entry_price != null && bar.low > row.entry_price) return 'fill_missed'
    if (/size|headroom|cap|cluster|correlation|heat/.test(row.status)) return 'sizing_skipped'
    return null
  })()
  return { status: row.status, category: cat }
}
