import type Database from 'better-sqlite3'
import type { EngineClient } from './engine-client.js'
import { pollAndStoreSignals } from './signal-poller.js'
import { enrichPendingSignals } from './enrichment-fetcher.js'
import { autoDispatchPendingSignals } from './decision-dispatcher.js'
import { formatTimeoutNotice, timeoutExpiredApprovals, type TraderApprovalKeyboard } from './approval-manager.js'
import { runCloseOutSweep } from './close-out-watcher.js'
import { maybeFireWeeklyReport } from './weekly-report.js'
import {
  checkAbstainDigest,
  evaluateAndRecordSharpeFlip,
  evaluateAndRecordCoinbaseHealth,
  evaluateAndRecordNavDrop,
  recordAlertFired,
} from './monitor.js'
import { checkKillSwitch } from '../cost/kill-switch-client.js'
import { BOT_API_TOKEN, DASHBOARD_API_TOKEN, DASHBOARD_URL } from '../config.js'
import { logger } from '../logger.js'
import type { KillSwitchLogEntry } from './weekly-report.js'
import { syncTraderTablesToServer } from './server-sync.js'

/**
 * Interval between trader ticks. 5 minutes is the sweet spot:
 *  - Engine signal job runs every 15 min, so we get fresh signals within 5 min of generation.
 *  - Approval cards go out quickly enough to reply before the 30-min timeout.
 *  - Infrequent enough to keep engine load trivial even if markets are closed.
 *
 * Overridable via TRADER_TICK_MS env var for tests / manual runs.
 */
const DEFAULT_TICK_MS = 5 * 60 * 1000

export interface TraderSchedulerDeps {
  /** Bot SQLite handle (store/claudepaw.db). */
  db: Database.Database
  /** Engine client factory -- deferred so credentials can be resolved at tick time. */
  getEngineClient: () => EngineClient
  /** Sends a plain-text alert to the operator's Telegram chat (e.g. engine halt). */
  send: (text: string) => Promise<void>
  /** Sends an approval card with inline keyboard buttons. */
  sendWithKeyboard: (text: string, keyboard: TraderApprovalKeyboard) => Promise<void>
  /** Tick interval override. Defaults to DEFAULT_TICK_MS (5 min). */
  tickMs?: number
}

let intervalHandle: NodeJS.Timeout | null = null

/**
 * Module-level flag to prevent spamming reconciler halt alerts on every tick.
 * Resets to false when reconciler_halted goes back to false.
 */
let _haltAlertSent = false

/**
 * Phase 6 Task 3 -- in-process concurrency guard.  setInterval does
 * not prevent overlapping ticks: a slow poll or Telegram send can
 * push tick N past the start of tick N+1, and under launchd restart
 * two ticks can land on the same second.  Overlapping ticks in the
 * monitor phase can duplicate Telegram sends (the NAV halt call is
 * already idempotent engine-side, so only the user-facing duplicate
 * is a concern).  A boolean flag is sufficient -- Node is single
 * threaded so there is no atomicity hazard between the read and the
 * write.  The lock is cleared in a finally block so a throw inside
 * any phase still releases it for the next tick.
 */
let _tickInProgress = false

/**
 * Consecutive health-check failure counter. Reset to zero on any successful
 * health response. When it reaches ENGINE_UNREACHABLE_THRESHOLD the operator
 * gets a single Telegram alert; _engineUnreachableAlertSent gates further
 * sends so only one alert fires per outage event.
 */
let _healthCheckConsecutiveFailures = 0
let _engineUnreachableAlertSent = false
const ENGINE_UNREACHABLE_THRESHOLD = 3  // 3 × 5-min ticks = 15 min before alerting

/**
 * Start the trader tick. Each tick:
 *  1. Checks engine health and alerts if reconciler is halted (once per halt event).
 *  2. Polls the engine for new signals and stores them in trader_signals.
 *  3. Sends an approval card for every pending signal that has no approval row yet.
 *  4. Marks any approval older than 30 min as timed out.
 *
 * Each phase is isolated -- a failure in one does not stop the others.
 * The initial tick fires immediately on start so signals accumulated while
 * the bot was offline still get surfaced.
 */
export function initTraderScheduler(deps: TraderSchedulerDeps): void {
  if (intervalHandle) {
    logger.warn('Trader scheduler already running, skipping duplicate init')
    return
  }

  const tickMs = deps.tickMs ?? DEFAULT_TICK_MS

  logger.info({ tickMs }, 'Trader scheduler started')

  const tick = () => {
    runTraderTick(deps).catch((err) => {
      logger.error({ err }, 'Trader tick failed')
    })
  }

  intervalHandle = setInterval(tick, tickMs)
  tick()  // Run immediately on startup
}

export function stopTraderScheduler(): void {
  if (intervalHandle) {
    clearInterval(intervalHandle)
    intervalHandle = null
    logger.info('Trader scheduler stopped')
  }
}

/** Reset halt-alert state. Exposed for tests only -- do not call in production code. */
export function _resetHaltAlertForTest(): void {
  _haltAlertSent = false
}

/** Reset tick lock state. Exposed for tests only -- do not call in production code. */
export function _resetTickLockForTest(): void {
  _tickInProgress = false
}

/**
 * Execute one tick of the trader loop. Exported for manual runs / tests.
 * Each of the five phases is guarded so a failure in one does not abort the rest.
 *
 * Phase 6 Task 3 -- an in-process lock at the very top returns early
 * when another tick is still running.  The skipped tick returns a
 * sentinel payload (all counters zero, skipped=true) and touches no
 * phase.  The lock is released in a finally block so a thrown error
 * inside any phase still unblocks the next tick.
 */
export async function runTraderTick(deps: TraderSchedulerDeps): Promise<{
  polled: boolean
  sent: number
  timedOut: number
  reconcilerHalted: boolean
  closedOut: number
  weeklyReportFired: boolean
  skipped?: boolean
}> {
  if (_tickInProgress) {
    logger.info('Trader tick skipped: previous tick still running')
    return {
      polled: false,
      sent: 0,
      timedOut: 0,
      reconcilerHalted: false,
      closedOut: 0,
      weeklyReportFired: false,
      skipped: true,
    }
  }
  _tickInProgress = true

  let polled = false
  let sent = 0
  let timedOut = 0
  let reconcilerHalted = false
  let closedOut = 0
  let weeklyReportFired = false

  try {
  // 0. Health check -- detect reconciler halt and alert once per halt event.
  // getHealth returns null on 404 (older engine build without /health) or on
  // network error; treat that as "unknown, do not toggle the halt alert".
  try {
    const client = deps.getEngineClient()
    const health = await client.getHealth()
    // Engine reachable -- reset unreachable counter and send recovery notice if needed.
    if (_healthCheckConsecutiveFailures > 0) {
      logger.info({ was: _healthCheckConsecutiveFailures }, 'Trader engine reachable again')
    }
    _healthCheckConsecutiveFailures = 0
    if (_engineUnreachableAlertSent) {
      _engineUnreachableAlertSent = false
      await deps.send('TRADER: Engine back online. Signal polling resumed.')
    }
    if (health && health.reconciler_halted === true) {
      reconcilerHalted = true
      if (!_haltAlertSent) {
        _haltAlertSent = true
        const reason = health.halt_reason ?? 'no reason provided'
        logger.error({ halt_reason: reason }, 'Trader engine reconciler halted')
        await deps.send(`TRADER ALERT: Engine reconciler halted. Reason: ${reason}. No new orders will reconcile until cleared.`)
      }
    } else if (health) {
      // Reconciler recovered -- reset flag so we alert again on the next halt
      if (_haltAlertSent) {
        logger.info('Trader engine reconciler recovered')
        _haltAlertSent = false
      }
    }
  } catch (err) {
    _healthCheckConsecutiveFailures++
    logger.warn({ err, consecutiveFailures: _healthCheckConsecutiveFailures }, 'Trader tick: health check failed')
    if (_healthCheckConsecutiveFailures >= ENGINE_UNREACHABLE_THRESHOLD && !_engineUnreachableAlertSent) {
      _engineUnreachableAlertSent = true
      logger.error({ consecutiveFailures: _healthCheckConsecutiveFailures }, 'Trader engine unreachable: sending alert')
      await deps.send(`TRADER ALERT: Engine unreachable for ${_healthCheckConsecutiveFailures * 5} minutes. Win11 may be offline or Tailscale disconnected. Signal generation is stopped.`)
    }
  }

  // 1. Poll engine for fresh signals.
  try {
    const client = deps.getEngineClient()
    await pollAndStoreSignals(deps.db, client)
    polled = true
  } catch (err) {
    logger.warn({ err }, 'Trader tick: signal poll failed')
  }

  // 1b. Enrich pending signals with 30-day price bars (RSI, momentum,
  //     price levels) so the committee has real market context.
  //     Runs after poll so newly inserted signals are also enriched.
  //     Failures are logged but never block the approval-send step.
  if (polled) {
    try {
      const client = deps.getEngineClient()
      await enrichPendingSignals(deps.db, client)
    } catch (err) {
      logger.warn({ err }, 'Trader tick: signal enrichment failed; committee will see (none)')
    }
  }

  // 2. Auto-dispatch pending signals through the committee.
  try {
    const dispatched = await autoDispatchPendingSignals(deps.db, {
      send: deps.send,
      alertOnReject: process.env.TRADER_ALERT_ON_REJECT === 'true',
    })
    sent = dispatched.length
  } catch (err) {
    logger.error({ err }, 'Trader tick: auto-dispatch failed')
  }

  // 3. Time out approvals older than 30 min and notify the operator so a
  //    missed signal is never silent. Notification failures do not block
  //    the DB transition -- we would rather log than leave rows pending.
  try {
    const expired = timeoutExpiredApprovals(deps.db)
    timedOut = expired.length
    if (timedOut > 0) {
      logger.info({ timedOut }, 'Trader tick: timed out stale approvals')
      for (const row of expired) {
        const notice = formatTimeoutNotice(row)
        if (!notice) {
          logger.warn({ approvalId: row.id, signalId: row.signalId }, 'Skipping timeout notice: signal metadata missing')
          continue
        }
        try {
          await deps.send(notice)
        } catch (sendErr) {
          logger.error({ err: sendErr, approvalId: row.id }, 'Trader tick: timeout notice send failed')
        }
      }
    }
  } catch (err) {
    logger.error({ err }, 'Trader tick: approval timeout sweep failed')
  }

  // 4. Close-out sweep -- detect positions that fully closed since last
  //    tick and write a verdict + ReasoningBank case for each. Pure
  //    deterministic math + DB writes, zero LLM calls. Skipped silently
  //    when the engine is unreachable (already counted as an error).
  try {
    const client = deps.getEngineClient()
    const sweep = await runCloseOutSweep(deps.db, client)
    closedOut = sweep.processed
    if (sweep.processed > 0) {
      logger.info({ closedOut: sweep.processed, stillOpen: sweep.stillOpen }, 'Trader tick: close-out sweep completed')
    }
  } catch (err) {
    logger.warn({ err }, 'Trader tick: close-out sweep failed')
  }

  // 5. Weekly report gate (Phase 4 Task C). Fires at most once per week
  //    on the first tick past Sunday 09:00 America/New_York. Uses
  //    kv_settings for the last-fired timestamp so launchd restarts do
  //    not cause a double-fire. Engine-unreachable is tolerated -- the
  //    report still renders with a "NAV unavailable" section. Any
  //    failure here logs + moves on so it can never stall the other
  //    tick phases.
  //
  //    Kill-switch state is fetched here and passed through so the
  //    report accurately surfaces whether the switch is currently
  //    tripped. checkKillSwitch returns null when clear, or a
  //    {set_at, reason} object when tripped. A fetch failure falls
  //    back to null rather than breaking the report.
  try {
    let engineClientForReport: EngineClient | null = null
    try {
      engineClientForReport = deps.getEngineClient()
    } catch {
      engineClientForReport = null
    }
    let ksInfo: { active: boolean; set_at: number | null; reason: string } | null = null
    try {
      const ks = await checkKillSwitch()
      ksInfo = ks
        ? { active: true, set_at: ks.set_at, reason: ks.reason }
        : { active: false, set_at: null, reason: '' }
    } catch (err) {
      logger.debug({ err }, 'Trader tick: weekly report kill-switch probe failed; proceeding without')
    }
    const result = await maybeFireWeeklyReport({
      db: deps.db,
      engineClient: engineClientForReport,
      send: deps.send,
      killSwitch: ksInfo,
      fetchKillSwitchLog: fetchKillSwitchLogFromServer,
    })
    weeklyReportFired = result.fired
    if (result.fired) {
      logger.info({ path: result.path }, 'Trader tick: weekly report fired')
    }
  } catch (err) {
    logger.warn({ err }, 'Trader tick: weekly report gate failed')
  }

  // 6. Monitoring alerts (Phase 5 Task 2 Dispatch C).  Each of the four
  //    alert checks is wrapped in its own try/catch so a single throwing
  //    check cannot stall the others.  Telegram emission is via deps.send
  //    (the same plain-text path the engine-halt alert uses).  Bookkeeping
  //    on fire: timestamp variants (abstain_digest, coinbase_alert,
  //    nav_drop_alert) get a recordAlertFired call here; sharpe-flip
  //    self-records its own +1/-1 sign every tick inside the check.
  await runMonitorPhase(deps)

  // 7. Push a snapshot of all trader tables to the dashboard server so
  //    the Signal Queue and other cards always show current data. This runs
  //    after every phase so the server sees the latest state. Fire-and-forget
  //    -- a sync failure never stalls the tick or surfaces to the operator.
  void syncTraderTablesToServer(deps.db)

  return { polled, sent, timedOut, reconcilerHalted, closedOut, weeklyReportFired }
  } finally {
    _tickInProgress = false
  }
}

/**
 * Phase 5 Task 3 -- fetch the kill-switch log from the server's
 * admin-only endpoint. The bot calls this when building the weekly
 * report so the rendered output can show how many times the operator
 * toggled the switch in-window.
 *
 * Uses `DASHBOARD_API_TOKEN` (admin) rather than `BOT_API_TOKEN`
 * because the GET endpoint is `requireAdmin` -- the bot user would
 * 403. Falls back to `BOT_API_TOKEN` only when admin is unset, in
 * which case the request will likely 403 and the report degrades to
 * "no events this week" rather than throwing.
 */
async function fetchKillSwitchLogFromServer(
  sinceMs: number,
  untilMs: number,
): Promise<KillSwitchLogEntry[]> {
  const baseUrl = DASHBOARD_URL || 'http://127.0.0.1:3000'
  const token = DASHBOARD_API_TOKEN || BOT_API_TOKEN
  if (!token) {
    logger.warn('Weekly report: no DASHBOARD_API_TOKEN; kill-switch log fetch skipped')
    return []
  }
  const url = `${baseUrl}/api/v1/trader/kill-switch-log?since_ms=${sinceMs}&until_ms=${untilMs}`
  try {
    const res = await fetch(url, {
      headers: { 'x-dashboard-token': token },
      signal: AbortSignal.timeout(5000),
    })
    if (!res.ok) {
      logger.warn({ status: res.status }, 'Weekly report: kill-switch log fetch returned non-2xx')
      return []
    }
    const body = (await res.json()) as { entries?: KillSwitchLogEntry[] }
    return Array.isArray(body.entries) ? body.entries : []
  } catch (err) {
    logger.warn({ err }, 'Weekly report: kill-switch log fetch failed')
    return []
  }
}

/**
 * Phase 6 -- monitoring alerts.  Each check isolated in its own
 * try/catch so one throwing check cannot stall the others.  Extracted as
 * a helper to keep runTraderTick legible.
 *
 * The NAV-drop check additionally calls engineClient.haltEngine when
 * fire is true.  A halt failure does not throw (already inside a
 * try/catch), but it does emit a follow-up Telegram so the operator
 * never thinks the engine actually halted when it did not.
 *
 * Engine client is resolved ONCE up top and shared across the two
 * network-dependent checks (coinbase + NAV).  abstain + sharpe do not
 * need it so they run regardless; a missing ENGINE_TOKEN (or any other
 * getEngineClient throw) silently skips the two network checks without
 * killing those first two.  Removes the duplicate client-null fallback
 * that the original wire-in had in both phase 3 and phase 4.
 *
 * Known tech debt: overlapping ticks can both see fire and both call
 * haltEngine + send the alert Telegram.  The halt itself is idempotent
 * on the engine side (kill_switch circuit breaker sticks on the first
 * trip), so the worst case is a duplicate Telegram.  Noted in the
 * Phase 5 handoff "Task 2 remaining tech debt"; no fix in this
 * dispatch.
 */
async function runMonitorPhase(deps: TraderSchedulerDeps): Promise<void> {
  const nowMs = Date.now()

  // 1. Abstain digest -- read-only check, dedup row written on fire.
  //    No engine client needed.
  //    Record BEFORE send so a failed Telegram (transient channel
  //    outage) does not cause the next tick to re-fire and double-send
  //    once Telegram recovers.  The dedup row means "we have decided
  //    to alert on this condition"; delivery retries are a channel
  //    concern, not an alert-engine concern.
  try {
    const r = checkAbstainDigest(deps.db, nowMs)
    if (r.fire && r.message) {
      recordAlertFired(deps.db, 'abstain_digest', nowMs)
      await deps.send(r.message)
      logger.info({ count: r.count }, 'Trader tick: abstain digest alert sent')
    }
  } catch (err) {
    logger.error({ err }, 'Trader tick: abstain digest check failed')
  }

  // 2. Sharpe flip -- self-records the per-strategy sign every call.
  //    We only Telegram on fire; the state mutation happens regardless.
  //    No engine client needed.
  try {
    const r = evaluateAndRecordSharpeFlip(deps.db, nowMs)
    if (r.fire && r.message) {
      await deps.send(r.message)
      logger.info('Trader tick: sharpe flip alert sent')
    }
  } catch (err) {
    logger.error({ err }, 'Trader tick: sharpe flip check failed')
  }

  // Resolve the engine client once for the two remaining checks.  A
  // missing credential (or any other getEngineClient throw) leaves us
  // with a null client and silently skips coinbase + NAV for this tick
  // without taking down abstain + sharpe.  The other phases of the
  // trader tick already follow this same "try once, log, fall through"
  // pattern.
  let client: EngineClient | null = null
  try {
    client = deps.getEngineClient()
  } catch (err) {
    logger.warn({ err }, 'Trader tick: engine client unavailable; skipping coinbase + nav checks this tick')
  }
  if (client === null) return

  // 3. Coinbase health -- self-tracks first_down marker.  Dedup row
  //    written on fire here (the check is read-only on coinbase_alert).
  //    Record BEFORE send for the same reason as abstain above.
  try {
    const r = await evaluateAndRecordCoinbaseHealth(deps.db, nowMs, () => client!.getHealth())
    if (r.fire && r.message) {
      recordAlertFired(deps.db, 'coinbase_alert', nowMs)
      await deps.send(r.message)
      logger.info('Trader tick: coinbase health alert sent')
    }
  } catch (err) {
    logger.error({ err }, 'Trader tick: coinbase health check failed')
  }

  // 4. NAV drop halt -- on fire, we write the dedup row FIRST, then
  //    Telegram, then call engineClient.haltEngine.  A halt-call
  //    failure emits a follow-up Telegram so the operator can
  //    intervene.  Recording the dedup row first is load-bearing
  //    here: halt is idempotent engine-side but repeated halt
  //    attempts every 5 minutes during a Telegram outage would spam
  //    the engine log and the operator on recovery.
  try {
    const r = await evaluateAndRecordNavDrop(deps.db, nowMs, () => client!.getNavSnapshots(10))
    if (r.fire && r.message) {
      recordAlertFired(deps.db, 'nav_drop_alert', nowMs)
      await deps.send(r.message)
      logger.warn({ drop_pct: r.drop_pct, current_nav: r.current_nav, comparison_nav: r.comparison_nav },
        'Trader tick: NAV drop alert sent')
      if (r.halt) {
        try {
          await client!.haltEngine(r.message)
          logger.warn({ reason: r.message }, 'Trader engine halted by NAV drop monitor')
        } catch (haltErr) {
          logger.error({ err: haltErr }, 'Trader tick: engine halt call failed after NAV drop alert')
          try {
            await deps.send(
              'NAV drop detected but engine halt call failed. Investigate immediately.',
            )
          } catch (notifyErr) {
            logger.error({ err: notifyErr }, 'Trader tick: NAV halt-failure follow-up notice send failed')
          }
        }
      }
    }
  } catch (err) {
    logger.error({ err }, 'Trader tick: NAV drop check failed')
  }
}
