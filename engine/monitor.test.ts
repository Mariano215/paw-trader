/**
 * monitor.test.ts -- Phase 5 Task 2.
 *
 * Covers the two alert checks built in dispatch A:
 *   - checkAbstainDigest            (>=4 committee abstains in past 24h, 12h dedup)
 *   - evaluateAndRecordSharpeFlip   (active strategy flips rolling_sharpe from + to -)
 *
 * Dispatch C wires these into the trader scheduler. This suite only
 * exercises the check functions + the shared state helper.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'

import { initTraderTables } from './db.js'
import { seedAllStrategies } from './strategy-manager.js'
import {
  checkAbstainDigest,
  evaluateAndRecordSharpeFlip,
  evaluateAndRecordCoinbaseHealth,
  evaluateAndRecordNavDrop,
  recordAlertFired,
  ABSTAIN_THRESHOLD,
  ABSTAIN_WINDOW_MS,
  ABSTAIN_DEDUP_MS,
  ABSTAIN_THESIS_MAX_LEN,
  SHARPE_FLIP_MAX_ENTRIES,
  COINBASE_OUTAGE_THRESHOLD_MS,
  COINBASE_DEDUP_MS,
  NAV_DROP_WINDOW_MS,
  NAV_DROP_DEDUP_MS,
  NAV_DROP_DEFAULT_THRESHOLD,
} from './monitor.js'

function makeDb() {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = OFF')
  initTraderTables(db)
  seedAllStrategies(db)
  return db
}

function insertSignal(db: Database.Database, id: string, strategy = 'momentum-stocks') {
  db.prepare(`
    INSERT INTO trader_signals (id, strategy_id, asset, side, raw_score, horizon_days, generated_at, status)
    VALUES (?, ?, 'AAPL', 'buy', 0.7, 20, ?, 'decided')
  `).run(id, strategy, Date.now())
}

function insertAbstain(
  db: Database.Database,
  id: string,
  signalId: string,
  decidedAt: number,
  opts: { asset?: string; thesis?: string } = {},
) {
  db.prepare(`
    INSERT INTO trader_decisions
      (id, signal_id, action, asset, size_usd, entry_type, thesis, confidence,
       committee_transcript_id, decided_at, status)
    VALUES (?, ?, 'abstain', ?, 0, 'none', ?, 0.1, NULL, ?, 'committee_abstain')
  `).run(
    id,
    signalId,
    opts.asset ?? 'AAPL',
    opts.thesis ?? 'committee could not agree',
    decidedAt,
  )
}

function insertNonAbstainDecision(
  db: Database.Database,
  id: string,
  signalId: string,
  decidedAt: number,
  status = 'committed',
) {
  db.prepare(`
    INSERT INTO trader_decisions
      (id, signal_id, action, asset, size_usd, entry_type, thesis, confidence,
       committee_transcript_id, decided_at, status)
    VALUES (?, ?, 'buy', 'AAPL', 100, 'limit', 'thesis', 0.7, NULL, ?, ?)
  `).run(id, signalId, decidedAt, status)
}

function upsertTrackRecord(
  db: Database.Database,
  strategyId: string,
  tradeCount: number,
  rollingSharpe: number,
) {
  db.prepare(`
    INSERT INTO trader_strategy_track_record
      (strategy_id, trade_count, win_count, rolling_sharpe,
       avg_winner_pct, avg_loser_pct, max_dd_pct, net_pnl_usd, computed_at)
    VALUES (?, ?, 0, ?, 0, 0, 0, 0, ?)
    ON CONFLICT(strategy_id) DO UPDATE SET
      trade_count = excluded.trade_count,
      rolling_sharpe = excluded.rolling_sharpe,
      computed_at = excluded.computed_at
  `).run(strategyId, tradeCount, rollingSharpe, Date.now())
}

describe('monitor: checkAbstainDigest', () => {
  let db: ReturnType<typeof makeDb>
  const NOW = 1_700_000_000_000

  beforeEach(() => { db = makeDb() })

  it('fires when 4 abstains exist in the past 24h and no recent alert', () => {
    for (let i = 0; i < ABSTAIN_THRESHOLD; i++) {
      insertSignal(db, `sig-${i}`)
      insertAbstain(db, `dec-${i}`, `sig-${i}`, NOW - 1000, {
        asset: `AST${i}`,
        thesis: `thesis ${i}`,
      })
    }

    const result = checkAbstainDigest(db, NOW)
    expect(result.fire).toBe(true)
    expect(result.count).toBe(4)
    expect(result.message).toBeTruthy()
  })

  it('does not fire when only 2 abstains exist in the past 24h', () => {
    for (let i = 0; i < 2; i++) {
      insertSignal(db, `sig-${i}`)
      insertAbstain(db, `dec-${i}`, `sig-${i}`, NOW - 1000)
    }

    const result = checkAbstainDigest(db, NOW)
    expect(result.fire).toBe(false)
  })

  it('does not fire when within the 12h dedup window even with 5 abstains', () => {
    for (let i = 0; i < 5; i++) {
      insertSignal(db, `sig-${i}`)
      insertAbstain(db, `dec-${i}`, `sig-${i}`, NOW - 1000)
    }
    // Last fired 6h ago, still inside the 12h dedup window.
    recordAlertFired(db, 'abstain_digest', NOW - 6 * 60 * 60 * 1000)

    const result = checkAbstainDigest(db, NOW)
    expect(result.fire).toBe(false)
  })

  it('fires again when 5 abstains and the stored last_alerted_at is 13h old', () => {
    for (let i = 0; i < 5; i++) {
      insertSignal(db, `sig-${i}`)
      insertAbstain(db, `dec-${i}`, `sig-${i}`, NOW - 1000)
    }
    recordAlertFired(db, 'abstain_digest', NOW - 13 * 60 * 60 * 1000)

    const result = checkAbstainDigest(db, NOW)
    expect(result.fire).toBe(true)
    expect(result.count).toBe(5)
  })

  it('ignores abstains older than 24 hours', () => {
    for (let i = 0; i < 5; i++) {
      insertSignal(db, `sig-${i}`)
      // Each abstain is a day + an hour old, well outside the window.
      insertAbstain(db, `dec-${i}`, `sig-${i}`, NOW - ABSTAIN_WINDOW_MS - 3600_000)
    }

    const result = checkAbstainDigest(db, NOW)
    expect(result.fire).toBe(false)
  })

  it('counts only committee_abstain rows, not committed decisions', () => {
    for (let i = 0; i < 2; i++) {
      insertSignal(db, `sig-ab-${i}`)
      insertAbstain(db, `dec-ab-${i}`, `sig-ab-${i}`, NOW - 1000)
    }
    // 5 non-abstain decisions in the same window should not count.
    for (let i = 0; i < 5; i++) {
      insertSignal(db, `sig-ok-${i}`)
      insertNonAbstainDecision(db, `dec-ok-${i}`, `sig-ok-${i}`, NOW - 1000)
    }

    const result = checkAbstainDigest(db, NOW)
    expect(result.fire).toBe(false)
  })

  it('message contains the count and up to 3 sample asset/thesis pairs', () => {
    const samples = [
      { asset: 'AAPL', thesis: 'thesis AAPL' },
      { asset: 'MSFT', thesis: 'thesis MSFT' },
      { asset: 'QQQ',  thesis: 'thesis QQQ' },
      { asset: 'SPY',  thesis: 'thesis SPY' },
      { asset: 'NVDA', thesis: 'thesis NVDA' },
    ]
    samples.forEach((s, i) => {
      insertSignal(db, `sig-${i}`)
      insertAbstain(db, `dec-${i}`, `sig-${i}`, NOW - (i + 1) * 60_000, s)
    })

    const result = checkAbstainDigest(db, NOW)
    expect(result.fire).toBe(true)
    expect(result.count).toBe(5)
    // Count line present.
    expect(result.message).toContain('5')
    // Exactly 3 samples, not 4 or 5.
    let sampleHits = 0
    for (const s of samples) {
      if (result.message!.includes(s.asset)) sampleHits++
    }
    expect(sampleHits).toBe(3)
  })

  // Review fix #5 -- one runaway thesis must not dwarf the whole alert.
  it('truncates thesis longer than ABSTAIN_THESIS_MAX_LEN with an ellipsis', () => {
    const longThesis = 'A'.repeat(500)
    const shortThesis = 'B'.repeat(50)

    for (let i = 0; i < 3; i++) insertSignal(db, `sig-long-${i}`)
    insertAbstain(db, 'dec-long-0', 'sig-long-0', NOW - 1000, {
      asset: 'LONG', thesis: longThesis,
    })
    insertAbstain(db, 'dec-long-1', 'sig-long-1', NOW - 2000, {
      asset: 'SHRT', thesis: shortThesis,
    })
    insertAbstain(db, 'dec-long-2', 'sig-long-2', NOW - 3000, {
      asset: 'BNDY', thesis: 'C'.repeat(ABSTAIN_THESIS_MAX_LEN),
    })
    insertSignal(db, 'sig-long-3')
    insertAbstain(db, 'dec-long-3', 'sig-long-3', NOW - 4000)  // 4th to trip threshold

    const result = checkAbstainDigest(db, NOW)
    expect(result.fire).toBe(true)

    // Long thesis: present truncated + ellipsis, not the full 500 chars.
    expect(result.message).toContain('A'.repeat(ABSTAIN_THESIS_MAX_LEN) + '...')
    expect(result.message).not.toContain('A'.repeat(ABSTAIN_THESIS_MAX_LEN + 1))

    // Shorter theses untouched.
    expect(result.message).toContain(shortThesis)
    expect(result.message).not.toContain('B'.repeat(50) + '...')

    // Exactly-at-threshold thesis is NOT truncated (only > triggers).
    expect(result.message).toContain('C'.repeat(ABSTAIN_THESIS_MAX_LEN))
    expect(result.message).not.toContain('C'.repeat(ABSTAIN_THESIS_MAX_LEN) + '...')
  })
})

describe('monitor: recordAlertFired', () => {
  let db: ReturnType<typeof makeDb>

  beforeEach(() => { db = makeDb() })

  it('inserts on first call and updates on second call without erroring', () => {
    recordAlertFired(db, 'abstain_digest', 1000)
    const rowAfterInsert = db
      .prepare("SELECT last_alerted_at FROM trader_alert_state WHERE alert_id='abstain_digest'")
      .get() as { last_alerted_at: number }
    expect(rowAfterInsert.last_alerted_at).toBe(1000)

    recordAlertFired(db, 'abstain_digest', 2000)
    const rowAfterUpdate = db
      .prepare("SELECT last_alerted_at FROM trader_alert_state WHERE alert_id='abstain_digest'")
      .get() as { last_alerted_at: number }
    expect(rowAfterUpdate.last_alerted_at).toBe(2000)

    // Still a single row for this alert_id.
    const count = db
      .prepare("SELECT COUNT(*) as c FROM trader_alert_state WHERE alert_id='abstain_digest'")
      .get() as { c: number }
    expect(count.c).toBe(1)
  })
})

describe('monitor: evaluateAndRecordSharpeFlip', () => {
  let db: ReturnType<typeof makeDb>
  const NOW = 1_700_000_000_000

  beforeEach(() => { db = makeDb() })

  it('fires when an active strategy with 40 trades flips from positive to negative', () => {
    upsertTrackRecord(db, 'momentum-stocks', 40, -0.4)
    // Seed a prior positive sign.
    recordAlertFired(db, 'sharpe_last_sign:momentum-stocks', 1)

    const result = evaluateAndRecordSharpeFlip(db, NOW)
    expect(result.fire).toBe(true)
    expect(result.message).toContain('momentum-stocks')
    expect(result.message).toContain('-0.40')
  })

  it('does not fire when strategy was already negative (no flip)', () => {
    upsertTrackRecord(db, 'momentum-stocks', 40, -0.4)
    recordAlertFired(db, 'sharpe_last_sign:momentum-stocks', -1)

    const result = evaluateAndRecordSharpeFlip(db, NOW)
    expect(result.fire).toBe(false)
  })

  it('skips strategies with trade_count below the sample size threshold', () => {
    upsertTrackRecord(db, 'momentum-stocks', 19, -0.5)
    recordAlertFired(db, 'sharpe_last_sign:momentum-stocks', 1)

    const result = evaluateAndRecordSharpeFlip(db, NOW)
    expect(result.fire).toBe(false)
  })

  it('skips paused strategies', () => {
    upsertTrackRecord(db, 'momentum-stocks', 40, -0.4)
    recordAlertFired(db, 'sharpe_last_sign:momentum-stocks', 1)
    db.prepare("UPDATE trader_strategies SET status='paused' WHERE id='momentum-stocks'").run()

    const result = evaluateAndRecordSharpeFlip(db, NOW)
    expect(result.fire).toBe(false)
  })

  it('updates the stored sign so a subsequent call on the same negative sharpe does not re-fire', () => {
    upsertTrackRecord(db, 'momentum-stocks', 40, -0.4)
    recordAlertFired(db, 'sharpe_last_sign:momentum-stocks', 1)

    const first = evaluateAndRecordSharpeFlip(db, NOW)
    expect(first.fire).toBe(true)

    // Sharpe stays negative, call again -- stored sign is now -1, no flip.
    const second = evaluateAndRecordSharpeFlip(db, NOW)
    expect(second.fire).toBe(false)

    const storedRow = db
      .prepare("SELECT last_alerted_at FROM trader_alert_state WHERE alert_id='sharpe_last_sign:momentum-stocks'")
      .get() as { last_alerted_at: number }
    expect(storedRow.last_alerted_at).toBe(-1)
  })

  it('reports every strategy that flips in the same tick joined by semicolons', () => {
    upsertTrackRecord(db, 'momentum-stocks', 40, -0.3)
    upsertTrackRecord(db, 'mean-reversion-stocks', 40, -0.6)
    recordAlertFired(db, 'sharpe_last_sign:momentum-stocks', 1)
    recordAlertFired(db, 'sharpe_last_sign:mean-reversion-stocks', 1)

    const result = evaluateAndRecordSharpeFlip(db, NOW)
    expect(result.fire).toBe(true)
    expect(result.message).toContain('momentum-stocks')
    expect(result.message).toContain('mean-reversion-stocks')
    expect(result.message).toContain(';')
  })

  it('first-ever call (no prior stored sign) does not fire; seeds the state', () => {
    upsertTrackRecord(db, 'momentum-stocks', 40, -0.4)

    const result = evaluateAndRecordSharpeFlip(db, NOW)
    expect(result.fire).toBe(false)

    const storedRow = db
      .prepare("SELECT last_alerted_at FROM trader_alert_state WHERE alert_id='sharpe_last_sign:momentum-stocks'")
      .get() as { last_alerted_at: number }
    expect(storedRow.last_alerted_at).toBe(-1)
  })

  // Review fix #3 -- cap the multi-strategy message so Telegram cannot
  // truncate a regime-turn alert in the middle of a strategy id.
  it('caps the spelled-out list at SHARPE_FLIP_MAX_ENTRIES and summarises the overflow', () => {
    const TOTAL = SHARPE_FLIP_MAX_ENTRIES + 2  // 12

    // Seed TOTAL active strategies, each flipping positive -> negative.
    for (let i = 0; i < TOTAL; i++) {
      const id = `strat-${String(i).padStart(2, '0')}`
      db.prepare(`
        INSERT INTO trader_strategies
          (id, name, asset_class, tier, status, params_json, created_at, updated_at)
        VALUES (?, ?, 'stocks', 0, 'active', '{}', ?, ?)
      `).run(id, `Strategy ${i}`, Date.now(), Date.now())
      upsertTrackRecord(db, id, 40, -0.1 - i * 0.01)
      recordAlertFired(db, `sharpe_last_sign:${id}`, 1)
    }

    const result = evaluateAndRecordSharpeFlip(db, NOW)
    expect(result.fire).toBe(true)

    // Count semicolons used to join shown entries: N-1 for the N-entry
    // head plus one between head and the "... and N more" suffix is
    // NOT emitted (the suffix is appended with a space). So semicolons
    // should equal SHARPE_FLIP_MAX_ENTRIES - 1.
    const semicolonCount = (result.message!.match(/;/g) || []).length
    expect(semicolonCount).toBe(SHARPE_FLIP_MAX_ENTRIES - 1)

    const overflow = TOTAL - SHARPE_FLIP_MAX_ENTRIES
    expect(result.message).toContain(`... and ${overflow} more`)

    // First ten spelled out, last two only appear in the aggregate count.
    expect(result.message).toContain('strat-00')
    expect(result.message).toContain('strat-09')
    expect(result.message).not.toContain('strat-10')
    expect(result.message).not.toContain('strat-11')
  })

  // Review fix #8 -- pin rolling_sharpe === 0 behaviour.
  it('treats rolling_sharpe of exactly 0 as the positive bucket', () => {
    upsertTrackRecord(db, 'momentum-stocks', 40, 0)

    // Prior stored sign was -1: current 0 is treated as +1. That is not
    // a positive->negative flip, so no fire. Stored sign becomes +1.
    recordAlertFired(db, 'sharpe_last_sign:momentum-stocks', -1)
    const afterNegativePrior = evaluateAndRecordSharpeFlip(db, NOW)
    expect(afterNegativePrior.fire).toBe(false)
    const afterRow1 = db
      .prepare("SELECT last_alerted_at FROM trader_alert_state WHERE alert_id='sharpe_last_sign:momentum-stocks'")
      .get() as { last_alerted_at: number }
    expect(afterRow1.last_alerted_at).toBe(1)

    // Reset to +1 prior, current still 0: no flip, stored stays +1.
    recordAlertFired(db, 'sharpe_last_sign:momentum-stocks', 1)
    const afterPositivePrior = evaluateAndRecordSharpeFlip(db, NOW)
    expect(afterPositivePrior.fire).toBe(false)
    const afterRow2 = db
      .prepare("SELECT last_alerted_at FROM trader_alert_state WHERE alert_id='sharpe_last_sign:momentum-stocks'")
      .get() as { last_alerted_at: number }
    expect(afterRow2.last_alerted_at).toBe(1)
  })
})

describe('monitor: public constants', () => {
  it('ABSTAIN_THRESHOLD is 4 ("more than 3" means fire at >= 4)', () => {
    expect(ABSTAIN_THRESHOLD).toBe(4)
  })

  it('ABSTAIN_WINDOW_MS is 24 hours in milliseconds', () => {
    expect(ABSTAIN_WINDOW_MS).toBe(24 * 60 * 60 * 1000)
  })

  it('ABSTAIN_DEDUP_MS is 12 hours in milliseconds', () => {
    expect(ABSTAIN_DEDUP_MS).toBe(12 * 60 * 60 * 1000)
  })

  it('ABSTAIN_THESIS_MAX_LEN is 120 characters', () => {
    expect(ABSTAIN_THESIS_MAX_LEN).toBe(120)
  })

  it('SHARPE_FLIP_MAX_ENTRIES is 10 entries', () => {
    expect(SHARPE_FLIP_MAX_ENTRIES).toBe(10)
  })

  it('COINBASE_OUTAGE_THRESHOLD_MS is 15 minutes in milliseconds', () => {
    expect(COINBASE_OUTAGE_THRESHOLD_MS).toBe(15 * 60 * 1000)
  })

  it('COINBASE_DEDUP_MS is 60 minutes in milliseconds', () => {
    expect(COINBASE_DEDUP_MS).toBe(60 * 60 * 1000)
  })

  it('NAV_DROP_WINDOW_MS is 7 days in milliseconds', () => {
    expect(NAV_DROP_WINDOW_MS).toBe(7 * 24 * 60 * 60 * 1000)
  })

  it('NAV_DROP_DEDUP_MS is 24 hours in milliseconds', () => {
    expect(NAV_DROP_DEDUP_MS).toBe(24 * 60 * 60 * 1000)
  })

  it('NAV_DROP_DEFAULT_THRESHOLD is 0.05 (5%)', () => {
    expect(NAV_DROP_DEFAULT_THRESHOLD).toBe(0.05)
  })
})

// Phase 5 Task 2c -- Coinbase connection visibility check.
describe('monitor: evaluateAndRecordCoinbaseHealth', () => {
  let db: ReturnType<typeof makeDb>
  const NOW = 1_700_000_000_000

  beforeEach(() => { db = makeDb() })

  function firstDownRow(): { last_alerted_at: number } | undefined {
    return db
      .prepare("SELECT last_alerted_at FROM trader_alert_state WHERE alert_id='coinbase_first_down'")
      .get() as { last_alerted_at: number } | undefined
  }

  function lastAlertedRow(): { last_alerted_at: number } | undefined {
    return db
      .prepare("SELECT last_alerted_at FROM trader_alert_state WHERE alert_id='coinbase_alert'")
      .get() as { last_alerted_at: number } | undefined
  }

  it('clears any first_down marker and returns fire false when healthy', async () => {
    // Seed a stale first_down marker from a previous outage that recovered.
    recordAlertFired(db, 'coinbase_first_down', NOW - 30 * 60 * 1000)
    expect(firstDownRow()).toBeDefined()

    const getHealth = async () => ({ coinbase_connected: true })
    const result = await evaluateAndRecordCoinbaseHealth(db, NOW, getHealth)
    expect(result.fire).toBe(false)
    expect(firstDownRow()).toBeUndefined()
  })

  it('inserts first_down marker on the first outage tick and returns fire false', async () => {
    const getHealth = async () => ({ coinbase_connected: false })
    const result = await evaluateAndRecordCoinbaseHealth(db, NOW, getHealth)
    expect(result.fire).toBe(false)
    const row = firstDownRow()
    expect(row?.last_alerted_at).toBe(NOW)
  })

  it('still returns fire false when only 5 minutes into the outage', async () => {
    // Prior tick set the marker 5 minutes ago.
    recordAlertFired(db, 'coinbase_first_down', NOW - 5 * 60 * 1000)
    const getHealth = async () => ({ coinbase_connected: false })
    const result = await evaluateAndRecordCoinbaseHealth(db, NOW, getHealth)
    expect(result.fire).toBe(false)
    // Marker is not refreshed once set.
    expect(firstDownRow()?.last_alerted_at).toBe(NOW - 5 * 60 * 1000)
  })

  it('fires when outage has exceeded 15 minutes and no prior alert', async () => {
    recordAlertFired(db, 'coinbase_first_down', NOW - 20 * 60 * 1000)
    const getHealth = async () => ({ coinbase_connected: false })
    const result = await evaluateAndRecordCoinbaseHealth(db, NOW, getHealth)
    expect(result.fire).toBe(true)
    expect(result.message).toContain('Coinbase connection down')
    expect(result.message).toContain('15m')
  })

  it('does not re-fire within the 60m dedup window', async () => {
    recordAlertFired(db, 'coinbase_first_down', NOW - 21 * 60 * 1000)
    // Last alert was 30 minutes ago, still inside the 60-minute dedup window.
    recordAlertFired(db, 'coinbase_alert', NOW - 30 * 60 * 1000)
    const getHealth = async () => ({ coinbase_connected: false })
    const result = await evaluateAndRecordCoinbaseHealth(db, NOW, getHealth)
    expect(result.fire).toBe(false)
  })

  it('fires again once the 60m dedup window has elapsed', async () => {
    recordAlertFired(db, 'coinbase_first_down', NOW - 21 * 60 * 1000)
    // Last alert was 61 minutes ago, outside the 60-minute dedup window.
    recordAlertFired(db, 'coinbase_alert', NOW - 61 * 60 * 1000)
    const getHealth = async () => ({ coinbase_connected: false })
    const result = await evaluateAndRecordCoinbaseHealth(db, NOW, getHealth)
    expect(result.fire).toBe(true)
  })

  it('clears first_down marker on recovery', async () => {
    // Seed a long-running outage marker.
    recordAlertFired(db, 'coinbase_first_down', NOW - 40 * 60 * 1000)
    const getHealth = async () => ({ coinbase_connected: true })
    const result = await evaluateAndRecordCoinbaseHealth(db, NOW, getHealth)
    expect(result.fire).toBe(false)
    expect(firstDownRow()).toBeUndefined()
  })

  it('treats a missing coinbase_connected field as healthy (not a flag)', async () => {
    // Older engine or unrelated health response without the field.
    recordAlertFired(db, 'coinbase_first_down', NOW - 40 * 60 * 1000)
    const getHealth = async () => ({})
    const result = await evaluateAndRecordCoinbaseHealth(db, NOW, getHealth)
    expect(result.fire).toBe(false)
    // The stale marker is cleared since we are not in an outage.
    expect(firstDownRow()).toBeUndefined()
  })

  it('treats a getHealth throw as an engine issue, not a Coinbase outage', async () => {
    const getHealth = async () => { throw new Error('network down') }
    const result = await evaluateAndRecordCoinbaseHealth(db, NOW, getHealth)
    expect(result.fire).toBe(false)
    // No marker inserted; the reconciler's own alerting catches engine outages.
    expect(firstDownRow()).toBeUndefined()
  })

  it('treats a null getHealth response as an engine issue', async () => {
    const getHealth = async () => null
    const result = await evaluateAndRecordCoinbaseHealth(db, NOW, getHealth)
    expect(result.fire).toBe(false)
    expect(firstDownRow()).toBeUndefined()
  })

  it('does not touch coinbase_alert row on non-firing ticks', async () => {
    // Fresh outage, within grace. No alert fired yet, no alert row written.
    const getHealth = async () => ({ coinbase_connected: false })
    await evaluateAndRecordCoinbaseHealth(db, NOW, getHealth)
    expect(lastAlertedRow()).toBeUndefined()
  })
})

// Phase 5 Task 2 Dispatch C -- NAV-drop halt monitor.
//
// Compares the most recent NAV snapshot against the OLDEST snapshot in
// the past 7 days.  Fires + halts when drop_pct >= threshold (default
// 0.05 = 5%).  24h dedup so a sustained drawdown does not page out
// every tick.  TRADER_NAV_DROP_PCT env override accepted.
describe('monitor: evaluateAndRecordNavDrop', () => {
  let db: ReturnType<typeof makeDb>
  const NOW = 1_700_000_000_000
  const DAY = 24 * 60 * 60 * 1000

  // Save + restore the env override across tests so a stray
  // TRADER_NAV_DROP_PCT in the host env does not contaminate.
  const ORIGINAL_ENV = process.env.TRADER_NAV_DROP_PCT

  beforeEach(() => {
    db = makeDb()
    delete process.env.TRADER_NAV_DROP_PCT
  })

  afterEach(() => {
    if (ORIGINAL_ENV === undefined) delete process.env.TRADER_NAV_DROP_PCT
    else process.env.TRADER_NAV_DROP_PCT = ORIGINAL_ENV
  })

  function snap(date: string, nav: number, recordedAt: number) {
    return { date, period: 'day_open', nav, recorded_at: recordedAt }
  }

  it('fires + halts when 7d drop is 6% and threshold is the default 5%', async () => {
    const snapshots = [
      snap('2026-04-19', 9400,  NOW),                  // current
      snap('2026-04-12', 10000, NOW - 7 * DAY + 60_000), // oldest in window
    ]
    const result = await evaluateAndRecordNavDrop(db, NOW, async () => snapshots)
    expect(result.fire).toBe(true)
    expect(result.halt).toBe(true)
    expect(result.current_nav).toBe(9400)
    expect(result.comparison_nav).toBe(10000)
    expect(result.drop_pct).toBeCloseTo(0.06, 4)
  })

  it('does not fire at a 4% drop when default threshold is 5%', async () => {
    const snapshots = [
      snap('2026-04-19', 9600,  NOW),
      snap('2026-04-12', 10000, NOW - 7 * DAY + 60_000),
    ]
    const result = await evaluateAndRecordNavDrop(db, NOW, async () => snapshots)
    expect(result.fire).toBe(false)
    expect(result.halt).toBe(false)
  })

  it('does not fire when only one snapshot exists', async () => {
    const snapshots = [snap('2026-04-19', 10000, NOW)]
    const result = await evaluateAndRecordNavDrop(db, NOW, async () => snapshots)
    expect(result.fire).toBe(false)
    expect(result.halt).toBe(false)
  })

  it('does not fire when zero snapshots exist (engine has not booted yet)', async () => {
    const result = await evaluateAndRecordNavDrop(db, NOW, async () => [])
    expect(result.fire).toBe(false)
    expect(result.halt).toBe(false)
  })

  it('compares against the OLDEST snapshot in the 7d window, not the second-most-recent', async () => {
    // current 9400, mid-window 9450, oldest 10000.  If we used the
    // second-most-recent (9450) the drop is < 1%; using the oldest
    // (10000) the drop is 6%.  Spec: oldest wins.
    const snapshots = [
      snap('2026-04-19', 9400,  NOW),                  // current
      snap('2026-04-15', 9450,  NOW - 4 * DAY),         // middle
      snap('2026-04-13', 10000, NOW - 6 * DAY),         // oldest in window
    ]
    const result = await evaluateAndRecordNavDrop(db, NOW, async () => snapshots)
    expect(result.fire).toBe(true)
    expect(result.comparison_nav).toBe(10000)
    expect(result.drop_pct).toBeCloseTo(0.06, 4)
  })

  it('ignores snapshots older than 7 days', async () => {
    const snapshots = [
      snap('2026-04-19', 9400,  NOW),                  // current
      // The only OTHER snapshot is 8 days old -- outside the window so
      // it must be ignored even though it would scream a huge drop.
      snap('2026-04-11', 100000, NOW - 8 * DAY),
    ]
    const result = await evaluateAndRecordNavDrop(db, NOW, async () => snapshots)
    expect(result.fire).toBe(false)
    expect(result.halt).toBe(false)
  })

  it('honours TRADER_NAV_DROP_PCT=0.1 -- a 6% drop does not fire when threshold is 10%', async () => {
    process.env.TRADER_NAV_DROP_PCT = '0.1'
    const snapshots = [
      snap('2026-04-19', 9400,  NOW),
      snap('2026-04-12', 10000, NOW - 7 * DAY + 60_000),
    ]
    const result = await evaluateAndRecordNavDrop(db, NOW, async () => snapshots)
    expect(result.fire).toBe(false)
    expect(result.halt).toBe(false)
  })

  it('falls back to the default threshold when TRADER_NAV_DROP_PCT is malformed', async () => {
    process.env.TRADER_NAV_DROP_PCT = 'banana'
    const snapshots = [
      snap('2026-04-19', 9400,  NOW),
      snap('2026-04-12', 10000, NOW - 7 * DAY + 60_000),
    ]
    // Malformed env -> falls back to default 0.05 -> 6% drop fires.
    const result = await evaluateAndRecordNavDrop(db, NOW, async () => snapshots)
    expect(result.fire).toBe(true)
  })

  it('does not fire when last_alerted_at was 2 hours ago (within 24h dedup)', async () => {
    recordAlertFired(db, 'nav_drop_alert', NOW - 2 * 60 * 60 * 1000)
    const snapshots = [
      snap('2026-04-19', 9400,  NOW),
      snap('2026-04-12', 10000, NOW - 7 * DAY + 60_000),
    ]
    const result = await evaluateAndRecordNavDrop(db, NOW, async () => snapshots)
    expect(result.fire).toBe(false)
    expect(result.halt).toBe(false)
  })

  it('fires again when last_alerted_at was 25 hours ago (outside 24h dedup)', async () => {
    recordAlertFired(db, 'nav_drop_alert', NOW - 25 * 60 * 60 * 1000)
    const snapshots = [
      snap('2026-04-19', 9400,  NOW),
      snap('2026-04-12', 10000, NOW - 7 * DAY + 60_000),
    ]
    const result = await evaluateAndRecordNavDrop(db, NOW, async () => snapshots)
    expect(result.fire).toBe(true)
    expect(result.halt).toBe(true)
  })

  it('message is the exact one-line operator-facing string with threshold annotation', async () => {
    const snapshots = [
      snap('2026-04-19', 9400,  NOW),
      snap('2026-04-12', 10000, NOW - 7 * DAY + 60_000),
    ]
    const result = await evaluateAndRecordNavDrop(db, NOW, async () => snapshots)
    expect(result.fire).toBe(true)
    expect(result.message).toBe(
      'NAV drop halt: $10000.00 -> $9400.00 (-6.0%, threshold -5.0%) over 7 days. Engine halted via /risk/halt.',
    )
  })

  it('threshold in the message tracks the TRADER_NAV_DROP_PCT env override', async () => {
    // Env says threshold is 3% -- we still fire at 6% drop, and the
    // message must quote the override value (not the default).
    process.env.TRADER_NAV_DROP_PCT = '0.03'
    const snapshots = [
      snap('2026-04-19', 9400,  NOW),
      snap('2026-04-12', 10000, NOW - 7 * DAY + 60_000),
    ]
    const result = await evaluateAndRecordNavDrop(db, NOW, async () => snapshots)
    expect(result.fire).toBe(true)
    expect(result.message).toContain('threshold -3.0%')
  })

  it('drop_pct is positive when NAV dropped (not negative)', async () => {
    const snapshots = [
      snap('2026-04-19', 9400,  NOW),
      snap('2026-04-12', 10000, NOW - 7 * DAY + 60_000),
    ]
    const result = await evaluateAndRecordNavDrop(db, NOW, async () => snapshots)
    expect(result.drop_pct).toBeGreaterThan(0)
  })
})
