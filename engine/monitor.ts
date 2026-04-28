/**
 * Phase 5 Task 2 -- trader monitor.
 *
 * Builds the alert checks that run after each committee decision tick.
 * The scheduler (trader-scheduler.ts Phase 6) wires every check into
 * the Telegram channel and calls recordAlertFired on the timestamp
 * variants once each alert ships.
 *
 * Alerts implemented in this file:
 *   2a. checkAbstainDigest             -- flags committee paralysis. Threshold:
 *       4 abstains in the past 24 hours. Dedup: 12 hours between fires so
 *       a spate of abstains does not spam Telegram. Pure read.
 *   2b. evaluateAndRecordSharpeFlip    -- flags an active strategy whose
 *       per-trade rolling_sharpe just went from >= 0 to < 0. No dedup; if
 *       the sharpe genuinely flips back and forth we want every change.
 *       MUTATES trader_alert_state every call (the name says so): the
 *       stored sign is refreshed for every active-with-sample strategy
 *       whether or not anything flipped. Scheduler callers must treat
 *       this as a write.
 *   2c. evaluateAndRecordCoinbaseHealth -- flags Coinbase outages past a
 *       15-minute grace.  Maintains its own first_down marker; caller
 *       records the alert row on fire.  60-minute dedup.
 *   2d. evaluateAndRecordNavDrop       -- flags + halts the engine when the
 *       most recent NAV snapshot is >=5% below the OLDEST snapshot in the
 *       past 7 days.  Threshold overrideable via TRADER_NAV_DROP_PCT.
 *       24-hour dedup so a sustained drawdown does not page out every
 *       tick.  The function is read-only on trader_alert_state; the
 *       scheduler calls recordAlertFired + engineClient.haltEngine on
 *       fire.  The "AndRecord" prefix is kept for naming consistency
 *       with 2b/2c -- the function reads dedup state and signals halt
 *       intent in its return shape, even though it does not write.
 *
 * Three alerts (abstain, coinbase_alert, nav_drop_alert) all use the
 * trader_alert_state.last_alerted_at column as a real ms timestamp.
 * The fourth (sharpe_last_sign:*) overloads the column with a +1/-1
 * sign marker instead.  The Phase 5 Dispatch C handoff considered
 * splitting the column with a value_kind discriminator and decided
 * against it: the NAV drop check turned out to need only a timestamp
 * (matching the abstain pattern), so the motivating use case for
 * value_kind never materialised.  Sharpe flip remains the only
 * overload and is documented inline.  Revisit only if a fifth alert
 * needs yet another value semantic.
 *
 * Module split: with four alerts now exported, splitting per-alert
 * files (alerts/abstain-digest.ts, etc.) is the next obvious refactor.
 * Deferred to Dispatch C+1; the current file is still under 500 lines.
 *
 * Timestamps are always milliseconds (the ClaudePaw-wide convention).
 */
import type Database from 'better-sqlite3'
import { isEquityMarketHours } from './signal-poller.js'

export interface AlertCheckResult {
  fire: boolean
  message?: string
  count?: number
}

/** Number of abstains within ABSTAIN_WINDOW_MS that triggers the digest. */
export const ABSTAIN_THRESHOLD = 4

/** Lookback window for the abstain digest. 24 hours in ms. */
export const ABSTAIN_WINDOW_MS = 24 * 60 * 60 * 1000

/** Minimum gap between consecutive abstain-digest fires. 12 hours in ms. */
export const ABSTAIN_DEDUP_MS = 12 * 60 * 60 * 1000

/** alert_id for the abstain digest row in trader_alert_state. */
const ABSTAIN_ALERT_ID = 'abstain_digest'

/** Minimum trade_count before the sharpe-flip alert can fire. */
export const SHARPE_FLIP_MIN_TRADES = 20

/**
 * Maximum number of flipped strategies spelled out in the sharpe-flip
 * message. Anything beyond this is summarised as "... and N more" so a
 * regime-turn that trips every strategy at once cannot blow past the
 * Telegram message size limit.
 */
export const SHARPE_FLIP_MAX_ENTRIES = 10

/**
 * Max length for a sampled thesis quoted in the abstain-digest message.
 * Longer theses get hard-truncated with an ellipsis. Keeps one runaway
 * thesis from dwarfing the rest of the alert.
 */
export const ABSTAIN_THESIS_MAX_LEN = 120

/**
 * Minimum duration (ms) that coinbase_connected must stay false before
 * the Coinbase-down alert is eligible to fire. 15 minutes of grace so a
 * routine credential rotation or brief network blip does not page out.
 */
export const COINBASE_OUTAGE_THRESHOLD_MS = 15 * 60 * 1000

/**
 * Dedup window (ms) between consecutive Coinbase-down alerts. 60 minutes;
 * a sustained outage keeps generating one alert per hour until recovered.
 */
export const COINBASE_DEDUP_MS = 60 * 60 * 1000

/** alert_ids for the Coinbase monitor. coinbase_first_down holds a real
 * timestamp (when the outage began). coinbase_alert holds last_alerted_at
 * for dedup. Two distinct rows so we can clear the first_down marker on
 * recovery without wiping dedup state. */
const COINBASE_FIRST_DOWN_ID = 'coinbase_first_down'
const COINBASE_ALERT_ID = 'coinbase_alert'

/**
 * Lookback for the NAV-drop comparison.  7 days: long enough that a
 * single bad day does not trigger, short enough that a real drawdown
 * shows up before NAV bleeds out.
 */
export const NAV_DROP_WINDOW_MS = 7 * 24 * 60 * 60 * 1000

/**
 * Dedup window between consecutive NAV-drop fires.  24 hours -- once
 * the engine is halted, nagging the operator every 5-minute tick adds
 * no information.  Re-fire after a full day if NAV is still down.
 */
export const NAV_DROP_DEDUP_MS = 24 * 60 * 60 * 1000

/**
 * Default drop threshold (positive number meaning "fraction down from
 * the comparison").  5% is the operating limit the operator picked; override
 * via TRADER_NAV_DROP_PCT for shadow-mode tuning.
 */
export const NAV_DROP_DEFAULT_THRESHOLD = 0.05

/** alert_id for the NAV-drop dedup row in trader_alert_state. */
const NAV_DROP_ALERT_ID = 'nav_drop_alert'

/**
 * UPSERT a row in trader_alert_state. Used both for real timestamps
 * (abstain_digest dedup) and for sign markers (sharpe_last_sign:*).
 * The column is the same; the meaning of the value depends on the
 * alert_id. See the module header for the quirk.
 */
export function recordAlertFired(
  db: Database.Database,
  alertId: string,
  value: number,
): void {
  db.prepare(`
    INSERT INTO trader_alert_state (alert_id, last_alerted_at)
    VALUES (?, ?)
    ON CONFLICT(alert_id) DO UPDATE SET
      last_alerted_at = excluded.last_alerted_at
  `).run(alertId, value)
}

/**
 * 2a. Fires when >=4 committee_abstain decisions landed in the past
 * 24 hours AND the last fire was more than 12 hours ago. Message
 * includes the total count plus up to three sample asset + thesis
 * pairs so the operator can see at a glance what the committee has
 * been balking on.
 */
export function checkAbstainDigest(
  db: Database.Database,
  nowMs: number,
): AlertCheckResult {
  const since = nowMs - ABSTAIN_WINDOW_MS

  const countRow = db.prepare(`
    SELECT COUNT(*) AS c
    FROM trader_decisions
    WHERE status = 'committee_abstain'
      AND decided_at >= ?
  `).get(since) as { c: number }

  const count = countRow?.c ?? 0
  if (count < ABSTAIN_THRESHOLD) {
    return { fire: false }
  }

  // Dedup against the stored last_alerted_at.
  const stateRow = db.prepare(`
    SELECT last_alerted_at
    FROM trader_alert_state
    WHERE alert_id = ?
  `).get(ABSTAIN_ALERT_ID) as { last_alerted_at: number } | undefined

  if (stateRow && nowMs - stateRow.last_alerted_at < ABSTAIN_DEDUP_MS) {
    return { fire: false }
  }

  const samples = db.prepare(`
    SELECT asset, thesis
    FROM trader_decisions
    WHERE status = 'committee_abstain'
      AND decided_at >= ?
    ORDER BY decided_at DESC
    LIMIT 3
  `).all(since) as Array<{ asset: string; thesis: string }>

  const lines: string[] = [
    `Trader committee abstained ${count} times in the past 24 hours.`,
  ]
  if (samples.length > 0) {
    lines.push('Recent samples:')
    for (const s of samples) {
      const thesis =
        s.thesis.length > ABSTAIN_THESIS_MAX_LEN
          ? s.thesis.slice(0, ABSTAIN_THESIS_MAX_LEN) + '...'
          : s.thesis
      lines.push(`- ${s.asset}: ${thesis}`)
    }
  }
  return {
    fire: true,
    count,
    message: lines.join('\n'),
  }
}

/**
 * 2b. Scans every active strategy with trade_count >= SHARPE_FLIP_MIN_TRADES.
 * For each, compares the current sign of rolling_sharpe against the
 * sign stored in trader_alert_state under 'sharpe_last_sign:<id>'.
 * A positive -> negative transition is a "flip". First-ever observation
 * seeds the state and does NOT fire (we do not know the prior sign).
 *
 * Writes to trader_alert_state every call: the stored sign for each
 * inspected strategy is refreshed to the current sign, whether or not
 * any strategy flipped. That is intentional. The function name calls
 * out the write so callers do not assume a pure read.
 *
 * Sign convention: rolling_sharpe < 0 -> -1, everything else -> +1.
 * That means exactly 0 is treated as positive (not a flip back to
 * positive-proper, just neutral rolled into the positive bucket).
 * That is a deliberate default because a strategy sitting on a
 * zero-stdev cache line should not trigger a "flip" alarm.
 *
 * Storage quirk: the stored value is +1 or -1 (not a timestamp),
 * overloaded onto the last_alerted_at column. See module header.
 *
 * Message is capped at SHARPE_FLIP_MAX_ENTRIES spelled out; the rest
 * are summarised as "... and N more" so Telegram does not truncate
 * the alert in the middle of a strategy id.
 */
export function evaluateAndRecordSharpeFlip(
  db: Database.Database,
  _nowMs: number,
): AlertCheckResult {
  const rows = db.prepare(`
    SELECT s.id, s.name, t.rolling_sharpe, t.trade_count
    FROM trader_strategies s
    JOIN trader_strategy_track_record t ON t.strategy_id = s.id
    WHERE s.status = 'active'
      AND t.trade_count >= ?
    ORDER BY s.id ASC
  `).all(SHARPE_FLIP_MIN_TRADES) as Array<{
    id: string
    name: string
    rolling_sharpe: number
    trade_count: number
  }>

  const flipped: Array<{ id: string; name: string; sharpe: number }> = []

  for (const row of rows) {
    const currentSign = row.rolling_sharpe < 0 ? -1 : 1
    const alertId = `sharpe_last_sign:${row.id}`

    const prior = db.prepare(`
      SELECT last_alerted_at
      FROM trader_alert_state
      WHERE alert_id = ?
    `).get(alertId) as { last_alerted_at: number } | undefined

    if (prior && prior.last_alerted_at === 1 && currentSign === -1) {
      flipped.push({ id: row.id, name: row.name, sharpe: row.rolling_sharpe })
    }

    // Always update the stored sign, whether this call fired or not.
    // That keeps the state honest: a strategy that stays negative
    // will not re-fire on the next tick.
    recordAlertFired(db, alertId, currentSign)
  }

  if (flipped.length === 0) {
    return { fire: false }
  }

  const shown = flipped.slice(0, SHARPE_FLIP_MAX_ENTRIES)
  const overflow = flipped.length - shown.length
  const parts = shown.map(f =>
    `${f.name} (${f.id}): rolling_sharpe ${f.sharpe.toFixed(2)}`,
  )
  const body = parts.join('; ')
  const suffix = overflow > 0 ? ` ... and ${overflow} more` : ''
  return {
    fire: true,
    message: `Sharpe flip negative: ${body}${suffix}`,
  }
}

/**
 * 2c. Polls /health via the injected getHealth callable and tracks the
 * Coinbase connection outage window. Semantics:
 *
 *   - healthy / unknown (getHealth throws, returns null, or response is
 *     missing the coinbase_connected field, or coinbase_connected is not
 *     strictly false): clear any first_down marker and return fire false.
 *     Engine-level outages are the reconciler's problem, not ours.
 *   - outage tick 1 (coinbase_connected === false, no first_down marker):
 *     insert the marker with nowMs, start the outage clock, return fire false.
 *   - outage tick within 15-min grace: return fire false, marker unchanged.
 *   - outage tick past 15 min, within 60-min dedup of last alert: return
 *     fire false.
 *   - outage tick past 15 min, outside dedup: return fire true with a human
 *     facing message. Caller is responsible for calling recordAlertFired
 *     with COINBASE_ALERT_ID once the alert ships.
 *
 * Storage: two rows in trader_alert_state share the same column but have
 * different semantics. `coinbase_first_down.last_alerted_at` is a real ms
 * timestamp (when the outage began); `coinbase_alert.last_alerted_at` is
 * the real ms timestamp of the last alert fired. Both overload the
 * column the same way abstain_digest does (pure ms timestamp), so this
 * alert stays within the existing schema quirk rather than adding a
 * third convention. The module header already flags a `value_kind`
 * refactor; this dispatch intentionally does not add it (deferred per
 * the Phase 5 handoff).
 */
export async function evaluateAndRecordCoinbaseHealth(
  db: Database.Database,
  nowMs: number,
  getHealth: () => Promise<{ coinbase_connected?: boolean } | null>,
): Promise<AlertCheckResult> {
  // Step 1: pull the health body. Anything that is not a clean "Coinbase
  // is down" signal falls through to the healthy branch. A throw or null
  // response means the engine itself is unreachable, which the
  // reconciler's own alerting handles separately; we do not want to
  // double-alert.
  let body: { coinbase_connected?: boolean } | null = null
  try {
    body = await getHealth()
  } catch {
    body = null
  }

  const isDown =
    body !== null && body !== undefined && body.coinbase_connected === false

  if (!isDown) {
    // Healthy, unknown, or engine issue. Clear any lingering first_down
    // marker so the next genuine outage starts the clock fresh.
    db.prepare(
      `DELETE FROM trader_alert_state WHERE alert_id = ?`,
    ).run(COINBASE_FIRST_DOWN_ID)
    return { fire: false }
  }

  // Coinbase is explicitly down. Look up the start-of-outage marker.
  const firstDownRow = db
    .prepare(
      `SELECT last_alerted_at FROM trader_alert_state WHERE alert_id = ?`,
    )
    .get(COINBASE_FIRST_DOWN_ID) as { last_alerted_at: number } | undefined

  if (!firstDownRow) {
    // First outage tick. Start the clock, return fire false.
    recordAlertFired(db, COINBASE_FIRST_DOWN_ID, nowMs)
    return { fire: false }
  }

  const outageMs = nowMs - firstDownRow.last_alerted_at
  if (outageMs < COINBASE_OUTAGE_THRESHOLD_MS) {
    // Still inside the 15-min grace. Keep the clock ticking.
    return { fire: false }
  }

  // Past the grace window. Check dedup before firing.
  const lastAlertRow = db
    .prepare(
      `SELECT last_alerted_at FROM trader_alert_state WHERE alert_id = ?`,
    )
    .get(COINBASE_ALERT_ID) as { last_alerted_at: number } | undefined

  if (lastAlertRow && nowMs - lastAlertRow.last_alerted_at < COINBASE_DEDUP_MS) {
    return { fire: false }
  }

  return {
    fire: true,
    message:
      'Coinbase connection down for >15m during scheduler ticks. ' +
      'Check engine credentials and /health.',
  }
}

/**
 * Result shape for evaluateAndRecordNavDrop.  The scheduler reads `fire`
 * to decide whether to send Telegram + recordAlertFired and `halt` to
 * decide whether to call engineClient.haltEngine.  Currently halt is
 * always set the same as fire (a NAV-drop fire always halts), but the
 * shape keeps them separate so a future "warn but do not halt" mode can
 * land without churning the call sites.
 */
export interface NavDropResult {
  fire: boolean
  halt: boolean
  message?: string
  current_nav?: number
  comparison_nav?: number
  /** Positive number when NAV dropped (e.g. 0.06 means down 6%). */
  drop_pct?: number
}

/**
 * 2d. NAV-drop halt monitor.
 *
 * Pulls recent snapshots via the supplied callback (the scheduler wires
 * it to engineClient.getNavSnapshots(10)).  Compares the most recent
 * snapshot against the OLDEST snapshot inside a 7-day window.  Fires +
 * signals halt when the drop crosses the threshold AND the dedup window
 * has elapsed.
 *
 * Threshold defaults to 5%; TRADER_NAV_DROP_PCT (parsed as float)
 * overrides.  A malformed env value (e.g. "banana") falls back to the
 * default rather than throwing -- a typo in deploy config must not stop
 * the scheduler.
 *
 * Bail conditions (return fire=false, halt=false):
 *   - getSnapshots returns 0 or 1 entry (no comparison possible).
 *   - Only the current snapshot falls in the 7-day window (no comparison
 *     point inside the lookback).
 *   - drop_pct < threshold.
 *   - NAV drop dedup row was set within the last 24 hours.
 *
 * The function only READS trader_alert_state for dedup; the scheduler
 * is responsible for calling recordAlertFired(NAV_DROP_ALERT_ID, nowMs)
 * and engineClient.haltEngine(message) on fire.  See trader-scheduler
 * Phase 6 for the wire-up.
 *
 * Message format is intentionally one line, plain text, no markdown.
 * Telegram channel is plain-text only.
 */
export async function evaluateAndRecordNavDrop(
  db: Database.Database,
  nowMs: number,
  getSnapshots: () => Promise<Array<{ date: string; period: string; nav: number; recorded_at: number }>>,
): Promise<NavDropResult> {
  // Threshold: env override or default.  parseFloat returns NaN for
  // malformed strings; we fall back to default in that case.
  const envRaw = process.env.TRADER_NAV_DROP_PCT
  const envParsed = envRaw === undefined ? NaN : Number.parseFloat(envRaw)
  const threshold = Number.isFinite(envParsed) ? envParsed : NAV_DROP_DEFAULT_THRESHOLD

  let snapshots: Array<{ date: string; period: string; nav: number; recorded_at: number }>
  try {
    snapshots = await getSnapshots()
  } catch {
    // Same posture as the rest of the monitor checks: an engine fetch
    // failure is the reconciler's problem, not ours.  Do not fire and
    // do not halt blindly.
    return { fire: false, halt: false }
  }

  if (!snapshots || snapshots.length < 2) {
    return { fire: false, halt: false }
  }

  // Pick the most recent (max recorded_at) as the current snapshot.
  // Snapshots are not guaranteed sorted by the engine; sort defensively.
  const sorted = [...snapshots].sort((a, b) => b.recorded_at - a.recorded_at)
  const current = sorted[0]

  // Filter to entries inside the 7-day window relative to current.  The
  // current snapshot itself is included by construction; we then take
  // the OLDEST remaining (lowest recorded_at) as the comparison.  Spec
  // pins this so a slow leak across a week shows up bigger than a
  // single-day blip.
  const windowStart = current.recorded_at - NAV_DROP_WINDOW_MS
  const inWindow = sorted.filter((s) => s.recorded_at >= windowStart)
  if (inWindow.length < 2) {
    // Only the current snapshot falls in the window.  No comparison.
    return { fire: false, halt: false }
  }
  const comparison = inWindow[inWindow.length - 1] // oldest in window

  // Positive number when NAV dropped.  A NAV recovery (current > comparison)
  // produces a negative drop_pct and never fires.
  const dropPct = (comparison.nav - current.nav) / comparison.nav

  if (dropPct < threshold) {
    return { fire: false, halt: false }
  }

  // Past the threshold.  Check dedup before firing.
  const dedupRow = db
    .prepare(`SELECT last_alerted_at FROM trader_alert_state WHERE alert_id = ?`)
    .get(NAV_DROP_ALERT_ID) as { last_alerted_at: number } | undefined

  if (dedupRow && nowMs - dedupRow.last_alerted_at < NAV_DROP_DEDUP_MS) {
    return { fire: false, halt: false }
  }

  // Fire.  Message is one line, plain text, no markdown.  Format
  // pinned by tests so a future tweak gets caught loudly.  The minus
  // sign on the percent is part of the human signal even though
  // drop_pct itself is positive.  The threshold is included so a
  // sleepy operator reading the alert at 3am does not need to hunt
  // through env config to see where the bar was set.
  const dropPctSigned = -dropPct * 100
  const thresholdSigned = -threshold * 100
  const message =
    'NAV drop halt: $' +
    comparison.nav.toFixed(2) +
    ' -> $' +
    current.nav.toFixed(2) +
    ' (' +
    dropPctSigned.toFixed(1) +
    '%, threshold ' +
    thresholdSigned.toFixed(1) +
    '%) over 7 days. Engine halted via /risk/halt.'

  return {
    fire: true,
    halt: true,
    message,
    current_nav: current.nav,
    comparison_nav: comparison.nav,
    drop_pct: dropPct,
  }
}

// ---------------------------------------------------------------------------
// 2e. checkSignalDrought -- fires when consecutive zero-fetched poll ticks
//     reach the threshold (default 12 × 5-min ticks = 1 hour).  Intended to
//     catch engine-side failures (broken DNS, Alpaca timeout, signal job
//     crash) that produce no signals without raising a health-check error.
//
//     Counter is maintained in trader-scheduler.ts (_consecutiveZeroPollCount)
//     and passed in by the caller.  Pure read -- caller calls recordAlertFired
//     on fire (same contract as checkAbstainDigest).
// ---------------------------------------------------------------------------
const SIGNAL_DROUGHT_TICKS = 12                              // 12 × 5-min = 1 hour
const SIGNAL_DROUGHT_DEDUP_MS = 2 * 60 * 60 * 1000          // 2 hours between fires
export const SIGNAL_DROUGHT_ALERT_ID = 'signal_drought'

export function checkSignalDrought(
  db: Database.Database,
  nowMs: number,
  consecutiveZeros: number,
): AlertCheckResult {
  if (consecutiveZeros < SIGNAL_DROUGHT_TICKS) {
    return { fire: false }
  }

  // Off-hours guard: equity strategies are gated to NYSE 09:30-16:00 ET in
  // signal-poller.ts. Outside those hours the only signal source is the
  // 24/7 crypto generator, which routinely scores 0.0 in non-breakout
  // regimes -- a correct, common state, not a stalled engine. Suppressing
  // the drought alert outside market hours avoids paging the operator at
  // 22:00 ET on a flat tape. During market hours the alert fires as
  // before so a real engine outage still surfaces within an hour.
  if (!isEquityMarketHours(nowMs)) {
    return { fire: false }
  }

  const dedupRow = db
    .prepare(`SELECT last_alerted_at FROM trader_alert_state WHERE alert_id = ?`)
    .get(SIGNAL_DROUGHT_ALERT_ID) as { last_alerted_at: number } | undefined

  if (dedupRow && nowMs - dedupRow.last_alerted_at < SIGNAL_DROUGHT_DEDUP_MS) {
    return { fire: false }
  }

  return {
    fire: true,
    message:
      'Trader: no signals for 1+ hour. Engine signal generators may be stalled. ' +
      'Check /health and the engine log for Alpaca connectivity errors.',
  }
}

// ---------------------------------------------------------------------------
// 2f. evaluateAlpacaHealth -- mirrors evaluateAndRecordCoinbaseHealth.
//     Detects when alpaca_connected === false persists beyond the 15-min
//     grace window and fires a Telegram once per 2-hour dedup window.
//     Two trader_alert_state rows: alpaca_first_down (outage clock) and
//     alpaca_alert (dedup timestamp).  Caller calls recordAlertFired on fire.
// ---------------------------------------------------------------------------
const ALPACA_OUTAGE_THRESHOLD_MS = 15 * 60 * 1000           // 15-min grace (same as Coinbase)
const ALPACA_DEDUP_MS = 2 * 60 * 60 * 1000                  // 2 hours between repeat alerts
const ALPACA_FIRST_DOWN_ID = 'alpaca_first_down'
export const ALPACA_DOWN_ALERT_ID = 'alpaca_alert'

export async function evaluateAlpacaHealth(
  db: Database.Database,
  nowMs: number,
  getHealth: () => Promise<{ alpaca_connected?: boolean } | null>,
): Promise<AlertCheckResult> {
  let body: { alpaca_connected?: boolean } | null = null
  try {
    body = await getHealth()
  } catch {
    body = null
  }

  const isDown = body !== null && body !== undefined && body.alpaca_connected === false

  if (!isDown) {
    db.prepare(
      `DELETE FROM trader_alert_state WHERE alert_id = ?`,
    ).run(ALPACA_FIRST_DOWN_ID)
    return { fire: false }
  }

  const firstDownRow = db
    .prepare(
      `SELECT last_alerted_at FROM trader_alert_state WHERE alert_id = ?`,
    )
    .get(ALPACA_FIRST_DOWN_ID) as { last_alerted_at: number } | undefined

  if (!firstDownRow) {
    recordAlertFired(db, ALPACA_FIRST_DOWN_ID, nowMs)
    return { fire: false }
  }

  const outageMs = nowMs - firstDownRow.last_alerted_at
  if (outageMs < ALPACA_OUTAGE_THRESHOLD_MS) {
    return { fire: false }
  }

  const lastAlertRow = db
    .prepare(
      `SELECT last_alerted_at FROM trader_alert_state WHERE alert_id = ?`,
    )
    .get(ALPACA_DOWN_ALERT_ID) as { last_alerted_at: number } | undefined

  if (lastAlertRow && nowMs - lastAlertRow.last_alerted_at < ALPACA_DEDUP_MS) {
    return { fire: false }
  }

  return {
    fire: true,
    message:
      'Trader: Alpaca API unreachable for 15+ min. Signals blocked. ' +
      'Check WSL2 DNS (resolv.conf) or Alpaca status page.',
  }
}
