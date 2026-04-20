/**
 * Phase 4 Task C -- Weekly trader report.
 *
 * Aggregates the past 7 days of trading activity (verdicts, track records,
 * committee attribution, NAV history, kill-switch state) into a structured
 * object, renders that to an HTML file on disk, and sends a short plain-text
 * Telegram summary via the scheduler's existing `send` hook.
 *
 * Scope decisions for v1 (documented here so future contributors do not
 * rehash them):
 *
 *  1. PDF rendering is deferred. Neither puppeteer nor playwright is
 *     installed today; the launchd bot environment has no headless browser
 *     wired in. HTML-only ships now. When the deploy story supports a
 *     headless browser (or a server-side PDF endpoint) the path forward is
 *     to reuse `renderReportHtml` and pipe the HTML into the browser in a
 *     sibling `saveReportPdf` helper.
 *
 *  2. Email is out of scope. There is no nodemailer dependency and the
 *     Gmail OAuth pipeline lives in `src/social-cli.ts`. Future work can
 *     wire the HTML into that pipeline (subject + HTML body, attachment).
 *     This module deliberately does not reach for that integration to keep
 *     the weekly report's hot path free of OAuth failure modes.
 *
 *  3. Kill-switch events are read as a singleton snapshot. The server
 *     `system_state` table stores only the current state, not a historical
 *     log. Until an append-only `kill_switch_log` table exists, the weekly
 *     report surfaces "no persisted event log" and, when the kill switch
 *     is currently active AND was set within the window, records a single
 *     event row. This is a faithful rendering of what the DB exposes.
 *
 * No LLM calls. Pure SQL + engine GETs + template-string HTML.
 */
import path from 'node:path'
import { mkdirSync, writeFileSync } from 'node:fs'
import type Database from 'better-sqlite3'
import { logger } from '../logger.js'
import { listTrackRecords, type StrategyTrackRecord } from './track-record.js'
import type { EngineClient } from './engine-client.js'
import type { NavSnapshot } from './types.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface VerdictRow {
  decision_id: string
  asset: string
  side: 'buy' | 'sell'
  strategy_id: string
  pnl_gross: number
  pnl_net: number
  pnl_pct: number
  bench_return: number
  hold_drawdown: number
  thesis_grade: 'A' | 'B' | 'C' | 'D'
  agent_attribution_json: string
  closed_at: number
}

export interface AttributionTally {
  /**
   * Number of closed verdicts where the given role+flag appeared. Keys
   * look like `trader.right`, `trader.wrong`, `risk_officer.vetoed`,
   * `risk_officer.right`. Role specialists (quant/fundamentalist/macro/
   * sentiment) just count appearances so the dashboard can show who
   * weighed in most often this week.
   */
  [roleAndTag: string]: number
}

export interface NavDelta {
  weekOpen: number | null
  weekClose: number | null
  deltaUsd: number | null
  deltaPct: number | null
  snapshotCount: number
  available: boolean
  unavailableReason?: string
}

export interface TopTrade {
  decision_id: string
  asset: string
  side: 'buy' | 'sell'
  strategy_id: string
  pnl_net: number
  pnl_pct: number
  thesis_grade: 'A' | 'B' | 'C' | 'D'
  closed_at: number
}

export interface KillSwitchEvent {
  kind: 'active_during_window' | 'no_log_available'
  set_at: number | null
  reason: string
  note: string
}

/**
 * One row of the server's `kill_switch_log` table as returned by
 * `GET /api/v1/trader/kill-switch-log`. Mirrors `KillSwitchLogEntry` in
 * `server/src/system-state.ts`.
 */
export interface KillSwitchLogEntry {
  id: number
  toggled_at_ms: number
  new_state: 'tripped' | 'active'
  reason: string | null
  set_by: string | null
}

export interface WeeklyReport {
  weekStartMs: number
  weekEndMs: number
  generatedAtMs: number
  verdictCount: number
  winCount: number
  lossCount: number
  breakEvenCount: number
  winRate: number
  totalPnlNet: number
  bestTrades: TopTrade[]
  worstTrades: TopTrade[]
  strategyRollups: StrategyTrackRecord[]
  gradeBreakdown: { A: number; B: number; C: number; D: number }
  attribution: AttributionTally
  nav: NavDelta
  killSwitchEvents: KillSwitchEvent[]
  /**
   * Phase 5 Task 3 -- newest-first list of operator toggles inside the
   * report window. Empty array means no transitions logged in-window.
   * Distinct from `killSwitchEvents` which surfaces the singleton state
   * at report time.
   */
  killSwitchLog: KillSwitchLogEntry[]
}

export interface BuildReportOptions {
  weekStartMs: number
  weekEndMs: number
  nowMs?: number
  killSwitch?: { active: boolean; set_at: number | null; reason: string } | null
}

/**
 * Optional dependency overrides for `buildReport`. Today only the
 * kill-switch log fetch is injectable; existing data sources still
 * thread directly off the `db` and `engineClient` arguments.
 */
export interface BuildReportDeps {
  /**
   * Fetch the kill-switch log for the given window. The default
   * implementation in `maybeFireWeeklyReport` hits the server's
   * `/api/v1/trader/kill-switch-log` endpoint with the bot's admin
   * token. Returning [] (or throwing) leaves the report's kill-switch
   * section degraded to the "no events this week" line; the rest of
   * the report still renders.
   */
  fetchKillSwitchLog?: (since_ms: number, until_ms: number) => Promise<KillSwitchLogEntry[]>
}

// ---------------------------------------------------------------------------
// Week boundary math
// ---------------------------------------------------------------------------

/**
 * Compute the most recently completed weekly reporting window, anchored
 * to America/New_York. A window starts at Sunday 00:00 NY and ends at
 * the following Saturday 23:59:59.999 NY. The 9am Sunday firing refers
 * to the window that just finished (Sun -> Sat prior).
 *
 * This intentionally does NOT use a library. We format the `nowMs`
 * instant into `America/New_York` parts via `Intl.DateTimeFormat` and
 * reconstruct the boundary as the UTC ms that correspond to
 * "Sunday 00:00 in that zone". That means the boundary respects DST
 * transitions without importing `date-fns-tz` or friends.
 */
export function computeWeekBoundary(nowMs: number): {
  weekStartMs: number
  weekEndMs: number
} {
  const parts = nyParts(nowMs)
  // JS Date.UTC treats getUTCDay-equivalent mapping: 0=Sun..6=Sat.
  // We want the Sunday strictly before the current NY instant when
  // fired from Sunday 9am, and the Sunday exactly one week earlier as
  // the report's start. To get there deterministically:
  //   - days_since_last_sunday = parts.weekday  (0 if already Sun in NY)
  //   - endOfWindow  = last Saturday 23:59:59.999 NY
  //   - startOfWindow = seven days earlier = prior Sunday 00:00 NY
  const daysSinceSunday = parts.weekday
  // Anchor at NY midnight of the current day, then subtract days.
  const todayMidnightNyMs = nyMidnightMs(parts.year, parts.month, parts.day)
  const lastSundayMidnightMs = todayMidnightNyMs - daysSinceSunday * 86_400_000
  const priorSundayMidnightMs = lastSundayMidnightMs - 7 * 86_400_000
  return {
    weekStartMs: priorSundayMidnightMs,
    weekEndMs: lastSundayMidnightMs - 1,
  }
}

interface NyParts {
  year: number
  month: number
  day: number
  hour: number
  minute: number
  /** 0 = Sunday, 6 = Saturday (America/New_York local). */
  weekday: number
  /** Offset in minutes (negative west of UTC). For NY: -240 in EDT, -300 in EST. */
  dstOffsetMin: number
}

/**
 * Extract NY-local calendar parts for a UTC instant. Uses Intl to avoid
 * pulling in a tz library. The caller uses weekday + day to compute
 * Sunday boundaries.
 */
function nyParts(utcMs: number): NyParts {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    weekday: 'short',
    hour12: false,
  })
  const partsArr = fmt.formatToParts(new Date(utcMs))
  const get = (t: string): string => partsArr.find(p => p.type === t)?.value ?? ''
  const year = parseInt(get('year'), 10)
  const month = parseInt(get('month'), 10)
  const day = parseInt(get('day'), 10)
  // Intl's "hour" can be "24" at midnight in some locales; normalize to 0.
  const hourRaw = parseInt(get('hour'), 10)
  const hour = Number.isFinite(hourRaw) ? hourRaw % 24 : 0
  const minute = parseInt(get('minute'), 10)
  const wdStr = get('weekday') // Sun/Mon/... in en-US
  const wdMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }
  const weekday = wdMap[wdStr] ?? 0
  // DST offset: compute by diffing NY local clock from UTC.
  const utcDate = new Date(utcMs)
  const nyAsUtcMs = Date.UTC(year, month - 1, day, hour, minute, utcDate.getUTCSeconds(), utcDate.getUTCMilliseconds())
  const dstOffsetMin = Math.round((nyAsUtcMs - utcMs) / 60_000)
  return { year, month, day, hour, minute, weekday, dstOffsetMin }
}

/**
 * Reconstruct the UTC ms for "YYYY-MM-DD 00:00 in America/New_York".
 *
 * DST-safe: the offset applicable at midnight of a given day can differ
 * from the offset at other times of the same day (e.g. on spring-forward
 * Sunday the clock is EST at midnight but EDT by 9am; on fall-back
 * Sunday it is EDT at midnight but EST by 9am). We therefore probe the
 * NY offset at 05:00 UTC of the target day, which is always pre-DST
 * transition locally (00:00 EST or 01:00 EDT, well before the 02:00
 * local DST switch) AND always on the target NY calendar day.
 */
function nyMidnightMs(year: number, month: number, day: number): number {
  const utcMidnight = Date.UTC(year, month - 1, day, 0, 0, 0, 0)
  // 05:00 UTC on the target day: always pre-2am-local, always same day.
  const probeUtc = utcMidnight + 5 * 60 * 60_000
  const probeParts = nyParts(probeUtc)
  // probeParts.dstOffsetMin is negative west of UTC. Subtracting it
  // from UTC midnight shifts forward by |offset|, giving the UTC ms
  // that corresponds to NY-local midnight.
  return utcMidnight - probeParts.dstOffsetMin * 60_000
}

// ---------------------------------------------------------------------------
// Data fetchers
// ---------------------------------------------------------------------------

/**
 * Pull verdicts closed within [weekStartMs, weekEndMs]. Joins back to
 * signals and decisions to recover asset/side/strategy_id and derive
 * pnl_pct from decision.size_usd. The caller downstream filters and
 * ranks these.
 */
export function listVerdictsInWindow(
  db: Database.Database,
  weekStartMs: number,
  weekEndMs: number,
): VerdictRow[] {
  const rows = db.prepare(`
    SELECT
      v.decision_id       AS decision_id,
      d.asset             AS asset,
      s.side              AS side,
      s.strategy_id       AS strategy_id,
      v.pnl_gross         AS pnl_gross,
      v.pnl_net           AS pnl_net,
      CASE WHEN COALESCE(d.size_usd, 0) > 0 THEN v.pnl_gross / d.size_usd ELSE 0 END AS pnl_pct,
      v.bench_return      AS bench_return,
      v.hold_drawdown     AS hold_drawdown,
      v.thesis_grade      AS thesis_grade,
      v.agent_attribution_json AS agent_attribution_json,
      v.closed_at         AS closed_at
    FROM trader_verdicts v
    JOIN trader_decisions d ON d.id = v.decision_id
    JOIN trader_signals   s ON s.id = d.signal_id
    WHERE v.closed_at >= ? AND v.closed_at <= ?
    ORDER BY v.closed_at ASC
  `).all(weekStartMs, weekEndMs) as VerdictRow[]
  return rows
}

/**
 * Summarize agent_attribution_json across the window's verdicts.
 * `trader.right/wrong` count closed verdicts where the trader's action
 * was correct. `risk_officer.vetoed` counts vetoes that still produced
 * a verdict (impossible today -- if risk vetoed, no trade executed --
 * left in for future extension). Specialist keys (quant/fundamentalist
 * etc.) count plain appearances.
 */
export function tallyAttribution(verdicts: VerdictRow[]): AttributionTally {
  const tally: AttributionTally = {}
  const bump = (key: string): void => {
    tally[key] = (tally[key] ?? 0) + 1
  }
  for (const v of verdicts) {
    let parsed: Array<{ role: string; data: Record<string, unknown> }> = []
    try {
      parsed = JSON.parse(v.agent_attribution_json) as typeof parsed
    } catch {
      continue
    }
    for (const entry of parsed) {
      if (!entry?.role) continue
      if (entry.role === 'trader') {
        bump(entry.data?.right ? 'trader.right' : 'trader.wrong')
      } else if (entry.role === 'risk_officer') {
        if (entry.data?.vetoed) bump('risk_officer.vetoed')
        else bump(entry.data?.right ? 'risk_officer.right' : 'risk_officer.wrong')
      } else {
        bump(`${entry.role}.appearance`)
      }
    }
  }
  return tally
}

/**
 * Compute NAV delta by asking the engine for the most recent 30 NAV
 * snapshots and filtering to the report window. Engine-unreachable and
 * insufficient-data both fall through to `available=false` with a
 * human-readable reason. The HTML renderer shows "NAV unavailable"
 * in that case.
 *
 * Shape of the delta:
 *   weekOpen  = nav of the earliest `day_open` snapshot within window
 *   weekClose = nav of the latest `day_close` snapshot within window
 *   delta_pct = (close - open) / open
 */
export async function fetchNavDelta(
  engineClient: EngineClient | null,
  weekStartMs: number,
  weekEndMs: number,
): Promise<NavDelta> {
  if (!engineClient) {
    return {
      weekOpen: null,
      weekClose: null,
      deltaUsd: null,
      deltaPct: null,
      snapshotCount: 0,
      available: false,
      unavailableReason: 'engine client unavailable',
    }
  }
  let snapshots: NavSnapshot[] = []
  try {
    snapshots = await engineClient.getNavSnapshots(60)
  } catch (err) {
    logger.warn({ err }, 'Weekly report: NAV snapshot fetch failed')
    return {
      weekOpen: null,
      weekClose: null,
      deltaUsd: null,
      deltaPct: null,
      snapshotCount: 0,
      available: false,
      unavailableReason: 'engine NAV endpoint unreachable',
    }
  }
  const within = snapshots.filter(s => s.recorded_at >= weekStartMs && s.recorded_at <= weekEndMs)
  const opens = within.filter(s => s.period === 'day_open').sort((a, b) => a.recorded_at - b.recorded_at)
  const closes = within.filter(s => s.period === 'day_close').sort((a, b) => a.recorded_at - b.recorded_at)
  if (opens.length === 0 || closes.length === 0) {
    return {
      weekOpen: null,
      weekClose: null,
      deltaUsd: null,
      deltaPct: null,
      snapshotCount: within.length,
      available: false,
      unavailableReason: 'NAV not yet populated',
    }
  }
  const weekOpen = opens[0].nav
  const weekClose = closes[closes.length - 1].nav
  const deltaUsd = weekClose - weekOpen
  const deltaPct = weekOpen !== 0 ? deltaUsd / weekOpen : 0
  return {
    weekOpen,
    weekClose,
    deltaUsd,
    deltaPct,
    snapshotCount: within.length,
    available: true,
  }
}

// ---------------------------------------------------------------------------
// buildReport -- the main aggregator
// ---------------------------------------------------------------------------

/**
 * Compose the full report object. Pure data only -- no HTML, no disk IO.
 * Every sub-fetch is guarded so a failure in one data source still
 * produces a report, with the affected section degraded to its "no data"
 * state.
 */
export async function buildReport(
  db: Database.Database,
  engineClient: EngineClient | null,
  opts: BuildReportOptions,
  deps?: BuildReportDeps,
): Promise<WeeklyReport> {
  const nowMs = opts.nowMs ?? Date.now()
  const { weekStartMs, weekEndMs } = opts

  const verdicts = safeListVerdicts(db, weekStartMs, weekEndMs)

  const verdictCount = verdicts.length
  let winCount = 0
  let lossCount = 0
  let breakEvenCount = 0
  let totalPnlNet = 0
  const gradeBreakdown = { A: 0, B: 0, C: 0, D: 0 }
  for (const v of verdicts) {
    totalPnlNet += v.pnl_net
    if (v.pnl_gross > 0) winCount += 1
    else if (v.pnl_gross < 0) lossCount += 1
    else breakEvenCount += 1
    if (v.thesis_grade in gradeBreakdown) {
      gradeBreakdown[v.thesis_grade] += 1
    }
  }
  const winRate = verdictCount > 0 ? winCount / verdictCount : 0

  const bestTrades = pickTopTrades(verdicts, 3, 'best')
  const worstTrades = pickTopTrades(verdicts, 3, 'worst')

  const strategyRollups = safeListTrackRecords(db)
  const attribution = tallyAttribution(verdicts)
  const nav = await fetchNavDelta(engineClient, weekStartMs, weekEndMs)
  const killSwitchEvents = buildKillSwitchEvents(opts.killSwitch ?? null, weekStartMs, weekEndMs)
  const killSwitchLog = await safeFetchKillSwitchLog(deps?.fetchKillSwitchLog, weekStartMs, weekEndMs)

  return {
    weekStartMs,
    weekEndMs,
    generatedAtMs: nowMs,
    verdictCount,
    winCount,
    lossCount,
    breakEvenCount,
    winRate,
    totalPnlNet,
    bestTrades,
    worstTrades,
    strategyRollups,
    gradeBreakdown,
    attribution,
    nav,
    killSwitchEvents,
    killSwitchLog,
  }
}

/**
 * Phase 5 Task 3 -- pull the kill-switch log for the report window.
 * Returns [] when the dep is unset (legacy callers), when the fetch
 * throws, or when the server returns garbage. The rest of the report
 * is unaffected; the renderer collapses to "No kill-switch events
 * this week." in the empty case.
 */
async function safeFetchKillSwitchLog(
  fetcher: BuildReportDeps['fetchKillSwitchLog'],
  weekStartMs: number,
  weekEndMs: number,
): Promise<KillSwitchLogEntry[]> {
  if (!fetcher) return []
  try {
    const out = await fetcher(weekStartMs, weekEndMs)
    return Array.isArray(out) ? out : []
  } catch (err) {
    logger.warn({ err }, 'Weekly report: kill-switch log fetch failed; section will be empty')
    return []
  }
}

function safeListVerdicts(
  db: Database.Database,
  weekStartMs: number,
  weekEndMs: number,
): VerdictRow[] {
  try {
    return listVerdictsInWindow(db, weekStartMs, weekEndMs)
  } catch (err) {
    logger.warn({ err }, 'Weekly report: listVerdictsInWindow failed; continuing with []')
    return []
  }
}

function safeListTrackRecords(db: Database.Database): StrategyTrackRecord[] {
  try {
    return listTrackRecords(db)
  } catch (err) {
    logger.warn({ err }, 'Weekly report: listTrackRecords failed; continuing with []')
    return []
  }
}

function pickTopTrades(verdicts: VerdictRow[], k: number, mode: 'best' | 'worst'): TopTrade[] {
  const sorted = verdicts.slice().sort((a, b) =>
    mode === 'best' ? b.pnl_net - a.pnl_net : a.pnl_net - b.pnl_net,
  )
  return sorted.slice(0, k).map(v => ({
    decision_id: v.decision_id,
    asset: v.asset,
    side: v.side,
    strategy_id: v.strategy_id,
    pnl_net: v.pnl_net,
    pnl_pct: v.pnl_pct,
    thesis_grade: v.thesis_grade,
    closed_at: v.closed_at,
  }))
}

function buildKillSwitchEvents(
  ks: { active: boolean; set_at: number | null; reason: string } | null,
  weekStartMs: number,
  weekEndMs: number,
): KillSwitchEvent[] {
  // Current implementation: read `system_state` singleton only. When the
  // kill switch is currently active and was set inside the window,
  // surface it as one event. Future: replace with a real append-only
  // kill_switch_log table that records every set+clear transition.
  if (!ks || !ks.active) {
    return [
      {
        kind: 'no_log_available',
        set_at: null,
        reason: '',
        note: 'kill switch inactive at report time; no persisted event log for this window',
      },
    ]
  }
  if (ks.set_at !== null && ks.set_at >= weekStartMs && ks.set_at <= weekEndMs) {
    return [
      {
        kind: 'active_during_window',
        set_at: ks.set_at,
        reason: ks.reason,
        note: 'kill switch was set during this window and remained active at report time',
      },
    ]
  }
  // Active but set outside window -- we still note it so the reader
  // knows trading was locked during the week.
  return [
    {
      kind: 'active_during_window',
      set_at: ks.set_at,
      reason: ks.reason,
      note: 'kill switch active at report time; was set before this window',
    },
  ]
}

// ---------------------------------------------------------------------------
// HTML renderer
// ---------------------------------------------------------------------------

/**
 * Turn a WeeklyReport into a self-contained HTML string with inline CSS.
 * No external assets or template library; the doc is meant to open
 * directly from disk. The sections mirror the report data object so
 * every field has a visible home.
 */
export function renderReportHtml(report: WeeklyReport): string {
  const dateRange = `${formatDate(report.weekStartMs)} to ${formatDate(report.weekEndMs)}`
  const generated = formatDateTime(report.generatedAtMs)

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Paw Trader Weekly Report -- ${escapeHtml(dateRange)}</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Helvetica, Arial, sans-serif; color: #1b1b1f; background: #f7f7f9; margin: 0; padding: 24px; }
  h1 { margin: 0 0 4px; font-size: 24px; color: #0f172a; }
  h2 { margin: 24px 0 8px; font-size: 18px; color: #0f172a; border-bottom: 1px solid #e5e7eb; padding-bottom: 4px; }
  .container { max-width: 960px; margin: 0 auto; background: #fff; padding: 32px; border-radius: 8px; box-shadow: 0 1px 3px rgba(0,0,0,0.08); }
  .muted { color: #64748b; font-size: 12px; }
  table { width: 100%; border-collapse: collapse; margin-top: 8px; font-size: 14px; }
  th, td { padding: 8px 10px; border-bottom: 1px solid #e5e7eb; text-align: left; vertical-align: top; }
  th { background: #f1f5f9; font-weight: 600; color: #334155; }
  .pos { color: #047857; font-weight: 600; }
  .neg { color: #b91c1c; font-weight: 600; }
  .kpi-row { display: flex; gap: 12px; flex-wrap: wrap; margin: 12px 0; }
  .kpi { flex: 1 1 150px; background: #f8fafc; padding: 10px 12px; border-radius: 6px; border: 1px solid #e2e8f0; }
  .kpi .label { font-size: 11px; text-transform: uppercase; color: #64748b; letter-spacing: 0.04em; }
  .kpi .value { font-size: 18px; font-weight: 700; color: #0f172a; margin-top: 2px; }
  .unavailable { color: #92400e; background: #fef3c7; padding: 8px 12px; border-radius: 4px; border: 1px solid #fbbf24; }
  footer { margin-top: 32px; color: #64748b; font-size: 12px; text-align: center; }
</style>
</head>
<body>
<div class="container">
  <h1>Paw Trader Weekly Report</h1>
  <div class="muted">Window: ${escapeHtml(dateRange)} (America/New_York) &middot; Generated ${escapeHtml(generated)}</div>

  <div class="kpi-row">
    <div class="kpi"><div class="label">Verdicts</div><div class="value">${report.verdictCount}</div></div>
    <div class="kpi"><div class="label">Win rate</div><div class="value">${formatPct(report.winRate)}</div></div>
    <div class="kpi"><div class="label">Net P&amp;L</div><div class="value ${pnlClass(report.totalPnlNet)}">${formatUsd(report.totalPnlNet)}</div></div>
    <div class="kpi"><div class="label">Wins / Losses</div><div class="value">${report.winCount} / ${report.lossCount}</div></div>
  </div>

  <h2>NAV &amp; Equity Curve</h2>
  ${renderNavSection(report.nav)}

  <h2>Per-Strategy Summary</h2>
  ${renderStrategyTable(report.strategyRollups)}

  <h2>Verdict Breakdown</h2>
  ${renderGradeTable(report.gradeBreakdown, report.verdictCount)}

  <h2>Top 3 Best Trades</h2>
  ${renderTradeTable(report.bestTrades)}

  <h2>Top 3 Worst Trades</h2>
  ${renderTradeTable(report.worstTrades)}

  <h2>Committee Attribution Tally</h2>
  ${renderAttributionTable(report.attribution)}

  <h2>Kill-Switch Events</h2>
  ${renderKillSwitchSection(report.killSwitchEvents)}

  <h2>Kill switch toggles (this week)</h2>
  ${renderKillSwitchLogSection(report.killSwitchLog)}

  <footer>
    Paw Trader &middot; Report id ${escapeHtml(String(report.generatedAtMs))}
  </footer>
</div>
</body>
</html>`
}

function renderNavSection(nav: NavDelta): string {
  if (!nav.available) {
    return `<div class="unavailable">NAV unavailable: ${escapeHtml(nav.unavailableReason ?? 'unknown')}</div>`
  }
  const deltaClass = pnlClass(nav.deltaUsd ?? 0)
  return `<table>
    <tr><th>Week open NAV</th><td>${formatUsd(nav.weekOpen)}</td></tr>
    <tr><th>Week close NAV</th><td>${formatUsd(nav.weekClose)}</td></tr>
    <tr><th>Delta (USD)</th><td class="${deltaClass}">${formatUsd(nav.deltaUsd)}</td></tr>
    <tr><th>Delta (%)</th><td class="${deltaClass}">${formatPct(nav.deltaPct ?? 0)}</td></tr>
    <tr><th>Snapshots in window</th><td>${nav.snapshotCount}</td></tr>
  </table>`
}

function renderStrategyTable(rows: StrategyTrackRecord[]): string {
  if (rows.length === 0) {
    return `<div class="muted">No strategy track records yet.</div>`
  }
  const body = rows.map(r => `<tr>
    <td>${escapeHtml(r.strategy_id)}</td>
    <td>${r.trade_count}</td>
    <td>${r.win_count}</td>
    <td>${formatNum(r.rolling_sharpe, 3)}</td>
    <td>${formatPct(r.avg_winner_pct)}</td>
    <td>${formatPct(r.avg_loser_pct)}</td>
    <td class="${pnlClass(r.net_pnl_usd)}">${formatUsd(r.net_pnl_usd)}</td>
    <td>${formatPct(r.max_dd_pct)}</td>
  </tr>`).join('')
  return `<table>
    <tr><th>Strategy</th><th>Trades</th><th>Wins</th><th>Sharpe</th><th>Avg Winner</th><th>Avg Loser</th><th>Net PnL</th><th>Max DD</th></tr>
    ${body}
  </table>`
}

function renderGradeTable(grades: { A: number; B: number; C: number; D: number }, total: number): string {
  const row = (k: string, n: number): string =>
    `<tr><td>${k}</td><td>${n}</td><td>${formatPct(total > 0 ? n / total : 0)}</td></tr>`
  return `<table>
    <tr><th>Grade</th><th>Count</th><th>Share</th></tr>
    ${row('A', grades.A)}${row('B', grades.B)}${row('C', grades.C)}${row('D', grades.D)}
  </table>`
}

function renderTradeTable(trades: TopTrade[]): string {
  if (trades.length === 0) {
    return `<div class="muted">No trades to report.</div>`
  }
  const body = trades.map(t => `<tr>
    <td>${escapeHtml(t.asset)}</td>
    <td>${escapeHtml(t.side)}</td>
    <td>${escapeHtml(t.strategy_id)}</td>
    <td class="${pnlClass(t.pnl_net)}">${formatUsd(t.pnl_net)}</td>
    <td class="${pnlClass(t.pnl_pct)}">${formatPct(t.pnl_pct)}</td>
    <td>${escapeHtml(t.thesis_grade)}</td>
    <td>${escapeHtml(formatDate(t.closed_at))}</td>
  </tr>`).join('')
  return `<table>
    <tr><th>Asset</th><th>Side</th><th>Strategy</th><th>Net PnL</th><th>Return</th><th>Grade</th><th>Closed</th></tr>
    ${body}
  </table>`
}

function renderAttributionTable(tally: AttributionTally): string {
  const keys = Object.keys(tally).sort()
  if (keys.length === 0) {
    return `<div class="muted">No committee attribution data in this window.</div>`
  }
  const body = keys.map(k => `<tr><td>${escapeHtml(k)}</td><td>${tally[k]}</td></tr>`).join('')
  return `<table>
    <tr><th>Role / Tag</th><th>Count</th></tr>
    ${body}
  </table>`
}

function renderKillSwitchSection(events: KillSwitchEvent[]): string {
  if (events.length === 0) {
    return `<div class="muted">No events in window.</div>`
  }
  const body = events.map(e => `<tr>
    <td>${escapeHtml(e.kind)}</td>
    <td>${e.set_at === null ? '-' : escapeHtml(formatDateTime(e.set_at))}</td>
    <td>${escapeHtml(e.reason || '-')}</td>
    <td>${escapeHtml(e.note)}</td>
  </tr>`).join('')
  return `<table>
    <tr><th>Kind</th><th>Set at</th><th>Reason</th><th>Note</th></tr>
    ${body}
  </table>`
}

/**
 * Phase 5 Task 3 -- intra-week kill-switch toggles. Renders the rows
 * newest-first (matches the API). Empty list collapses to a single
 * line so the section header stays visible without a dangling table.
 */
function renderKillSwitchLogSection(entries: KillSwitchLogEntry[]): string {
  if (entries.length === 0) {
    return `<div class="muted">No kill-switch events this week.</div>`
  }
  const body = entries.map(e => `<tr>
    <td>${escapeHtml(formatDateTime(e.toggled_at_ms))}</td>
    <td>${escapeHtml(e.new_state === 'tripped' ? 'Tripped' : 'Cleared')}</td>
    <td>${escapeHtml(e.reason ?? '-')}</td>
    <td>${escapeHtml(e.set_by ?? '-')}</td>
  </tr>`).join('')
  return `<table>
    <tr><th>Toggled at</th><th>State</th><th>Reason</th><th>Operator</th></tr>
    ${body}
  </table>`
}

// ---------------------------------------------------------------------------
// Telegram summary renderer
// ---------------------------------------------------------------------------

/**
 * Build a plain-text Telegram summary. Lead with NAV delta + win rate;
 * fit under 400 chars so the bot's plain-text-only Telegram formatter
 * does not truncate mid-line. No em dashes, no markdown, no HTML. Safe
 * for ChannelManager.send.
 */
export function renderReportSummary(report: WeeklyReport): string {
  const parts: string[] = []
  parts.push('Paw Trader weekly report')
  const range = `${formatDate(report.weekStartMs)} to ${formatDate(report.weekEndMs)}`
  parts.push(range)

  if (report.nav.available) {
    const delta = formatUsd(report.nav.deltaUsd)
    const pct = formatPct(report.nav.deltaPct ?? 0)
    parts.push(`NAV: ${delta} (${pct})`)
  } else {
    parts.push('NAV: not yet populated')
  }

  parts.push(
    `Win rate: ${formatPct(report.winRate)} (${report.winCount}W / ${report.lossCount}L)`,
  )
  parts.push(`Net PnL: ${formatUsd(report.totalPnlNet)}`)
  parts.push(`Verdicts: ${report.verdictCount}`)

  const gradesCompact = `A:${report.gradeBreakdown.A} B:${report.gradeBreakdown.B} C:${report.gradeBreakdown.C} D:${report.gradeBreakdown.D}`
  parts.push(`Grades: ${gradesCompact}`)

  if (report.bestTrades.length > 0) {
    const t = report.bestTrades[0]
    parts.push(`Best: ${t.asset} ${t.side} ${formatUsd(t.pnl_net)}`)
  }
  if (report.worstTrades.length > 0 && report.worstTrades[0].pnl_net < 0) {
    const t = report.worstTrades[0]
    parts.push(`Worst: ${t.asset} ${t.side} ${formatUsd(t.pnl_net)}`)
  }

  // Phase 5 Task 3 -- kill-switch summary. 0 toggles is the normal
  // state and gets a clean line; 1+ shows the count plus the most
  // recent state and reason so the operator can scan the Telegram
  // ping without opening the HTML report.
  parts.push(formatKillSwitchSummary(report.killSwitchLog))

  // Join with " . " (period + space) so Telegram plain-text is scannable
  // on mobile without markdown line breaks. "em dashes never" rule kept.
  const summary = parts.join(' . ')
  // Defensive: enforce 400 char ceiling. Truncate at a word boundary.
  if (summary.length <= 400) return summary
  const clipped = summary.slice(0, 397)
  const lastSpace = clipped.lastIndexOf(' ')
  return (lastSpace > 0 ? clipped.slice(0, lastSpace) : clipped) + '...'
}

// ---------------------------------------------------------------------------
// Disk output
// ---------------------------------------------------------------------------

/**
 * Persist HTML to `workspace/trader-reports/trader-weekly-YYYY-MM-DD.html`
 * relative to `reportsDir` (defaults to `workspace/trader-reports/` at the
 * project root). Creates the directory if missing. Returns the absolute
 * path so the caller can include it in the Telegram summary.
 */
export function saveReport(
  html: string,
  weekStartMs: number,
  reportsDir?: string,
): string {
  const dir = reportsDir ?? path.resolve(process.cwd(), 'workspace', 'trader-reports')
  mkdirSync(dir, { recursive: true })
  const stamp = formatDate(weekStartMs)
  const fileName = `trader-weekly-${stamp}.html`
  const absPath = path.resolve(dir, fileName)
  writeFileSync(absPath, html, 'utf8')
  return absPath
}

// ---------------------------------------------------------------------------
// Scheduler gate
// ---------------------------------------------------------------------------

export const WEEKLY_REPORT_KV_KEY = 'trader.lastWeeklyReport'

/**
 * Grace window after the Sunday 09:00 NY fire point during which the
 * report is still eligible to fire. 12 hours is long enough that a
 * weekend of bot-down time (launchd flap, network outage) still fires
 * once when the bot returns, but short enough that a bot restarted on
 * Monday does not fire a stale report for the previous week.
 */
export const WEEKLY_REPORT_GRACE_MS = 12 * 60 * 60 * 1000

/**
 * True when the caller's `nowMs` sits inside the weekly firing grace
 * (Sunday 09:00 NY plus `WEEKLY_REPORT_GRACE_MS`) AND the prior fire
 * timestamp is older than the current fire point.
 *
 * Semantics:
 *  - Before the current week's Sunday 09:00 NY -> false (window hasn't
 *    crossed the boundary).
 *  - Inside the 12h grace and never fired for this boundary -> true.
 *  - Inside the grace but already fired (last fire >= fire point) -> false.
 *  - After the grace -> false (missed the window; wait for next Sunday).
 *
 * `lastFireMs` is the ms timestamp previously saved to kv_settings.
 * Passing null (no prior fire) allows the first Sunday post-launch to
 * fire if the bot started during the grace window. Outside the grace
 * the nullable path also returns false so a Wednesday restart does not
 * emit a stale report.
 */
export function shouldFireWeeklyReport(nowMs: number, lastFireMs: number | null): boolean {
  const fireAtMs = mostRecentFirePoint(nowMs)
  if (nowMs < fireAtMs) return false
  if (nowMs - fireAtMs > WEEKLY_REPORT_GRACE_MS) return false
  if (lastFireMs !== null && lastFireMs >= fireAtMs) return false
  return true
}

/**
 * Return the most recent Sunday 09:00 NY at or before `nowMs`. Used as
 * the canonical fire point for the gate. When called on Saturday the
 * answer is six days ago; when called on Sunday at 09:00 or later it is
 * today at 09:00 NY.
 *
 * Combined with WEEKLY_REPORT_GRACE_MS, this gives us "fire anywhere
 * inside Sunday 09:00 -- Sunday 21:00 NY" semantics.
 */
export function mostRecentFirePoint(nowMs: number): number {
  // NY-local parts of now.
  const parts = nyParts(nowMs)
  // NY midnight today (handles DST via the day's own offset).
  const todayMidnightNyMs = nyMidnightMs(parts.year, parts.month, parts.day)
  // Most recent Sunday NY midnight (0 if today is Sunday).
  const lastSundayMidnightMs = todayMidnightNyMs - parts.weekday * 86_400_000
  const sunday9amMs = lastSundayMidnightMs + 9 * 60 * 60 * 1000
  // If we're before today's 9am on Sunday, "most recent fire point" is
  // the previous Sunday 9am, not today's.
  if (nowMs < sunday9amMs) return sunday9amMs - 7 * 86_400_000
  return sunday9amMs
}

/** @deprecated alias kept for one release; use mostRecentFirePoint. */
export function nextFirePoint(nowMs: number): number {
  return mostRecentFirePoint(nowMs)
}

/**
 * Read the last-fired timestamp from a SQLite kv_settings row. Accepts
 * any better-sqlite3 handle so tests and production both work.
 * Returns null when the row is missing or the value isn't a number.
 */
export function readLastFireMs(db: Database.Database): number | null {
  try {
    const row = db
      .prepare('SELECT value FROM kv_settings WHERE key = ?')
      .get(WEEKLY_REPORT_KV_KEY) as { value: string } | undefined
    if (!row) return null
    const n = Number(row.value)
    return Number.isFinite(n) ? n : null
  } catch {
    return null
  }
}

/** Write the last-fired timestamp to kv_settings on the given db. */
export function writeLastFireMs(db: Database.Database, ms: number): void {
  db.prepare(`
    CREATE TABLE IF NOT EXISTS kv_settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `).run()
  db.prepare('INSERT OR REPLACE INTO kv_settings (key, value) VALUES (?, ?)')
    .run(WEEKLY_REPORT_KV_KEY, String(ms))
}

/**
 * High-level gate for the trader scheduler: checks the Sunday-9am
 * boundary, builds + saves the report, writes the summary via `send`,
 * and records the fire timestamp. Returns a status object so the tick
 * caller can log useful detail without needing to re-read the DB.
 *
 * Wrap in its own try/catch inside the scheduler so a failure here
 * never halts the other tick phases.
 */
export async function maybeFireWeeklyReport(args: {
  db: Database.Database
  engineClient: EngineClient | null
  send: (text: string) => Promise<void>
  nowMs?: number
  reportsDir?: string
  killSwitch?: { active: boolean; set_at: number | null; reason: string } | null
  /**
   * Phase 5 Task 3 -- inject a fetcher for the kill-switch log. The
   * scheduler hands in a fetcher that hits the server's
   * `/api/v1/trader/kill-switch-log` endpoint with the bot's admin
   * token. Tests can stub or omit. Omission -> empty section in the
   * report.
   */
  fetchKillSwitchLog?: (since_ms: number, until_ms: number) => Promise<KillSwitchLogEntry[]>
}): Promise<{ fired: boolean; reason?: string; path?: string }> {
  const nowMs = args.nowMs ?? Date.now()
  const lastFire = readLastFireMs(args.db)
  if (!shouldFireWeeklyReport(nowMs, lastFire)) {
    return { fired: false, reason: 'not time yet or already fired this week' }
  }
  const { weekStartMs, weekEndMs } = computeWeekBoundary(nowMs)
  const report = await buildReport(
    args.db,
    args.engineClient,
    {
      weekStartMs,
      weekEndMs,
      nowMs,
      killSwitch: args.killSwitch ?? null,
    },
    {
      fetchKillSwitchLog: args.fetchKillSwitchLog,
    },
  )
  const html = renderReportHtml(report)
  const filePath = saveReport(html, weekStartMs, args.reportsDir)
  const summary = renderReportSummary(report)
  // Include the file path on its own line so the operator can jump to it.
  // Plain text only; ChannelManager.send does not pass parse_mode.
  await args.send(`${summary}\nReport: ${filePath}`)
  writeLastFireMs(args.db, nowMs)
  return { fired: true, path: filePath }
}

// ---------------------------------------------------------------------------
// Formatters
// ---------------------------------------------------------------------------

/** YYYY-MM-DD in America/New_York. */
export function formatDate(ms: number): string {
  const parts = nyParts(ms)
  const m = String(parts.month).padStart(2, '0')
  const d = String(parts.day).padStart(2, '0')
  return `${parts.year}-${m}-${d}`
}

/** YYYY-MM-DD HH:MM ET. Time is always 24h. */
export function formatDateTime(ms: number): string {
  const parts = nyParts(ms)
  const m = String(parts.month).padStart(2, '0')
  const d = String(parts.day).padStart(2, '0')
  const h = String(parts.hour).padStart(2, '0')
  const min = String(parts.minute).padStart(2, '0')
  return `${parts.year}-${m}-${d} ${h}:${min} ET`
}

function formatUsd(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return '-'
  const sign = n < 0 ? '-' : ''
  const abs = Math.abs(n)
  return `${sign}$${abs.toFixed(2)}`
}

function formatPct(n: number): string {
  if (!Number.isFinite(n)) return '-'
  return `${(n * 100).toFixed(2)}%`
}

function formatNum(n: number, digits: number): string {
  if (!Number.isFinite(n)) return '-'
  return n.toFixed(digits)
}

function pnlClass(n: number): string {
  if (n > 0) return 'pos'
  if (n < 0) return 'neg'
  return ''
}

/**
 * Phase 5 Task 3 -- one-liner for the Telegram summary covering
 * kill-switch toggle activity.
 *
 *   0 toggles -> "Kill switch: clean (no toggles)"
 *   1+ toggles -> "Kill switch toggled N times this week. Most recent:
 *                  <state>, <reason>."
 *
 * `entries` is expected newest-first (matches the API). State is
 * mapped tripped -> "tripped" / active -> "cleared" so the wording
 * mirrors what a human operator would say.
 */
function formatKillSwitchSummary(entries: KillSwitchLogEntry[]): string {
  if (entries.length === 0) {
    return 'Kill switch: clean (no toggles)'
  }
  const newest = entries[0]
  const stateLabel = newest.new_state === 'tripped' ? 'tripped' : 'cleared'
  const reasonLabel = newest.reason ?? 'no reason'
  return `Kill switch toggled ${entries.length} times this week. Most recent: ${stateLabel}, ${reasonLabel}.`
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}
