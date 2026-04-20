/**
 * weekly-report.test.ts -- Phase 4 Task C
 *
 * Unit tests for the weekly report aggregator, HTML/Telegram renderers,
 * disk writer, and the Sunday-9am scheduler gate. Uses :memory: SQLite
 * plus fixture helpers so each test is fully isolated.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import path from 'node:path'
import { mkdirSync, readFileSync, rmSync, existsSync } from 'node:fs'
import os from 'node:os'

import { initTraderTables } from './db.js'
import { seedAllStrategies } from './strategy-manager.js'
import { recomputeTrackRecord } from './track-record.js'
import {
  buildReport,
  renderReportHtml,
  renderReportSummary,
  saveReport,
  listVerdictsInWindow,
  tallyAttribution,
  fetchNavDelta,
  computeWeekBoundary,
  shouldFireWeeklyReport,
  nextFirePoint,
  readLastFireMs,
  writeLastFireMs,
  maybeFireWeeklyReport,
  formatDate,
  WEEKLY_REPORT_KV_KEY,
  type VerdictRow,
  type WeeklyReport,
  type KillSwitchLogEntry,
} from './weekly-report.js'
import type { EngineClient } from './engine-client.js'
import type { NavSnapshot } from './types.js'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeDb() {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = OFF')
  initTraderTables(db)
  seedAllStrategies(db)
  db.prepare(`
    CREATE TABLE IF NOT EXISTS kv_settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `).run()
  return db
}

function insertSignal(
  db: Database.Database,
  id: string,
  strategyId: string,
  asset: string,
  side: 'buy' | 'sell',
) {
  db.prepare(`
    INSERT INTO trader_signals (id, strategy_id, asset, side, raw_score, horizon_days, generated_at, status)
    VALUES (?, ?, ?, ?, 0.7, 20, ?, 'closed')
  `).run(id, strategyId, asset, side, Date.now())
}

function insertDecision(
  db: Database.Database,
  id: string,
  signalId: string,
  asset: string,
  sizeUsd: number,
  decidedAt: number,
) {
  db.prepare(`
    INSERT INTO trader_decisions
      (id, signal_id, action, asset, size_usd, entry_type, thesis, confidence,
       committee_transcript_id, decided_at, status)
    VALUES (?, ?, 'buy', ?, ?, 'limit', 'thesis x', 0.7, NULL, ?, 'closed')
  `).run(id, signalId, asset, sizeUsd, decidedAt)
}

function insertVerdict(
  db: Database.Database,
  decisionId: string,
  pnlGross: number,
  thesisGrade: 'A' | 'B' | 'C' | 'D',
  closedAt: number,
  attribution: Array<{ role: string; data: Record<string, unknown> }> = [],
  overrides: Partial<{ pnlNet: number; benchReturn: number; holdDrawdown: number }> = {},
) {
  const id = `v-${decisionId}`
  db.prepare(`
    INSERT INTO trader_verdicts
      (id, decision_id, pnl_gross, pnl_net, bench_return, hold_drawdown,
       thesis_grade, agent_attribution_json, embedding_id, closed_at,
       returns_backfilled)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, 1)
  `).run(
    id,
    decisionId,
    pnlGross,
    overrides.pnlNet ?? pnlGross,
    overrides.benchReturn ?? 0,
    overrides.holdDrawdown ?? 0,
    thesisGrade,
    JSON.stringify(attribution),
    closedAt,
  )
}

/** Seed one closed trade end-to-end (signal + decision + verdict) and recompute the strategy rollup. */
function seedClosedTrade(
  db: Database.Database,
  args: {
    signalId: string
    decisionId: string
    strategyId: string
    asset: string
    side: 'buy' | 'sell'
    sizeUsd: number
    pnlGross: number
    grade: 'A' | 'B' | 'C' | 'D'
    closedAt: number
    decidedAt?: number
    attribution?: Array<{ role: string; data: Record<string, unknown> }>
  },
) {
  insertSignal(db, args.signalId, args.strategyId, args.asset, args.side)
  insertDecision(
    db,
    args.decisionId,
    args.signalId,
    args.asset,
    args.sizeUsd,
    args.decidedAt ?? args.closedAt - 60_000,
  )
  insertVerdict(db, args.decisionId, args.pnlGross, args.grade, args.closedAt, args.attribution ?? [])
  recomputeTrackRecord(db, args.strategyId)
}

// Anchor dates (Sunday 2026-04-12 and 2026-04-19 at NY midnight).
// We build by using computeWeekBoundary on a known-Sunday instant so
// the fixtures match what the gate would detect in production.
//
// 2026-04-19 09:00 ET = 2026-04-19 13:00 UTC (EDT offset -4).
const SUN_APR_19_9AM_UTC = Date.UTC(2026, 3, 19, 13, 0, 0, 0)

// ---------------------------------------------------------------------------
// computeWeekBoundary / nextFirePoint / shouldFireWeeklyReport
// ---------------------------------------------------------------------------

describe('week boundary math', () => {
  it('computeWeekBoundary on Sunday 9am NY returns prior Sun..Sat window', () => {
    const { weekStartMs, weekEndMs } = computeWeekBoundary(SUN_APR_19_9AM_UTC)
    // Start = Sun Apr 12 00:00 NY -> 04:00 UTC (EDT).
    expect(new Date(weekStartMs).toISOString()).toBe('2026-04-12T04:00:00.000Z')
    // End = Sun Apr 19 00:00 NY minus 1ms -> 04:00 UTC - 1ms
    expect(new Date(weekEndMs).toISOString()).toBe('2026-04-19T03:59:59.999Z')
  })

  it('computeWeekBoundary on a Wednesday still anchors to the most recent Sunday', () => {
    // Wed Apr 15 2026 15:00 UTC -> 11am NY
    const wed = Date.UTC(2026, 3, 15, 15, 0, 0, 0)
    const { weekStartMs, weekEndMs } = computeWeekBoundary(wed)
    // Last Sunday = Apr 12. Window = prior Sun Apr 5 -> Sat Apr 11.
    expect(new Date(weekStartMs).toISOString()).toBe('2026-04-05T04:00:00.000Z')
    expect(new Date(weekEndMs).toISOString()).toBe('2026-04-12T03:59:59.999Z')
  })

  it('computeWeekBoundary handles spring-forward Sunday (midnight EST, 9am EDT)', () => {
    // Spring forward 2026: Sun Mar 8 02:00 EST -> 03:00 EDT. At 9am on
    // Mar 8, the clock is EDT (-240). But midnight of Mar 8 was still
    // EST (-300). Week window's START is prior Sun (Mar 1) midnight in
    // the offset that was in effect on Mar 1 (EST). END is Mar 8
    // midnight which was also EST (pre-transition). A naive impl using
    // the 9am EDT offset for midnight math would slide the window by
    // one hour and either miss or double-count the last hour.
    const sun_mar_8_9am_edt = Date.UTC(2026, 2, 8, 13, 0, 0, 0)  // 9am EDT = 13:00 UTC
    const { weekStartMs, weekEndMs } = computeWeekBoundary(sun_mar_8_9am_edt)
    // Week start = Sun Mar 1 00:00 EST = 05:00 UTC (Mar 1 was pre-DST, EST).
    expect(new Date(weekStartMs).toISOString()).toBe('2026-03-01T05:00:00.000Z')
    // Week end = Sun Mar 8 00:00 EST (pre-transition) minus 1ms = 04:59:59.999 UTC
    expect(new Date(weekEndMs).toISOString()).toBe('2026-03-08T04:59:59.999Z')
  })

  it('computeWeekBoundary handles fall-back Sunday (midnight EDT, 9am EST)', () => {
    // Fall back 2026: Sun Nov 1 02:00 EDT -> 01:00 EST. At 9am on
    // Nov 1, the clock is EST (-300). But midnight of Nov 1 was still
    // EDT (-240). Week window's END (Nov 1 midnight local) must use
    // the EDT offset; a naive impl would push the boundary one hour
    // earlier and double-count the final hour of Saturday Oct 31.
    const sun_nov_1_9am_est = Date.UTC(2026, 10, 1, 14, 0, 0, 0)  // 9am EST = 14:00 UTC
    const { weekStartMs, weekEndMs } = computeWeekBoundary(sun_nov_1_9am_est)
    // Week start = Sun Oct 25 00:00 EDT = 04:00 UTC.
    expect(new Date(weekStartMs).toISOString()).toBe('2026-10-25T04:00:00.000Z')
    // Week end = Sun Nov 1 00:00 EDT (pre-transition) minus 1ms = 03:59:59.999 UTC.
    expect(new Date(weekEndMs).toISOString()).toBe('2026-11-01T03:59:59.999Z')
  })

  it('nextFirePoint returns the most recent Sunday 9am NY', () => {
    // Sun Apr 19 at 10am ET (UTC 14:00) -> today 9am is fire point.
    const sun_10am_et = Date.UTC(2026, 3, 19, 14, 0, 0, 0)
    expect(new Date(nextFirePoint(sun_10am_et)).toISOString()).toBe('2026-04-19T13:00:00.000Z')
    // Sat 2pm ET -> most recent fire was Apr 12 9am ET.
    const sat_2pm_et = Date.UTC(2026, 3, 18, 18, 0, 0, 0)
    expect(new Date(nextFirePoint(sat_2pm_et)).toISOString()).toBe('2026-04-12T13:00:00.000Z')
  })

  it('shouldFireWeeklyReport fires the first tick after 9am Sunday when never fired', () => {
    const just_after = SUN_APR_19_9AM_UTC + 60_000 // 9:01 am ET
    expect(shouldFireWeeklyReport(just_after, null)).toBe(true)
  })

  it('shouldFireWeeklyReport stays quiet before 9am Sunday (inside current Sunday)', () => {
    const just_before = SUN_APR_19_9AM_UTC - 60_000 // 8:59 am ET
    // "Most recent fire point" for 8:59am Sunday is the prior Sunday 9am,
    // which is 7 days ago -- past the grace window. So we do NOT fire
    // even though lastFire is null.
    expect(shouldFireWeeklyReport(just_before, null)).toBe(false)
  })

  it('shouldFireWeeklyReport does not double-fire inside the same window', () => {
    const after_first = SUN_APR_19_9AM_UTC + 60_000
    // lastFireMs stored at or after the firing point -> no re-fire until
    // the next Sunday rolls around.
    expect(shouldFireWeeklyReport(after_first + 3600_000, after_first)).toBe(false)
  })

  it('shouldFireWeeklyReport fires again one week later', () => {
    const next_sun = SUN_APR_19_9AM_UTC + 7 * 86_400_000 + 60_000
    // Previous fire was this past Sunday -> by next Sunday, we cross a
    // fresh fire point so it fires again.
    expect(shouldFireWeeklyReport(next_sun, SUN_APR_19_9AM_UTC + 60_000)).toBe(true)
  })

  it('Saturday evening with no prior fire stays quiet (grace expired)', () => {
    const sat_evening = Date.UTC(2026, 3, 18, 23, 0, 0, 0) // Sat 7pm ET
    expect(shouldFireWeeklyReport(sat_evening, null)).toBe(false)
  })

  it('Sunday 10pm NY is past the 12h grace -> no fire', () => {
    // 9am ET + 13h = 10pm ET. Still Sunday local, but > WEEKLY_REPORT_GRACE_MS.
    const sun_10pm_et = SUN_APR_19_9AM_UTC + 13 * 60 * 60 * 1000
    expect(shouldFireWeeklyReport(sun_10pm_et, null)).toBe(false)
  })

  it('Sunday 8pm NY is still inside the 12h grace -> fires if never fired', () => {
    const sun_8pm_et = SUN_APR_19_9AM_UTC + 11 * 60 * 60 * 1000
    expect(shouldFireWeeklyReport(sun_8pm_et, null)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// listVerdictsInWindow
// ---------------------------------------------------------------------------

describe('listVerdictsInWindow', () => {
  let db: ReturnType<typeof makeDb>
  beforeEach(() => { db = makeDb() })

  it('returns verdicts closed within [start, end] with joined fields', () => {
    const closedInWindow = SUN_APR_19_9AM_UTC - 2 * 86_400_000 // Fri
    seedClosedTrade(db, {
      signalId: 'sig-a', decisionId: 'dec-a', strategyId: 'momentum-stocks',
      asset: 'AAPL', side: 'buy', sizeUsd: 100, pnlGross: 10, grade: 'A',
      closedAt: closedInWindow,
    })
    const { weekStartMs, weekEndMs } = computeWeekBoundary(SUN_APR_19_9AM_UTC)
    const rows = listVerdictsInWindow(db, weekStartMs, weekEndMs)
    expect(rows).toHaveLength(1)
    expect(rows[0].asset).toBe('AAPL')
    expect(rows[0].strategy_id).toBe('momentum-stocks')
    expect(rows[0].pnl_gross).toBe(10)
    expect(rows[0].pnl_pct).toBeCloseTo(0.1, 5)
  })

  it('excludes verdicts outside the window', () => {
    const beforeWindow = SUN_APR_19_9AM_UTC - 30 * 86_400_000
    seedClosedTrade(db, {
      signalId: 'sig-old', decisionId: 'dec-old', strategyId: 'momentum-stocks',
      asset: 'AAPL', side: 'buy', sizeUsd: 100, pnlGross: 10, grade: 'A',
      closedAt: beforeWindow,
    })
    const { weekStartMs, weekEndMs } = computeWeekBoundary(SUN_APR_19_9AM_UTC)
    expect(listVerdictsInWindow(db, weekStartMs, weekEndMs)).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// tallyAttribution
// ---------------------------------------------------------------------------

describe('tallyAttribution', () => {
  it('counts trader.right vs trader.wrong and risk_officer flags', () => {
    const verdicts: VerdictRow[] = [
      mockVerdict({ attribution: [
        { role: 'trader', data: { right: true } },
        { role: 'risk_officer', data: { vetoed: false, right: true } },
        { role: 'quant', data: { confidence: 0.8 } },
      ] }),
      mockVerdict({ attribution: [
        { role: 'trader', data: { right: false } },
        { role: 'risk_officer', data: { vetoed: false, right: false } },
        { role: 'quant', data: { confidence: 0.5 } },
      ] }),
    ]
    const tally = tallyAttribution(verdicts)
    expect(tally['trader.right']).toBe(1)
    expect(tally['trader.wrong']).toBe(1)
    expect(tally['risk_officer.right']).toBe(1)
    expect(tally['risk_officer.wrong']).toBe(1)
    expect(tally['quant.appearance']).toBe(2)
  })

  it('tolerates unparseable JSON without throwing', () => {
    const v: VerdictRow = mockVerdict({})
    v.agent_attribution_json = '{not json'
    expect(() => tallyAttribution([v])).not.toThrow()
    expect(tallyAttribution([v])).toEqual({})
  })
})

function mockVerdict(opts: {
  attribution?: Array<{ role: string; data: Record<string, unknown> }>
  pnlGross?: number
  grade?: 'A' | 'B' | 'C' | 'D'
}): VerdictRow {
  return {
    decision_id: 'dec-mock',
    asset: 'AAPL',
    side: 'buy',
    strategy_id: 'momentum-stocks',
    pnl_gross: opts.pnlGross ?? 10,
    pnl_net: opts.pnlGross ?? 10,
    pnl_pct: 0.1,
    bench_return: 0,
    hold_drawdown: 0,
    thesis_grade: opts.grade ?? 'A',
    agent_attribution_json: JSON.stringify(opts.attribution ?? []),
    closed_at: 0,
  }
}

// ---------------------------------------------------------------------------
// fetchNavDelta
// ---------------------------------------------------------------------------

describe('fetchNavDelta', () => {
  it('computes week open/close when snapshots are present', async () => {
    const { weekStartMs, weekEndMs } = computeWeekBoundary(SUN_APR_19_9AM_UTC)
    const midWeek = (weekStartMs + weekEndMs) / 2
    const snapshots: NavSnapshot[] = [
      { date: '2026-04-12', period: 'day_open', nav: 1000, recorded_at: weekStartMs + 1000 },
      { date: '2026-04-14', period: 'day_open', nav: 1010, recorded_at: midWeek - 1000 },
      { date: '2026-04-14', period: 'day_close', nav: 1020, recorded_at: midWeek + 1000 },
      { date: '2026-04-18', period: 'day_close', nav: 1050, recorded_at: weekEndMs - 1000 },
    ]
    const client = {
      getNavSnapshots: vi.fn().mockResolvedValue(snapshots),
    } as unknown as EngineClient
    const nav = await fetchNavDelta(client, weekStartMs, weekEndMs)
    expect(nav.available).toBe(true)
    expect(nav.weekOpen).toBe(1000)
    expect(nav.weekClose).toBe(1050)
    expect(nav.deltaUsd).toBe(50)
    expect(nav.deltaPct).toBeCloseTo(0.05, 5)
  })

  it('falls back to unavailable when engine throws', async () => {
    const client = {
      getNavSnapshots: vi.fn().mockRejectedValue(new Error('engine down')),
    } as unknown as EngineClient
    const nav = await fetchNavDelta(client, 0, 1)
    expect(nav.available).toBe(false)
    expect(nav.unavailableReason).toContain('unreachable')
  })

  it('marks NAV as not yet populated when fewer than two snapshot periods are present', async () => {
    const { weekStartMs, weekEndMs } = computeWeekBoundary(SUN_APR_19_9AM_UTC)
    const snapshots: NavSnapshot[] = [
      { date: '2026-04-12', period: 'day_open', nav: 1000, recorded_at: weekStartMs + 1000 },
    ]
    const client = {
      getNavSnapshots: vi.fn().mockResolvedValue(snapshots),
    } as unknown as EngineClient
    const nav = await fetchNavDelta(client, weekStartMs, weekEndMs)
    expect(nav.available).toBe(false)
    expect(nav.unavailableReason).toBe('NAV not yet populated')
  })

  it('null engine client -> unavailable', async () => {
    const nav = await fetchNavDelta(null, 0, 1)
    expect(nav.available).toBe(false)
    expect(nav.unavailableReason).toBe('engine client unavailable')
  })
})

// ---------------------------------------------------------------------------
// buildReport
// ---------------------------------------------------------------------------

describe('buildReport', () => {
  let db: ReturnType<typeof makeDb>
  beforeEach(() => { db = makeDb() })

  it('aggregates verdicts, track records, attribution, and NAV', async () => {
    const closedAt = SUN_APR_19_9AM_UTC - 2 * 86_400_000
    seedClosedTrade(db, {
      signalId: 'sig-w1', decisionId: 'dec-w1', strategyId: 'momentum-stocks',
      asset: 'AAPL', side: 'buy', sizeUsd: 100, pnlGross: 10, grade: 'A',
      closedAt,
      attribution: [
        { role: 'trader', data: { right: true } },
        { role: 'quant', data: { confidence: 0.8 } },
      ],
    })
    seedClosedTrade(db, {
      signalId: 'sig-l1', decisionId: 'dec-l1', strategyId: 'momentum-stocks',
      asset: 'TSLA', side: 'buy', sizeUsd: 100, pnlGross: -5, grade: 'D',
      closedAt: closedAt + 3600_000,
      attribution: [{ role: 'trader', data: { right: false } }],
    })
    const { weekStartMs, weekEndMs } = computeWeekBoundary(SUN_APR_19_9AM_UTC)

    const client = {
      getNavSnapshots: vi.fn().mockResolvedValue([
        { date: '2026-04-12', period: 'day_open',  nav: 1000, recorded_at: weekStartMs + 1000 },
        { date: '2026-04-18', period: 'day_close', nav: 1050, recorded_at: weekEndMs - 1000 },
      ]),
    } as unknown as EngineClient

    const report = await buildReport(db, client, { weekStartMs, weekEndMs, nowMs: SUN_APR_19_9AM_UTC })
    expect(report.verdictCount).toBe(2)
    expect(report.winCount).toBe(1)
    expect(report.lossCount).toBe(1)
    expect(report.winRate).toBe(0.5)
    expect(report.totalPnlNet).toBe(5) // 10 + -5
    expect(report.gradeBreakdown.A).toBe(1)
    expect(report.gradeBreakdown.D).toBe(1)
    expect(report.bestTrades[0].asset).toBe('AAPL')
    expect(report.worstTrades[0].asset).toBe('TSLA')
    expect(report.attribution['trader.right']).toBe(1)
    expect(report.attribution['trader.wrong']).toBe(1)
    expect(report.strategyRollups.length).toBeGreaterThan(0)
    expect(report.nav.available).toBe(true)
    expect(report.nav.deltaUsd).toBe(50)
    expect(report.killSwitchEvents[0].kind).toBe('no_log_available')
  })

  it('empty week produces a clean report with zero counts', async () => {
    const { weekStartMs, weekEndMs } = computeWeekBoundary(SUN_APR_19_9AM_UTC)
    const report = await buildReport(db, null, { weekStartMs, weekEndMs, nowMs: SUN_APR_19_9AM_UTC })
    expect(report.verdictCount).toBe(0)
    expect(report.winRate).toBe(0)
    expect(report.bestTrades).toEqual([])
    expect(report.worstTrades).toEqual([])
    expect(report.nav.available).toBe(false)
    expect(report.killSwitchEvents.length).toBeGreaterThan(0)
  })

  it('engine unreachable still renders with NAV unavailable section', async () => {
    const { weekStartMs, weekEndMs } = computeWeekBoundary(SUN_APR_19_9AM_UTC)
    const client = {
      getNavSnapshots: vi.fn().mockRejectedValue(new Error('engine down')),
    } as unknown as EngineClient
    const report = await buildReport(db, client, { weekStartMs, weekEndMs })
    const html = renderReportHtml(report)
    expect(html).toContain('NAV unavailable')
  })

  it('active kill switch during window is surfaced', async () => {
    const { weekStartMs, weekEndMs } = computeWeekBoundary(SUN_APR_19_9AM_UTC)
    const setAt = weekStartMs + 3600_000
    const report = await buildReport(db, null, {
      weekStartMs, weekEndMs,
      killSwitch: { active: true, set_at: setAt, reason: 'daily loss cap' },
    })
    expect(report.killSwitchEvents[0].kind).toBe('active_during_window')
    expect(report.killSwitchEvents[0].reason).toBe('daily loss cap')
  })
})

// ---------------------------------------------------------------------------
// renderReportHtml snapshot-style assertions
// ---------------------------------------------------------------------------

describe('renderReportHtml', () => {
  it('includes each required section and strategy name', async () => {
    const db = makeDb()
    const closedAt = SUN_APR_19_9AM_UTC - 2 * 86_400_000
    seedClosedTrade(db, {
      signalId: 'sig-h', decisionId: 'dec-h', strategyId: 'momentum-stocks',
      asset: 'AAPL', side: 'buy', sizeUsd: 100, pnlGross: 10, grade: 'A',
      closedAt,
    })
    const { weekStartMs, weekEndMs } = computeWeekBoundary(SUN_APR_19_9AM_UTC)
    const report = await buildReport(db, null, { weekStartMs, weekEndMs, nowMs: SUN_APR_19_9AM_UTC })
    const html = renderReportHtml(report)

    expect(html).toContain('Paw Trader Weekly Report')
    expect(html).toContain('NAV &amp; Equity Curve')
    expect(html).toContain('Per-Strategy Summary')
    expect(html).toContain('Verdict Breakdown')
    expect(html).toContain('Top 3 Best Trades')
    expect(html).toContain('Top 3 Worst Trades')
    expect(html).toContain('Committee Attribution Tally')
    expect(html).toContain('Kill-Switch Events')
    expect(html).toContain('momentum-stocks')
    // The asset should appear in best trades section.
    expect(html).toContain('AAPL')
    // The HTML must be a full doc.
    expect(html.startsWith('<!doctype html>')).toBe(true)
  })

  it('escapes hostile strategy id content', () => {
    const report: WeeklyReport = {
      weekStartMs: 0, weekEndMs: 1, generatedAtMs: 2,
      verdictCount: 0, winCount: 0, lossCount: 0, breakEvenCount: 0,
      winRate: 0, totalPnlNet: 0,
      bestTrades: [], worstTrades: [],
      strategyRollups: [{
        strategy_id: '<script>alert(1)</script>', trade_count: 1, win_count: 1,
        rolling_sharpe: 0.1, avg_winner_pct: 0.05, avg_loser_pct: 0,
        max_dd_pct: 0, net_pnl_usd: 10, computed_at: 0,
      }],
      gradeBreakdown: { A: 0, B: 0, C: 0, D: 0 },
      attribution: {},
      nav: { weekOpen: null, weekClose: null, deltaUsd: null, deltaPct: null, snapshotCount: 0, available: false, unavailableReason: 'test' },
      killSwitchEvents: [],
      killSwitchLog: [],
    }
    const html = renderReportHtml(report)
    expect(html).not.toContain('<script>alert(1)</script>')
    expect(html).toContain('&lt;script&gt;')
  })
})

// ---------------------------------------------------------------------------
// renderReportSummary
// ---------------------------------------------------------------------------

describe('renderReportSummary', () => {
  async function buildSampleReport(): Promise<WeeklyReport> {
    const db = makeDb()
    const closedAt = SUN_APR_19_9AM_UTC - 2 * 86_400_000
    seedClosedTrade(db, {
      signalId: 's-s', decisionId: 'd-s', strategyId: 'momentum-stocks',
      asset: 'AAPL', side: 'buy', sizeUsd: 100, pnlGross: 25, grade: 'A',
      closedAt,
    })
    seedClosedTrade(db, {
      signalId: 's-l', decisionId: 'd-l', strategyId: 'momentum-stocks',
      asset: 'TSLA', side: 'buy', sizeUsd: 100, pnlGross: -15, grade: 'D',
      closedAt: closedAt + 1000,
    })
    const { weekStartMs, weekEndMs } = computeWeekBoundary(SUN_APR_19_9AM_UTC)
    return buildReport(db, null, { weekStartMs, weekEndMs, nowMs: SUN_APR_19_9AM_UTC })
  }

  it('is under 400 chars, no em dashes, no HTML, no markdown markers', async () => {
    const report = await buildSampleReport()
    const summary = renderReportSummary(report)
    expect(summary.length).toBeLessThanOrEqual(400)
    expect(summary).not.toContain('\u2014') // em dash
    expect(summary).not.toContain('<')
    expect(summary).not.toContain('**')
    expect(summary).not.toMatch(/\*[A-Za-z]/)
    expect(summary).not.toMatch(/^#/m)
  })

  it('leads with NAV and win rate', async () => {
    const report = await buildSampleReport()
    const summary = renderReportSummary(report)
    expect(summary).toContain('NAV:')
    expect(summary).toContain('Win rate:')
    expect(summary.toLowerCase().indexOf('nav'))
      .toBeLessThan(summary.toLowerCase().indexOf('verdicts'))
  })

  it('survives an empty report with no trades', async () => {
    const db = makeDb()
    const { weekStartMs, weekEndMs } = computeWeekBoundary(SUN_APR_19_9AM_UTC)
    const report = await buildReport(db, null, { weekStartMs, weekEndMs })
    const summary = renderReportSummary(report)
    expect(summary).toContain('Verdicts: 0')
    expect(summary.length).toBeLessThanOrEqual(400)
  })
})

// ---------------------------------------------------------------------------
// saveReport
// ---------------------------------------------------------------------------

describe('saveReport', () => {
  let tmpDir: string
  beforeEach(() => {
    tmpDir = path.join(os.tmpdir(), `trader-report-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    mkdirSync(tmpDir, { recursive: true })
  })
  afterEach(() => {
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true })
  })

  it('writes a file with YYYY-MM-DD stamp and returns an absolute path', () => {
    const html = '<html>test</html>'
    const abs = saveReport(html, SUN_APR_19_9AM_UTC - 7 * 86_400_000, tmpDir)
    expect(path.isAbsolute(abs)).toBe(true)
    const stamp = formatDate(SUN_APR_19_9AM_UTC - 7 * 86_400_000)
    expect(abs).toContain(`trader-weekly-${stamp}.html`)
    expect(readFileSync(abs, 'utf8')).toBe(html)
  })

  it('creates the reports directory when missing', () => {
    const nested = path.join(tmpDir, 'nested', 'sub', 'dir')
    const abs = saveReport('<html>ok</html>', SUN_APR_19_9AM_UTC - 7 * 86_400_000, nested)
    expect(existsSync(abs)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Scheduler gate (kv_settings + fire detection)
// ---------------------------------------------------------------------------

describe('scheduler gate', () => {
  let db: ReturnType<typeof makeDb>
  let tmpDir: string
  let sendMock: ReturnType<typeof vi.fn>

  /** Typed wrapper so `deps.send` matches its `(text: string) => Promise<void>` signature. */
  const send = (text: string): Promise<void> =>
    (sendMock as unknown as (text: string) => Promise<void>)(text)

  beforeEach(() => {
    db = makeDb()
    tmpDir = path.join(os.tmpdir(), `trader-report-gate-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    mkdirSync(tmpDir, { recursive: true })
    sendMock = vi.fn().mockResolvedValue(undefined)
  })

  afterEach(() => {
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true })
  })

  it('readLastFireMs returns null when no row exists', () => {
    expect(readLastFireMs(db)).toBeNull()
  })

  it('writeLastFireMs + readLastFireMs roundtrip', () => {
    writeLastFireMs(db, 3333333330)
    expect(readLastFireMs(db)).toBe(3333333330)
  })

  it('maybeFireWeeklyReport is a no-op on Saturday (outside grace)', async () => {
    const sat = Date.UTC(2026, 3, 18, 23, 0, 0, 0) // Sat 7pm ET
    const out = await maybeFireWeeklyReport({
      db, engineClient: null, send, nowMs: sat, reportsDir: tmpDir,
    })
    expect(out.fired).toBe(false)
    expect(sendMock).not.toHaveBeenCalled()
  })

  it('maybeFireWeeklyReport fires exactly once across Sat->Sun 8:59->Sun 9:01', async () => {
    // Sat 7pm ET -> before fire point for this week, grace already passed for
    // prior week, so no fire.
    const sat_evening = Date.UTC(2026, 3, 18, 23, 0, 0, 0)
    // 8:59 am ET Sunday -> still before this Sunday's fire point, prior
    // Sunday's fire point is 7 days ago (past grace), no fire.
    const sun_859 = SUN_APR_19_9AM_UTC - 60_000
    // 9:01 am ET Sunday -> inside the 12h grace, no prior fire -> fire.
    const sun_901 = SUN_APR_19_9AM_UTC + 60_000

    // Seed a trade so the report has content.
    const closedAt = SUN_APR_19_9AM_UTC - 2 * 86_400_000
    seedClosedTrade(db, {
      signalId: 's-g', decisionId: 'd-g', strategyId: 'momentum-stocks',
      asset: 'AAPL', side: 'buy', sizeUsd: 100, pnlGross: 10, grade: 'A',
      closedAt,
    })

    const r1 = await maybeFireWeeklyReport({ db, engineClient: null, send, nowMs: sat_evening, reportsDir: tmpDir })
    expect(r1.fired).toBe(false)

    const r2 = await maybeFireWeeklyReport({ db, engineClient: null, send, nowMs: sun_859, reportsDir: tmpDir })
    expect(r2.fired).toBe(false)

    const r3 = await maybeFireWeeklyReport({ db, engineClient: null, send, nowMs: sun_901, reportsDir: tmpDir })
    expect(r3.fired).toBe(true)
    expect(r3.path).toBeDefined()
    expect(existsSync(r3.path!)).toBe(true)
    expect(sendMock).toHaveBeenCalledTimes(1)
    // Plain-text, no parse_mode would be passed; verify the send text
    // is a string under ~450 chars (summary + path line).
    const sent = sendMock.mock.calls[0][0] as string
    expect(typeof sent).toBe('string')
    expect(sent).toContain('Paw Trader weekly report')
    expect(sent).toContain('Report:')
  })

  it('second fire attempt in the same window is a no-op', async () => {
    const sun_901 = SUN_APR_19_9AM_UTC + 60_000
    const sun_1001 = SUN_APR_19_9AM_UTC + 61 * 60_000

    const r1 = await maybeFireWeeklyReport({ db, engineClient: null, send, nowMs: sun_901, reportsDir: tmpDir })
    expect(r1.fired).toBe(true)

    const r2 = await maybeFireWeeklyReport({ db, engineClient: null, send, nowMs: sun_1001, reportsDir: tmpDir })
    expect(r2.fired).toBe(false)
    expect(sendMock).toHaveBeenCalledTimes(1)
  })

  it('records kv_settings row after firing', async () => {
    const sun_901 = SUN_APR_19_9AM_UTC + 60_000
    await maybeFireWeeklyReport({ db, engineClient: null, send, nowMs: sun_901, reportsDir: tmpDir })
    const row = db.prepare('SELECT value FROM kv_settings WHERE key = ?').get(WEEKLY_REPORT_KV_KEY) as { value: string } | undefined
    expect(row).toBeDefined()
    expect(Number(row!.value)).toBe(sun_901)
  })
})

// ===========================================================================
// Phase 5 Task 3 -- kill-switch log surfaces in the weekly report
// ===========================================================================

describe('Phase 5 Task 3 -- weekly report kill-switch log integration', () => {
  function makeEntry(
    overrides: Partial<KillSwitchLogEntry> & Pick<KillSwitchLogEntry, 'toggled_at_ms' | 'new_state'>,
  ): KillSwitchLogEntry {
    return {
      id: overrides.id ?? Math.floor(Math.random() * 1_000_000),
      toggled_at_ms: overrides.toggled_at_ms,
      new_state: overrides.new_state,
      reason: overrides.reason ?? null,
      set_by: overrides.set_by ?? null,
    }
  }

  it('renderReportHtml renders 2 toggles as a table with date, state, reason, operator', async () => {
    const db = makeDb()
    const { weekStartMs, weekEndMs } = computeWeekBoundary(SUN_APR_19_9AM_UTC)
    const log: KillSwitchLogEntry[] = [
      makeEntry({
        toggled_at_ms: weekStartMs + 2 * 86_400_000,
        new_state: 'active',
        reason: 'cleared',
        set_by: 'operator',
      }),
      makeEntry({
        toggled_at_ms: weekStartMs + 1 * 86_400_000,
        new_state: 'tripped',
        reason: 'cost spike',
        set_by: 'operator',
      }),
    ]
    const fetchKillSwitchLog = vi.fn().mockResolvedValue(log)
    const report = await buildReport(
      db, null,
      { weekStartMs, weekEndMs, nowMs: SUN_APR_19_9AM_UTC },
      { fetchKillSwitchLog },
    )
    expect(report.killSwitchLog.length).toBe(2)
    expect(fetchKillSwitchLog).toHaveBeenCalledWith(weekStartMs, weekEndMs)

    const html = renderReportHtml(report)
    // New log section heading is distinct from the Phase 4 singleton
    // heading ("Kill-Switch Events") so an operator skim never sees two
    // near-identical titles in a row.
    expect(html).toContain('Kill switch toggles (this week)')
    expect(html).toContain('<th>Toggled at</th>')
    expect(html).toContain('<th>State</th>')
    expect(html).toContain('<th>Reason</th>')
    expect(html).toContain('<th>Operator</th>')
    expect(html).toContain('Tripped')
    expect(html).toContain('Cleared')
    expect(html).toContain('cost spike')
    expect(html).toContain('operator')
  })

  it('renderReportHtml renders "No kill-switch events this week." when empty', async () => {
    const db = makeDb()
    const { weekStartMs, weekEndMs } = computeWeekBoundary(SUN_APR_19_9AM_UTC)
    const fetchKillSwitchLog = vi.fn().mockResolvedValue([])
    const report = await buildReport(
      db, null,
      { weekStartMs, weekEndMs, nowMs: SUN_APR_19_9AM_UTC },
      { fetchKillSwitchLog },
    )
    expect(report.killSwitchLog).toEqual([])
    const html = renderReportHtml(report)
    expect(html).toContain('No kill-switch events this week.')
    // No table headers should leak through when the section is empty.
    expect(html).not.toContain('<th>Toggled at</th>')
  })

  it('renderReportSummary -> 0 toggles produces "Kill switch: clean (no toggles)"', async () => {
    const db = makeDb()
    const { weekStartMs, weekEndMs } = computeWeekBoundary(SUN_APR_19_9AM_UTC)
    const report = await buildReport(
      db, null,
      { weekStartMs, weekEndMs, nowMs: SUN_APR_19_9AM_UTC },
      { fetchKillSwitchLog: () => Promise.resolve([]) },
    )
    const summary = renderReportSummary(report)
    expect(summary).toContain('Kill switch: clean (no toggles)')
  })

  it('renderReportSummary -> 3 toggles includes "toggled 3 times" + most recent state + reason', async () => {
    const db = makeDb()
    const { weekStartMs, weekEndMs } = computeWeekBoundary(SUN_APR_19_9AM_UTC)
    const log: KillSwitchLogEntry[] = [
      makeEntry({ toggled_at_ms: weekStartMs + 3 * 86_400_000, new_state: 'tripped', reason: 'manual halt' }),
      makeEntry({ toggled_at_ms: weekStartMs + 2 * 86_400_000, new_state: 'active',  reason: 'cleared' }),
      makeEntry({ toggled_at_ms: weekStartMs + 1 * 86_400_000, new_state: 'tripped', reason: 'cost spike' }),
    ]
    const report = await buildReport(
      db, null,
      { weekStartMs, weekEndMs, nowMs: SUN_APR_19_9AM_UTC },
      { fetchKillSwitchLog: () => Promise.resolve(log) },
    )
    const summary = renderReportSummary(report)
    expect(summary).toContain('toggled 3 times')
    expect(summary).toContain('tripped')
    expect(summary).toContain('manual halt')
  })

  it('fetchKillSwitchLog throwing -> section omitted, rest of report still renders', async () => {
    const db = makeDb()
    const closedAt = SUN_APR_19_9AM_UTC - 2 * 86_400_000
    seedClosedTrade(db, {
      signalId: 's-kg', decisionId: 'd-kg', strategyId: 'momentum-stocks',
      asset: 'AAPL', side: 'buy', sizeUsd: 100, pnlGross: 10, grade: 'A',
      closedAt,
    })
    const { weekStartMs, weekEndMs } = computeWeekBoundary(SUN_APR_19_9AM_UTC)
    const fetchKillSwitchLog = vi.fn().mockRejectedValue(new Error('server down'))
    const report = await buildReport(
      db, null,
      { weekStartMs, weekEndMs, nowMs: SUN_APR_19_9AM_UTC },
      { fetchKillSwitchLog },
    )
    expect(report.killSwitchLog).toEqual([])
    const html = renderReportHtml(report)
    expect(html).toContain('No kill-switch events this week.')
    // Rest of the report is intact -- best/worst trades, AAPL, etc.
    expect(html).toContain('AAPL')
    expect(html).toContain('momentum-stocks')
  })

  it('omitting the dep entirely yields an empty section without throwing', async () => {
    const db = makeDb()
    const { weekStartMs, weekEndMs } = computeWeekBoundary(SUN_APR_19_9AM_UTC)
    const report = await buildReport(db, null, { weekStartMs, weekEndMs, nowMs: SUN_APR_19_9AM_UTC })
    expect(report.killSwitchLog).toEqual([])
    const summary = renderReportSummary(report)
    expect(summary).toContain('Kill switch: clean (no toggles)')
  })
})
