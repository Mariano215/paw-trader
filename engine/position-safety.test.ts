import { describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import { findUnexpectedShortPositions, notifyUnexpectedShortPositions } from './position-safety.js'
import type { EnginePosition } from './types.js'

const position = (asset: string, qty: number): EnginePosition => ({
  asset, qty, avg_entry_price: 100, market_value: qty * 100,
  unrealized_pnl: 0, source: 'broker', updated_at: 1,
})

describe('unexpected short-position safety', () => {
  it('finds negative broker quantities and ignores flat rounding dust', () => {
    expect(findUnexpectedShortPositions([
      position('AAPL', 2), position('IWM', -3), position('SPY', -1e-12),
    ])).toEqual([expect.objectContaining({asset: 'IWM', qty: -3})])
  })

  it('alerts once for an unchanged short set, alerts on change, and rearms after flat', async () => {
    const db = new Database(':memory:')
    const send = vi.fn().mockResolvedValue(undefined)

    await notifyUnexpectedShortPositions(db, [position('IWM', -3)], send)
    await notifyUnexpectedShortPositions(db, [position('IWM', -3)], send)
    await notifyUnexpectedShortPositions(db, [position('IWM', -2)], send)
    await notifyUnexpectedShortPositions(db, [], send)
    await notifyUnexpectedShortPositions(db, [position('IWM', -2)], send)

    expect(send).toHaveBeenCalledTimes(3)
    expect(send.mock.calls[0][0]).toContain('UNEXPECTED SHORT POSITION')
    expect(send.mock.calls[0][0]).toContain('IWM -3')
  })

  it('retries an alert when delivery fails', async () => {
    const db = new Database(':memory:')
    const send = vi.fn()
      .mockRejectedValueOnce(new Error('channel unavailable'))
      .mockResolvedValue(undefined)

    await notifyUnexpectedShortPositions(db, [position('IWM', -3)], send)
    await notifyUnexpectedShortPositions(db, [position('IWM', -3)], send)

    expect(send).toHaveBeenCalledTimes(2)
  })
})
