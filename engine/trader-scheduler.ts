import type Database from 'better-sqlite3'
import type { EngineClient } from './engine-client.js'
import { pollAndStoreSignals, isEquityMarketHours } from './signal-poller.js'
import { enrichPendingSignals } from './enrichment-fetcher.js'
import { autoDispatchPendingSignals } from './decision-dispatcher.js'
import { reconcileOpenOrders } from './order-reconciler.js'
import { runRetrySweep } from './order-retry.js'
import {
  renderAlert,
  explainPositionMismatch,
  explainServiceDown,
  explainServiceBack,
} from './plain-english.js'
import { syncSignalStatuses } from './signal-state-sync.js'
import { runCloseOutSweep } from './close-out-watcher.js'
import { runExitSweep } from './exit-evaluator.js'
import { maybeFireWeeklyReport } from './weekly-report.js'
import { maybeFireTraderDigest } from './notify-digest.js'
import {
  checkAbstainDigest,
  checkAbstainRate,
  evaluateAndRecordSharpeFlip,
  evaluateAndRecordCoinbaseHealth,
  evaluateAndRecordEngineUnreachable,
  evaluateAndRecordNavDrop,
  recordAlertFired,
  checkSignalDrought,
  SIGNAL_DROUGHT_ALERT_ID,
  evaluateAlpacaHealth,
  ALPACA_DOWN_ALERT_ID,
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
  /**
   * Sends a plain-text message to the operator's Telegram chat. In production
   * this is the DIGESTING send: issues go out instantly, routine messages are
   * buffered for the 2x/day digest (see notify-digest.ts).
   */
  send: (text: string) => Promise<void>
  /**
   * Unwrapped send that always delivers immediately. Used only to push the
   * digest summary itself (so it is not re-buffered) and reports. Defaults to
   * `send` when omitted (tests that don't wrap).
   */
  rawSend?: (text: string) => Promise<void>
  /** Tick interval override. Defaults to DEFAULT_TICK_MS (5 min). */
  tickMs?: number
  /**
   * Fire-and-forget SSH restart for the trader engine.
   * Called after ENGINE_RESTART_THRESHOLD consecutive health failures during
   * market hours. Wired in index.ts; omit in tests to skip the SSH call.
   */
  restartEngineAsync?: () => void
  /** Injectable NYSE-open check. Defaults to the real clock. Tests set this
   *  explicitly so the suite does not behave differently after 16:00 ET. */
  isMarketOpen?: () => boolean
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
 * Consecutive health-check failure counter, in-memory and per-process.
 * Reset to zero on any successful health response. Drives the SSH
 * auto-restart below (which is correctly per-process). The sustained-
 * outage operator page lives in evaluateAndRecordEngineUnreachable, whose
 * state is persisted in trader_alert_state so it survives bot restarts.
 */
let _healthCheckConsecutiveFailures = 0
/** When we last asked launchd to restart the engine, 0 if never this outage.
 *  A timestamp rather than a boolean so a restart that does not take can be
 *  retried, without the retry becoming a loop. */
let _lastEngineRestartMs = 0
const ENGINE_RESTART_THRESHOLD = 1      // 1 × 5-min tick = restart after the first failed health check
/** Minimum gap between restart attempts within one outage. Long enough that a
 *  slow-booting engine is not restarted mid-boot, short enough that a failed
 *  restart is retried the same hour. */
const ENGINE_RESTART_COOLDOWN_MS = 30 * 60 * 1000

/**
 * Consecutive zero-fetched poll counter.  Incremented each tick that the
 * signal poll returns fetched=0; reset to zero when fetched>0 or when the
 * poll fails entirely.  Passed to checkSignalDrought in the monitor phase
 * so it can fire the drought alert after 1 hour of silence.
 */
let _consecutiveZeroPollCount = 0

/**
 * Per-asset consecutive-halt confirmation counter for phantom positions
 * ("local qty=X but broker shows no position"). A phantom can be a real
 * holding the broker is just under-reporting on a transient blip, so we
 * never zero it on the first sighting. It heals only after the same asset
 * appears in PHANTOM_CONFIRM_TICKS consecutive halted ticks AND its local
 * market value is under PHANTOM_HEAL_MAX_USD. Reset to {} when the
 * reconciler recovers. adopt-from-broker reconciles local to broker truth
 * in either direction (it zeroes a phantom).
 */
let _phantomConfirm: Record<string, number> = {}
const PHANTOM_CONFIRM_TICKS = 2     // 2 × 5-min ticks ≈ 10 min broker-flat confirmation
const PHANTOM_HEAL_MAX_USD = 2000   // only auto-zero phantoms under this local market value

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

  // Crash recovery: any signal stuck in 'dispatching' from a prior bot
  // process never finished its dispatch loop (likely killed mid-claim).
  // Reset them to 'pending' so the next tick picks them up; otherwise
  // autoDispatchPendingSignals' "WHERE status = 'pending'" query silently
  // returns 0 rows and the queue stays frozen across restarts.
  try {
    const reset = deps.db
      .prepare("UPDATE trader_signals SET status = 'pending' WHERE status = 'dispatching'")
      .run()
    if (reset.changes > 0) {
      logger.warn(
        { resetCount: reset.changes },
        'Trader scheduler: reset stuck dispatching rows on startup',
      )
    }
  } catch (err) {
    logger.warn({ err }, 'Trader scheduler: dispatching-row reset failed (non-fatal)')
  }

  // Crash recovery: decision rows left at 'submitting' mean the process crashed
  // after the INSERT but before the engine ACK.  On restart the signal is reset
  // to 'pending' (above) so it re-enters dispatch with a new decisionId.  Mark
  // the orphaned decision rows 'failed' so they don't pollute audit queries and
  // so the duplicate guard (engine_order_id IS NOT NULL) can never falsely match
  // them (it won't -- NULL != NOT NULL -- but 'failed' makes intent explicit).
  try {
    const orphaned = deps.db
      .prepare("UPDATE trader_decisions SET status = 'failed' WHERE status = 'submitting'")
      .run()
    if (orphaned.changes > 0) {
      logger.warn(
        { count: orphaned.changes },
        'Trader scheduler: marked orphaned submitting decisions as failed on startup',
      )
    }
  } catch (err) {
    logger.warn({ err }, 'Trader scheduler: submitting-row cleanup failed (non-fatal)')
  }

  // Crash recovery: engine_down is a park, not a grave. On boot, return
  // those decisions to retry_pending so the first healthy tick resumes
  // them. submitted / pending_fill / retry_pending are left alone -- the
  // reconcile and retry phases reconcile them against the broker each tick.
  try {
    const revived = deps.db
      .prepare("UPDATE trader_decisions SET status = 'retry_pending', next_retry_at = ? WHERE status = 'engine_down'")
      .run(Date.now())
    if (revived.changes > 0) {
      logger.warn({ count: revived.changes }, 'Trader scheduler: revived engine_down decisions to retry_pending on startup')
    }
  } catch (err) {
    logger.warn({ err }, 'Trader scheduler: engine_down revival failed (non-fatal)')
  }

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
    _consecutiveZeroPollCount = 0
    logger.info('Trader scheduler stopped')
  }
}

/** Reset halt-alert state. Exposed for tests only -- do not call in production code. */
export function _resetHaltAlertForTest(): void {
  _haltAlertSent = false
  _phantomConfirm = {}
  _healthCheckConsecutiveFailures = 0
  _lastEngineRestartMs = 0
}

/** Reset tick lock state. Exposed for tests only -- do not call in production code. */
export function _resetTickLockForTest(): void {
  _tickInProgress = false
}

/** Read + reset the zero-poll counter. Exposed for tests only. */
export function _getAndResetZeroPollCountForTest(): number {
  const v = _consecutiveZeroPollCount
  _consecutiveZeroPollCount = 0
  return v
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
/** True when a decision awaiting retry is a crypto pair, which trades 24/7. */
function hasRetryableCryptoDecisions(db: Database.Database): boolean {
  try {
    const row = db.prepare(
      "SELECT 1 FROM trader_decisions WHERE status IN ('retry_pending','engine_down') AND asset LIKE '%/%' LIMIT 1",
    ).get()
    return row !== undefined
  } catch {
    return false
  }
}

/** True when any pending signal is a crypto pair, which trades 24/7. */
function hasPendingCryptoSignals(db: Database.Database): boolean {
  try {
    const row = db.prepare(
      "SELECT 1 FROM trader_signals WHERE status = 'pending' AND asset LIKE '%/%' LIMIT 1",
    ).get()
    return row !== undefined
  } catch {
    return false
  }
}

export async function runTraderTick(deps: TraderSchedulerDeps): Promise<{
  polled: boolean
  sent: number
  reconcilerHalted: boolean
  closedOut: number
  exited: number
  exitErrors: number
  weeklyReportFired: boolean
  skipped?: boolean
}> {
  if (_tickInProgress) {
    logger.info('Trader tick skipped: previous tick still running')
    return {
      polled: false,
      sent: 0,
      reconcilerHalted: false,
      closedOut: 0,
      exited: 0,
      exitErrors: 0,
      weeklyReportFired: false,
      skipped: true,
    }
  }
  _tickInProgress = true

  let polled = false
  let sent = 0
  let reconcilerHalted = false
  let closedOut = 0
  let exited = 0
  let exitErrors = 0
  let weeklyReportFired = false

  try {
  // 0. Health check -- detect reconciler halt and alert once per halt event.
  // getHealth returns null on 404 (older engine build without /health) or on
  // network error; treat that as "unknown, do not toggle the halt alert".
  try {
    const client = deps.getEngineClient()
    // Reachability first. getHealth returns null for BOTH "route 404s" and
    // "fetch timed out", so a wedged engine (port in LISTEN, event loop
    // blocked, nothing ever served) used to fall through to the success path
    // below and reset the counter -- which is why the auto-restart never
    // fired during the 13h wedge on 2026-07-20. Throwing here routes a wedge
    // into the same catch block that a refused connection already uses.
    const reachable = await client.pingHealth()
    if (!reachable) {
      throw new Error('Engine health probe timed out — process may be wedged')
    }
    const health = await client.getHealth()
    // Engine reachable -- reset unreachable counter and send recovery notice if needed.
    if (_healthCheckConsecutiveFailures > 0) {
      logger.info({ was: _healthCheckConsecutiveFailures }, 'Trader engine reachable again')
    }
    _healthCheckConsecutiveFailures = 0
    _lastEngineRestartMs = 0
    // Engine-unreachable alerting + recovery notice now live in the
    // persistent monitor check (evaluateAndRecordEngineUnreachable), which
    // survives bot restarts. This phase keeps only the in-memory counter
    // that drives the per-process SSH auto-restart below.
    if (health && health.reconciler_halted === true) {
      reconcilerHalted = true
      const reason = health.halt_reason ?? 'no reason provided'

      // Auto-heal patterns (broker is source of truth). adopt-from-broker
      // reconciles the local engine row to broker truth in either direction.
      //   Safe (heal on first sighting):
      //     1. "broker shows qty=X but local has no record" — engine missed a fill
      //     2. "qty mismatch local=X broker=Y" where broker > local — fill landed, engine stale
      //     3. "notional mismatch local=$X broker=$Y" — qty agrees, only the $ mark drifted
      //        (intraday price staleness). Adopting refreshes local to broker truth.
      //   Phantom ("local qty=X but broker shows no position") — local-only. Could be a
      //     real holding the broker is briefly under-reporting, so it heals only after
      //     PHANTOM_CONFIRM_TICKS consecutive halts name it AND its local market value is
      //     under PHANTOM_HEAL_MAX_USD. Otherwise it falls through to a manual alert.
      const brokerOnlyAssets = [
        ...[...reason.matchAll(/(\w[\w/]*):\s*broker shows qty=[\d.]+ but local has no record/g)].map(m => m[1]),
        ...[...reason.matchAll(/(\w[\w/]*):\s*qty mismatch local=([\d.]+) broker=([\d.]+)/g)]
          .filter(m => parseFloat(m[3]) > parseFloat(m[2]))  // only when broker > local
          .map(m => m[1]),
        ...[...reason.matchAll(/(\w[\w/]*):\s*notional mismatch /g)].map(m => m[1]),
      ]
      const phantomAssets = [
        ...reason.matchAll(/(\w[\w/]*):\s*local (?:has\s*qty|qty=)?\s*[\d.]+ but broker shows no/gi),
      ].map(m => m[1])

      // Advance the per-asset confirm counter every halted tick. Assets no longer
      // named drop out, so a cleared-then-recurring phantom restarts the count.
      const nextConfirm: Record<string, number> = {}
      for (const a of phantomAssets) nextConfirm[a] = (_phantomConfirm[a] ?? 0) + 1
      _phantomConfirm = nextConfirm

      // Look up local market value for phantoms (unknown -> treat as over cap).
      let positionValue: Record<string, number> = {}
      if (phantomAssets.length > 0) {
        try {
          const positions = await deps.getEngineClient().getPositions()
          positionValue = Object.fromEntries(positions.map(p => [p.asset, Math.abs(p.market_value ?? 0)]))
        } catch (err) {
          logger.warn({ err }, 'Trader: getPositions failed during phantom heal check')
        }
      }
      const blockedPhantoms = phantomAssets.filter(a =>
        (_phantomConfirm[a] ?? 0) < PHANTOM_CONFIRM_TICKS ||
        (positionValue[a] ?? Infinity) > PHANTOM_HEAL_MAX_USD
      )
      const healableAssets = [
        ...brokerOnlyAssets,
        ...phantomAssets.filter(a => !blockedPhantoms.includes(a)),
      ]

      if (blockedPhantoms.length === 0 && healableAssets.length > 0) {
        logger.info({ assets: healableAssets }, 'Trader: auto-adopting positions to clear halt')
        try {
          const client = deps.getEngineClient()
          for (const asset of healableAssets) {
            const result = await client.adoptBrokerPosition(asset)
            logger.info({ asset, result }, 'Trader: auto-adopted position')
          }
          await client.clearReconcilerHalt()
          reconcilerHalted = false
          _haltAlertSent = false
          _phantomConfirm = {}
          logger.info('Trader: reconciler halt auto-cleared')
          await deps.send(renderAlert(explainPositionMismatch(healableAssets, true)))
        } catch (err) {
          logger.error({ err }, 'Trader: auto-adopt failed, falling back to manual alert')
          if (!_haltAlertSent) {
            _haltAlertSent = true
            await deps.send(renderAlert(explainPositionMismatch(healableAssets, false)))
          }
        }
      } else if (!_haltAlertSent) {
        // Nothing healable yet: phantom awaiting confirmation / over the $ cap, or unparseable.
        _haltAlertSent = true
        logger.error({ halt_reason: reason, blockedPhantoms }, 'Trader engine reconciler halted')
        const detail = blockedPhantoms.length > 0
          ? ` Phantom (${blockedPhantoms.join(', ')}) held for review — auto-heal needs ${PHANTOM_CONFIRM_TICKS} confirms and value under $${PHANTOM_HEAL_MAX_USD}.`
          : ''
        await deps.send(renderAlert(explainPositionMismatch(blockedPhantoms, blockedPhantoms.length > 0 ? 'checking' : 'stuck')))
      }
    } else if (health) {
      // Reconciler recovered -- reset flags so we alert / re-confirm on the next halt.
      if (_haltAlertSent) {
        logger.info('Trader engine reconciler recovered')
        _haltAlertSent = false
      }
      _phantomConfirm = {}
    }

    // Go-live gate enforcement: the engine must never run in live mode
    // unless the last persisted gate evaluation passed. Survives bot
    // restarts because the result lives in kv_settings.
    if (health && health.alpaca_mode === 'live') {
      const { readLastGateResult } = await import('./go-live-gate.js')
      const gate = readLastGateResult(deps.db)
      if (!gate?.passed) {
        logger.error({ gate }, 'Trader: engine in LIVE mode without a passed go-live gate, halting')
        try {
          await client.haltTrading('go-live gate not passed')
        } catch (haltErr) {
          logger.error({ err: haltErr }, 'Trader: halt call failed while blocking ungated live mode')
        }
        await deps.send(
          'TRADER ALERT: engine switched to LIVE mode but the go-live validation gate has not passed. ' +
          'Trading halted. Flip the engine back to paper or clear the gate first.',
        ).catch(() => {})
      }
    }
  } catch (err) {
    _healthCheckConsecutiveFailures++
    // If the engine was previously halted (_haltAlertSent=true) and health is
    // now unreachable, keep reconcilerHalted=true so dispatch stays blocked.
    // This prevents a Tailscale blip from silently re-opening the dispatch gate
    // while the underlying halt condition is still active.
    if (_haltAlertSent) reconcilerHalted = true
    logger.warn({ err, consecutiveFailures: _healthCheckConsecutiveFailures }, 'Trader tick: health check failed')
    // Auto-restart: after ENGINE_RESTART_THRESHOLD failures during market hours,
    // SSH-restart the engine once per outage event. Fires before the alert so
    // the operator message can reflect the restart attempt.
    //
    // Deliberately NOT gated on market hours. It used to be, which meant an
    // engine that wedged at 17:00 stayed dead until 09:30 the next morning:
    // sixteen hours with no reconciliation and no exit evaluation, and crypto
    // trades around the clock, so those positions spent the night with no
    // stop-loss cover at all. Restarting a service that is not answering is
    // safe at any hour.
    //
    // The old one-shot latch is now a cooldown, so a restart that does not
    // take is retried rather than being the only attempt of the outage. The
    // cooldown is what stops it becoming a restart loop.
    const restartDue =
      _lastEngineRestartMs === 0 ||
      Date.now() - _lastEngineRestartMs >= ENGINE_RESTART_COOLDOWN_MS
    if (
      _healthCheckConsecutiveFailures >= ENGINE_RESTART_THRESHOLD &&
      restartDue &&
      deps.restartEngineAsync
    ) {
      const isRetry = _lastEngineRestartMs !== 0
      _lastEngineRestartMs = Date.now()
      logger.warn(
        { consecutiveFailures: _healthCheckConsecutiveFailures, isRetry },
        'Trader engine unreachable: attempting restart',
      )
      deps.restartEngineAsync()
      await deps.send(renderAlert(explainServiceDown(_healthCheckConsecutiveFailures * 5, true)))
    }
    // The sustained-outage page is emitted by the persistent monitor check
    // (evaluateAndRecordEngineUnreachable in runMonitorPhase), not here --
    // its outage clock lives in trader_alert_state and re-nags hourly,
    // where this in-memory counter would reset to 0 on every bot restart.
  }

  // 1. Poll engine for fresh signals.
  try {
    const client = deps.getEngineClient()
    const pollResult = await pollAndStoreSignals(deps.db, client)
    polled = true
    // Only count consecutive zero-fetched ticks during market hours.
    // Outside NYSE hours equity signals legitimately stop; accumulating
    // the counter overnight causes a spurious drought alert on the first
    // market-hours tick of the next session (false positive).
    if (pollResult.fetched > 0) {
      _consecutiveZeroPollCount = 0
    } else if (isEquityMarketHours()) {
      _consecutiveZeroPollCount++
    } else {
      _consecutiveZeroPollCount = 0
    }
  } catch (err) {
    // Poll error ≠ signal drought.  The engine may be unreachable, which is a
    // separate condition covered by the ENGINE_UNREACHABLE_THRESHOLD alert in
    // the health-check section above.  Incrementing the drought counter on every
    // throw would fire a "no signals" alert during an engine outage, which is the
    // wrong framing and causes two simultaneous alarms for the same root cause.
    // Do not touch _consecutiveZeroPollCount here.
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

  // 1c. Reconcile open orders against the broker BEFORE placing new ones.
  //     Promotes submitted -> executed on confirmed fills, advances
  //     submitted -> pending_fill while live, marks canceled/rejected as
  //     failed. Engine-unreachable is a no-op (no mutation). Source of
  //     truth is GET /orders. Skipped when the reconciler is halted, same
  //     gate as auto-dispatch below.
  if (!reconcilerHalted) {
    try {
      const client = deps.getEngineClient()
      const rec = await reconcileOpenOrders(deps.db, client, deps.send)
      if (rec.promotedToFilled > 0 || rec.canceledOrRejected > 0) {
        logger.info(rec, 'Trader tick: order reconcile applied transitions')
      }
    } catch (err) {
      logger.warn({ err }, 'Trader tick: order reconcile failed')
    }
  }

  // 1d. Retry sweep for transient submit failures. Runs after reconcile so
  //     any order that actually reached the broker is already tracked and
  //     never resent. engineHealthy gates the engine_down resume: a healthy
  //     engine (health check reset _healthCheckConsecutiveFailures to 0)
  //     un-parks engine_down rows so they resume cleanly.
  //     Skipped outside NYSE hours unless a crypto decision is waiting: an
  //     equity resubmit into a closed market returns 422 market_closed, and
  //     the sweep charges that to submit_attempts. Three ticks of that (15
  //     minutes) parks a perfectly good decision at engine_down for the whole
  //     overnight, having burned its entire retry budget on a condition that
  //     was never the decision's fault.
  if (!reconcilerHalted && ((deps.isMarketOpen ?? isEquityMarketHours)() || hasRetryableCryptoDecisions(deps.db))) {
    try {
      const client = deps.getEngineClient()
      const engineHealthy = _healthCheckConsecutiveFailures === 0
      const rs = await runRetrySweep(deps.db, client, Date.now(), engineHealthy)
      if (rs.resubmitted > 0 || rs.parkedEngineDown > 0 || rs.resumedFromEngineDown > 0) {
        logger.info(rs, 'Trader tick: retry sweep applied transitions')
      }
    } catch (err) {
      logger.warn({ err }, 'Trader tick: retry sweep failed')
    }
  }

  // 1e. Converge signal status onto decision status (pure SQL, no engine).
  //     The retry sweep + reconciler advance DECISIONS but never touched
  //     SIGNALS, so a transient submit failure left signals at 'dispatching'
  //     forever and the partial unique index froze that asset+side until the
  //     next reboot (Jun 9 2026: VTI/SPY/QQQ/IWM frozen for two days). Runs
  //     after reconcile/retry so it sees this tick's decision transitions,
  //     and before auto-dispatch so freed slots are usable immediately.
  try {
    syncSignalStatuses(deps.db, Date.now())
  } catch (err) {
    logger.warn({ err }, 'Trader tick: signal state sync failed')
  }

  // 2. Auto-dispatch pending signals through the committee.
  // Skipped when the reconciler is halted: dispatching signals while the engine
  // cannot reconcile orders would push approvals that can never execute, which
  // misleads the operator and wastes committee budget. Wait for the halt to
  // clear (signalled by reconcilerHalted returning to false next tick).
  // Also skipped outside NYSE hours. The engine rejects equity submissions
  // with 422 market_closed, and dispatching into that burns committee budget
  // and (before market_closed was reclassified as transient) killed the
  // decision outright while paging the operator after hours. Signals stay
  // pending and go out on the first in-hours tick. Crypto is unaffected --
  // it has its own 24/7 path and no equity signal survives this gate.
  if (reconcilerHalted) {
    logger.info('Trader tick: skipping auto-dispatch because reconciler is halted')
  } else if (!(deps.isMarketOpen ?? isEquityMarketHours)() && !hasPendingCryptoSignals(deps.db)) {
    logger.info('Trader tick: skipping auto-dispatch, NYSE closed and no crypto signals pending')
  } else {
    try {
      const dispatched = await autoDispatchPendingSignals(deps.db, {
        send: deps.send,
        alertOnReject: process.env.TRADER_ALERT_ON_REJECT === 'true',
      })
      sent = dispatched.length
    } catch (err) {
      logger.error({ err }, 'Trader tick: auto-dispatch failed')
    }
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

  // 4b. Exit sweep -- close positions that hit a stop / target / time-stop
  //     / momentum-decay trigger. Deterministic, no LLM. This is the only
  //     phase that emits a sell. Skipped when the reconciler is halted for
  //     the same reason auto-dispatch is: an exit that cannot reconcile is
  //     worse than waiting one tick. Engine-unreachable is tolerated (the
  //     sweep returns errors=1 and we log + move on).
  if (reconcilerHalted) {
    logger.info('Trader tick: skipping exit sweep because reconciler is halted')
  } else {
    try {
      const client = deps.getEngineClient()
      const sweep = await runExitSweep(deps.db, client, deps.send)
      exited = sweep.exited
      exitErrors = sweep.errors
      if (sweep.exited > 0 || sweep.errors > 0) {
        logger.warn({ exited: sweep.exited, checked: sweep.checked, errors: sweep.errors }, 'Trader tick: exit sweep closed positions')
      }
    } catch (err) {
      logger.warn({ err }, 'Trader tick: exit sweep failed')
    }
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

  // 5a-bis. Weekly go-live gate evaluation against broker truth. Persists
  //     the result (the live-mode guard in phase 0 enforces it) and buffers
  //     a plain-English progress summary into the digest.
  try {
    const { gateRunDue, runGoLiveGate, readLastGateResult, renderGateSummary } = await import('./go-live-gate.js')
    if (gateRunDue(deps.db, Date.now())) {
      const prev = readLastGateResult(deps.db)
      const gate = await runGoLiveGate(deps.db, deps.getEngineClient())
      logger.info({ passed: gate.passed, roundTrips: gate.roundTrips }, 'Trader tick: go-live gate evaluated')
      // Transition alerts fire instantly (TRADER ALERT matches the digest
      // issue pattern); the routine summary buffers into the digest.
      if (gate.passed && !prev?.passed) {
        await deps.send(
          'TRADER ALERT: GO-LIVE GATE PASSED. All validation criteria met on paper. ' +
          'Ready to discuss switching the engine from paper to real money.\n\n' + renderGateSummary(gate),
        ).catch(() => {})
      } else if (!gate.passed && prev?.passed) {
        await deps.send(
          'TRADER ALERT: go-live gate REGRESSED from passed to failed. Live flip is blocked again.\n\n' +
          renderGateSummary(gate),
        ).catch(() => {})
      } else {
        await deps.send(renderGateSummary(gate)).catch(() => {})
      }
    }
  } catch (err) {
    logger.warn({ err }, 'Trader tick: go-live gate evaluation failed')
  }

  // 5b. Twice-daily plain-English digest of routine activity. Routine messages
  //     are buffered by the digesting send (notify-digest.ts); this drains them
  //     into one summary at the 08:00 / 20:00 slots. Uses rawSend so the digest
  //     itself is never re-buffered. Own try/catch so a failure never stalls the
  //     monitor phase below.
  try {
    const dg = await maybeFireTraderDigest({ db: deps.db, send: deps.rawSend ?? deps.send })
    if (dg.fired) logger.info({ count: dg.count }, 'Trader tick: daily digest fired')
  } catch (err) {
    logger.warn({ err }, 'Trader tick: digest gate failed')
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

  return { polled, sent, reconcilerHalted, closedOut, exited, exitErrors, weeklyReportFired }
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

  // 1b. Abstain rate -- fires when abstains / decisions >= 40% over 24h with
  //     minimum volume. Dedup row written inside checkAbstainRate on fire.
  try {
    const rr = checkAbstainRate(deps.db, nowMs)
    if (rr.fired && rr.message) {
      await deps.send(rr.message)
      logger.info({ rate: rr.rate, abstains: rr.abstains, decisions: rr.decisions }, 'Trader tick: abstain rate alert sent')
    }
  } catch (err) {
    logger.error({ err }, 'Trader tick: abstain rate check failed')
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
  // 5. Signal drought alert -- runs unconditionally (no engine client needed).
  //    Fires after 1 hour of consecutive zero-fetched polls so a broken
  //    signal generator (e.g. Alpaca DNS timeout) surfaces to the operator
  //    within an hour rather than silently going unnoticed for days.
  try {
    const drought = checkSignalDrought(deps.db, nowMs, _consecutiveZeroPollCount)
    if (drought.fire && drought.message) {
      recordAlertFired(deps.db, SIGNAL_DROUGHT_ALERT_ID, nowMs)
      await deps.send(drought.message)
      logger.warn({ consecutiveZeros: _consecutiveZeroPollCount }, 'Trader tick: signal drought alert sent')
    }
  } catch (err) {
    logger.warn({ err }, 'Trader tick: signal drought check failed')
  }

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

  // 3b. Engine-unreachable alert -- persistent outage clock + hourly re-nag.
  //     State lives in trader_alert_state so an outage spanning bot
  //     restarts still pages (the old in-memory counter reset on every
  //     launchd respawn and went silent for the 06-15..06-25 freeze).
  try {
    const r = await evaluateAndRecordEngineUnreachable(deps.db, nowMs, () => client!.getHealth())
    if (r.fire && r.message) {
      recordAlertFired(deps.db, 'engine_unreachable_alert', nowMs)
      await deps.send(r.message)
      logger.error('Trader tick: engine-unreachable alert sent')
    } else if (r.recovered) {
      await deps.send(renderAlert(explainServiceBack()))
      logger.info('Trader tick: engine reachable again, recovery notice sent')
    }
  } catch (err) {
    logger.error({ err }, 'Trader tick: engine-unreachable check failed')
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

  // 6. Alpaca health alert -- fires when alpaca_connected === false persists
  //    for 15+ min.  Separate from the Coinbase check; both brokers are
  //    monitored independently.
  try {
    const alpaca = await evaluateAlpacaHealth(deps.db, nowMs, () => client!.getHealth())
    if (alpaca.fire && alpaca.message) {
      recordAlertFired(deps.db, ALPACA_DOWN_ALERT_ID, nowMs)
      await deps.send(alpaca.message)
      logger.warn('Trader tick: Alpaca health alert sent')
    }
  } catch (err) {
    logger.warn({ err }, 'Trader tick: Alpaca health check failed')
  }
}
