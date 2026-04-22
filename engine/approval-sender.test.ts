import { describe, it, expect, beforeEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import { initTraderTables } from './db.js'
import { seedMomentumStrategy } from './strategy-manager.js'
import { sendPendingApprovals } from './approval-sender.js'
import type { TraderApprovalKeyboard } from './approval-manager.js'
import { recordSignalSuppressionBySignalId } from './suppression-state.js'

function makeDb() {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = OFF')
  initTraderTables(db)
  seedMomentumStrategy(db)
  return db
}

function insertSignal(
  db: Database.Database,
  id: string,
  opts: Partial<{ score: number; status: string; strategy_id: string; asset: string; side: string }> = {},
) {
  db.prepare(`
    INSERT INTO trader_signals (id, strategy_id, asset, side, raw_score, horizon_days, generated_at, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    opts.strategy_id ?? 'momentum-stocks',
    opts.asset ?? 'AAPL',
    opts.side ?? 'buy',
    opts.score ?? 0.72,
    20,
    Date.now(),
    opts.status ?? 'pending',
  )
}

describe('approval-sender', () => {
  let db: ReturnType<typeof makeDb>
  let sendMock: ReturnType<typeof vi.fn>

  /** Strongly-typed wrapper the producer code consumes. */
  const sendWithKeyboard = (text: string, keyboard: TraderApprovalKeyboard): Promise<void> =>
    (sendMock as unknown as (t: string, k: TraderApprovalKeyboard) => Promise<void>)(text, keyboard)

  beforeEach(() => {
    db = makeDb()
    sendMock = vi.fn().mockResolvedValue(undefined)
  })

  it('sends nothing when there are no pending signals', async () => {
    const n = await sendPendingApprovals(db, { sendWithKeyboard })
    expect(n).toBe(0)
    expect(sendMock).not.toHaveBeenCalled()
  })

  it('sends a card for each pending signal without approval row', async () => {
    insertSignal(db, 'sig-1', { asset: 'AAPL', score: 0.72 })
    insertSignal(db, 'sig-2', { asset: 'MSFT', score: 0.81 })

    const n = await sendPendingApprovals(db, { sendWithKeyboard })

    expect(n).toBe(2)
    expect(sendMock).toHaveBeenCalledTimes(2)
    // Higher-scored signal goes first
    const firstCard = sendMock.mock.calls[0][0] as string
    expect(firstCard).toContain('MSFT')
    const secondCard = sendMock.mock.calls[1][0] as string
    expect(secondCard).toContain('AAPL')
  })

  it('inserts a trader_approvals row per sent card', async () => {
    insertSignal(db, 'sig-1')
    await sendPendingApprovals(db, { sendWithKeyboard })

    const rows = db.prepare('SELECT * FROM trader_approvals WHERE decision_id = ?').all('sig-1')
    expect(rows).toHaveLength(1)
  })

  it('does not re-send signals that already have an approval row', async () => {
    insertSignal(db, 'sig-1')
    db.prepare('INSERT INTO trader_approvals (id, decision_id, sent_at) VALUES (?, ?, ?)')
      .run('ap-existing', 'sig-1', Date.now())

    const n = await sendPendingApprovals(db, { sendWithKeyboard })
    expect(n).toBe(0)
    expect(sendMock).not.toHaveBeenCalled()
  })

  it('skips non-pending signals', async () => {
    insertSignal(db, 'sig-1', { status: 'decided' })
    const n = await sendPendingApprovals(db, { sendWithKeyboard })
    expect(n).toBe(0)
    expect(sendMock).not.toHaveBeenCalled()
  })

  it('skips signals whose strategy is paused', async () => {
    db.prepare("UPDATE trader_strategies SET status='paused' WHERE id='momentum-stocks'").run()
    insertSignal(db, 'sig-1')

    const n = await sendPendingApprovals(db, { sendWithKeyboard })
    expect(n).toBe(0)
    expect(sendMock).not.toHaveBeenCalled()
    const signal = db.prepare('SELECT status FROM trader_signals WHERE id = ?').get('sig-1') as any
    expect(signal.status).toBe('pending')
    const approvals = db.prepare('SELECT * FROM trader_approvals').all()
    expect(approvals).toHaveLength(0)
  })

  it('suppresses blind low-score signals instead of paging the operator', async () => {
    insertSignal(db, 'sig-1', { score: 0.08 })

    const n = await sendPendingApprovals(db, { sendWithKeyboard })

    expect(n).toBe(0)
    expect(sendMock).not.toHaveBeenCalled()
    const signal = db.prepare('SELECT status FROM trader_signals WHERE id = ?').get('sig-1') as any
    expect(signal.status).toBe('suppressed_blind_low_score')
  })

  it('still pages blind signals when raw score clears the stronger no-enrichment bar', async () => {
    insertSignal(db, 'sig-1', { score: 0.12 })

    const n = await sendPendingApprovals(db, { sendWithKeyboard })

    expect(n).toBe(1)
    expect(sendMock).toHaveBeenCalledTimes(1)
  })

  it('suppresses repeat alerts after a recent committee abstain for the same asset and strategy', async () => {
    insertSignal(db, 'sig-old', { asset: 'AAPL', score: 0.11, status: 'decided' })
    recordSignalSuppressionBySignalId(db, 'sig-old', 'committee_abstain')
    insertSignal(db, 'sig-new', { asset: 'AAPL', score: 0.14 })

    const n = await sendPendingApprovals(db, { sendWithKeyboard })

    expect(n).toBe(0)
    expect(sendMock).not.toHaveBeenCalled()
    const signal = db.prepare('SELECT status FROM trader_signals WHERE id = ?').get('sig-new') as any
    expect(signal.status).toBe('suppressed_no_material_change')
  })

  it('re-alerts when the score improved materially since the last suppression', async () => {
    insertSignal(db, 'sig-old', { asset: 'AAPL', score: 0.11, status: 'decided' })
    recordSignalSuppressionBySignalId(db, 'sig-old', 'committee_abstain')
    insertSignal(db, 'sig-new', { asset: 'AAPL', score: 0.17 })

    const n = await sendPendingApprovals(db, { sendWithKeyboard })

    expect(n).toBe(1)
    expect(sendMock).toHaveBeenCalledTimes(1)
  })

  it('re-alerts when the side flips because that is a different setup', async () => {
    insertSignal(db, 'sig-old', { asset: 'AAPL', score: 0.11, side: 'buy', status: 'decided' })
    recordSignalSuppressionBySignalId(db, 'sig-old', 'skip')
    insertSignal(db, 'sig-new', { asset: 'AAPL', score: 0.11, side: 'sell' })

    const n = await sendPendingApprovals(db, { sendWithKeyboard })

    expect(n).toBe(1)
    expect(sendMock).toHaveBeenCalledTimes(1)
  })

  it('re-alerts when enrichment changed materially since the last suppression', async () => {
    db.prepare(`
      INSERT INTO trader_signals (id, strategy_id, asset, side, raw_score, horizon_days, enrichment_json, generated_at, status)
      VALUES ('sig-old', 'momentum-stocks', 'AAPL', 'buy', 0.11, 20, '{"rsi":40}', ?, 'decided')
    `).run(Date.now())
    recordSignalSuppressionBySignalId(db, 'sig-old', 'skip')
    db.prepare(`
      INSERT INTO trader_signals (id, strategy_id, asset, side, raw_score, horizon_days, enrichment_json, generated_at, status)
      VALUES ('sig-new', 'momentum-stocks', 'AAPL', 'buy', 0.11, 20, '{"rsi":55}', ?, 'pending')
    `).run(Date.now())

    const n = await sendPendingApprovals(db, { sendWithKeyboard })

    expect(n).toBe(1)
    expect(sendMock).toHaveBeenCalledTimes(1)
  })

  it('rolls back approval row when send fails', async () => {
    insertSignal(db, 'sig-1')
    sendMock.mockRejectedValue(new Error('telegram 503'))

    const n = await sendPendingApprovals(db, { sendWithKeyboard })
    expect(n).toBe(0)
    const approvals = db.prepare('SELECT * FROM trader_approvals').all()
    expect(approvals).toHaveLength(0)
  })

  it('retries failed send on next sweep', async () => {
    insertSignal(db, 'sig-1')
    let callCount = 0
    const flakySend = async (): Promise<void> => {
      callCount++
      if (callCount === 1) throw new Error('temporary failure')
    }

    await sendPendingApprovals(db, { sendWithKeyboard: flakySend })
    expect(callCount).toBe(1)
    const n = await sendPendingApprovals(db, { sendWithKeyboard: flakySend })
    expect(n).toBe(1)
    expect(callCount).toBe(2)
  })

  it('passes an inline keyboard with APPROVE/SKIP/PAUSE buttons', async () => {
    insertSignal(db, 'sig-1')
    await sendPendingApprovals(db, { sendWithKeyboard })
    const keyboard = sendMock.mock.calls[0][1] as TraderApprovalKeyboard
    const allLabels = keyboard.inline_keyboard.flat().map(b => b.text)
    expect(allLabels).toContain('APPROVE')
    expect(allLabels).toContain('SKIP')
    expect(allLabels).toContain('PAUSE')
    // callback_data should embed the approval ID
    const allData = keyboard.inline_keyboard.flat().map(b => b.callback_data)
    expect(allData.every(d => d.startsWith('trader:'))).toBe(true)
  })

  it('card shows market entry (no limit price) in Phase 1', async () => {
    insertSignal(db, 'sig-1')
    await sendPendingApprovals(db, { sendWithKeyboard })
    const card = sendMock.mock.calls[0][0] as string
    expect(card).toContain('Entry type: market')
    expect(card).not.toContain('Infinity')
    expect(card).not.toContain('NaN')
  })

  it('card size matches DEFAULT_SIZE_USD ($200 after Phase 3 Task 6 cap lift)', async () => {
    insertSignal(db, 'sig-1')
    await sendPendingApprovals(db, { sendWithKeyboard })
    const card = sendMock.mock.calls[0][0] as string
    expect(card).toContain('$200')
  })

  it('trade number counts executed decisions + in-flight sends', async () => {
    insertSignal(db, 'sig-1', { asset: 'AAPL', score: 0.9 })
    insertSignal(db, 'sig-2', { asset: 'MSFT', score: 0.8 })

    await sendPendingApprovals(db, { sendWithKeyboard })

    const firstCard = sendMock.mock.calls[0][0] as string
    const secondCard = sendMock.mock.calls[1][0] as string
    expect(firstCard).toContain('trade 1 of 30')
    expect(secondCard).toContain('trade 2 of 30')
  })
})
