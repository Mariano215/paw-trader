import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { initTraderTables } from './db.js'
import { seedMomentumStrategy } from './strategy-manager.js'
import { buildApprovalCard, buildApprovalKeyboard, createPendingApproval, formatTimeoutNotice, timeoutExpiredApprovals, BIGGER_SIZE_USD, DEFAULT_SIZE_USD, type ExpiredApproval } from './approval-manager.js'

function makeDb() {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = OFF')
  initTraderTables(db)
  seedMomentumStrategy(db)
  return db
}

describe('approval-manager', () => {
  let db: ReturnType<typeof makeDb>
  beforeEach(() => { db = makeDb() })

  it('buildApprovalCard returns plain text with required fields', () => {
    const card = buildApprovalCard({
      asset: 'AAPL', side: 'buy', size_usd: 100, entry_price: 185,
      stop_loss: 179, take_profit: 197, confidence: 0.78,
      strategy_name: 'Momentum', tier: 0, trade_num: 3, trades_until_promo: 27,
    })
    // No markdown markers
    expect(card).not.toMatch(/[*_`#]/)
    // Required fields present
    expect(card).toContain('AAPL')
    expect(card).toContain('BUY')
    expect(card).toContain('$100')
    expect(card).toContain('Momentum')
    expect(card).toContain('Tier 0')
    // Actions are in buttons, not card text
    expect(card).toContain('buttons below')
    expect(card).not.toContain('Reply: APPROVE')
  })

  it('buildApprovalKeyboard returns inline keyboard with correct actions', () => {
    const keyboard = buildApprovalKeyboard('ap-test-id')
    const rows = keyboard.inline_keyboard
    expect(rows).toHaveLength(2)
    const allButtons = rows.flat()
    const labels = allButtons.map(b => b.text)
    const data = allButtons.map(b => b.callback_data)

    expect(labels).toContain('APPROVE')
    expect(labels).toContain('SKIP')
    expect(labels).toContain(`APPROVE $${BIGGER_SIZE_USD}`)
    expect(labels).toContain('PAUSE')

    // All callback_data must start with trader: and embed the approvalId
    expect(data.every(d => d.startsWith('trader:') && d.includes('ap-test-id'))).toBe(true)
  })

  it('buildApprovalCard handles market orders (entry_price=0)', () => {
    const card = buildApprovalCard({
      asset: 'AAPL', side: 'buy', size_usd: 100, entry_price: 0,
      confidence: 0.72,
      strategy_name: 'Momentum', tier: 0, trade_num: 1, trades_until_promo: 29,
    })
    expect(card).toContain('AAPL')
    expect(card).toContain('BUY')
    expect(card).toContain('$100')
    expect(card).toContain('Entry type: market')
    // No division-by-zero garbage
    expect(card).not.toContain('Infinity')
    expect(card).not.toContain('NaN')
    // No $0.00 limit price
    expect(card).not.toContain('limit $0')
  })

  it('createPendingApproval inserts a row and returns id', () => {
    const signalId = 'sig-1'
    db.prepare("INSERT INTO trader_signals (id, strategy_id, asset, side, raw_score, horizon_days, generated_at, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(signalId, 'momentum-stocks', 'AAPL', 'buy', 0.72, 20, Date.now(), 'pending')
    const id = createPendingApproval(db, signalId)
    expect(id).toBeTruthy()
    const row = db.prepare('SELECT * FROM trader_approvals WHERE id = ?').get(id)
    expect(row).not.toBeNull()
  })

  it('timeoutExpiredApprovals marks stale rows as timeout', () => {
    const thirtyOneMinutesAgo = Date.now() - 31 * 60 * 1000
    db.prepare("INSERT INTO trader_approvals (id, decision_id, sent_at) VALUES (?, ?, ?)").run('ap-1', 'dec-1', thirtyOneMinutesAgo)
    const expired = timeoutExpiredApprovals(db)
    expect(expired).toHaveLength(1)
    expect(expired[0].id).toBe('ap-1')
    const row = db.prepare("SELECT response FROM trader_approvals WHERE id='ap-1'").get() as any
    expect(row.response).toBe('timeout')
  })

  it('timeoutExpiredApprovals returns joined signal metadata when present', () => {
    const thirtyOneMinutesAgo = Date.now() - 31 * 60 * 1000
    db.prepare("INSERT INTO trader_signals (id, strategy_id, asset, side, raw_score, horizon_days, generated_at, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run('sig-t3', 'momentum-stocks', 'MSFT', 'buy', 0.81, 20, Date.now(), 'pending')
    db.prepare("INSERT INTO trader_approvals (id, decision_id, sent_at) VALUES (?, ?, ?)")
      .run('ap-t3', 'sig-t3', thirtyOneMinutesAgo)

    const expired = timeoutExpiredApprovals(db)
    expect(expired).toHaveLength(1)
    const row = expired[0] as ExpiredApproval
    expect(row.asset).toBe('MSFT')
    expect(row.side).toBe('buy')
    expect(row.sizeUsd).toBe(DEFAULT_SIZE_USD)
    expect(row.signalId).toBe('sig-t3')
    const suppression = db.prepare(`
      SELECT reason FROM trader_signal_suppressions
      WHERE strategy_id = 'momentum-stocks' AND asset = 'MSFT' AND side = 'buy'
    `).get() as any
    expect(suppression.reason).toBe('timeout')
  })

  it('timeoutExpiredApprovals returns null asset/side when signal row is missing', () => {
    const thirtyOneMinutesAgo = Date.now() - 31 * 60 * 1000
    db.prepare("INSERT INTO trader_approvals (id, decision_id, sent_at) VALUES (?, ?, ?)")
      .run('ap-orphan', 'sig-missing', thirtyOneMinutesAgo)

    const expired = timeoutExpiredApprovals(db)
    expect(expired).toHaveLength(1)
    expect(expired[0].asset).toBeNull()
    expect(expired[0].side).toBeNull()
  })

  it('timeoutExpiredApprovals returns empty array when nothing is stale', () => {
    // Fresh approval within the 30-min window
    db.prepare("INSERT INTO trader_approvals (id, decision_id, sent_at) VALUES (?, ?, ?)")
      .run('ap-fresh', 'sig-x', Date.now())
    expect(timeoutExpiredApprovals(db)).toEqual([])
  })

  it('timeoutExpiredApprovals skips rows that already responded', () => {
    const thirtyOneMinutesAgo = Date.now() - 31 * 60 * 1000
    db.prepare("INSERT INTO trader_approvals (id, decision_id, sent_at, response, responded_at) VALUES (?, ?, ?, 'approved', ?)")
      .run('ap-done', 'sig-done', thirtyOneMinutesAgo, thirtyOneMinutesAgo + 1000)
    expect(timeoutExpiredApprovals(db)).toEqual([])
  })

  it('formatTimeoutNotice produces plain-text notice with no em dashes', () => {
    const notice = formatTimeoutNotice({
      id: 'ap-1', signalId: 'sig-1', asset: 'AAPL', side: 'buy', sizeUsd: 100,
    })
    expect(notice).toBe('Signal expired: AAPL BUY $100 - no trade placed.')
    expect(notice).not.toMatch(/[\u2013\u2014]/)  // no en/em dashes
    expect(notice).not.toMatch(/[*_`#]/)          // no markdown
  })

  it('formatTimeoutNotice returns null when metadata is incomplete', () => {
    expect(formatTimeoutNotice({
      id: 'ap-1', signalId: 'sig-1', asset: null, side: 'buy', sizeUsd: 100,
    })).toBeNull()
    expect(formatTimeoutNotice({
      id: 'ap-1', signalId: 'sig-1', asset: 'AAPL', side: null, sizeUsd: 100,
    })).toBeNull()
  })
})
