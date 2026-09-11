import {describe, expect, it} from 'vitest'
import Database from 'better-sqlite3'
import {initBitcoinOrderFlowStore} from './bitcoin-order-flow-store.js'
import {getBitcoinOrderFlowResearchProgress} from './bitcoin-order-flow-progress.js'

const DAY_MS = 24 * 60 * 60 * 1000
const BAR_MS = 15 * 60 * 1000
const DECLARATION = 1_800_000_000_000

function database(): Database.Database {
  const db = new Database(':memory:')
  initBitcoinOrderFlowStore(db)
  return db
}

function insertBar(db: Database.Database, start: number, eligible: boolean): void {
  db.prepare(`INSERT INTO bitcoin_order_flow_15m_bars
    (bucket_start_ms,bucket_end_ms,trade_count,buy_volume,sell_volume,
     trade_imbalance_15m,trade_imbalance_60m,depth_imbalance_15m,
     bid_depletion_per_second,ask_depletion_per_second,
     bid_replenishment_per_second,ask_replenishment_per_second,
     spread_median,spread_p95,realized_volatility_60m,message_count,
     sequence_gap_count,reconnect_count,downtime_ms,eligible,quality_reason,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      start, start + BAR_MS, 1, 1, 0, 1, 1, 0, 0, 0, 0, 0, 1, 1, 0,
      1, 0, 0, 0, eligible ? 1 : 0, eligible ? null : 'partial_start', start + BAR_MS,
    )
}

describe('Bitcoin order-flow research progress', () => {
  it('fails closed before the frozen 180-day collection boundary', () => {
    const db = database()
    insertBar(db, DECLARATION + 10 * DAY_MS, true)
    insertBar(db, DECLARATION + 11 * DAY_MS, false)
    expect(getBitcoinOrderFlowResearchProgress(db, DECLARATION)).toEqual({
      declarationAt: DECLARATION,
      collectionThroughAt: DECLARATION + 11 * DAY_MS + BAR_MS,
      totalBars: 2,
      eligibleBars: 1,
      ineligibleBars: 1,
      collectionDaysCompleted: 11,
      minimumForwardDays: 180,
      earliestEvaluationAt: DECLARATION + 180 * DAY_MS,
      collectionMature: false,
    })
    db.close()
  })

  it('marks only the calendar collection minimum mature at its boundary', () => {
    const db = database()
    insertBar(db, DECLARATION + 180 * DAY_MS - BAR_MS, true)
    expect(getBitcoinOrderFlowResearchProgress(db, DECLARATION).collectionMature).toBe(true)
    db.close()
  })

  it('reports an empty forward collection without inventing progress', () => {
    const db = database()
    expect(getBitcoinOrderFlowResearchProgress(db, DECLARATION)).toMatchObject({
      collectionThroughAt: null,
      totalBars: 0,
      eligibleBars: 0,
      ineligibleBars: 0,
      collectionDaysCompleted: 0,
      collectionMature: false,
    })
    db.close()
  })
})
