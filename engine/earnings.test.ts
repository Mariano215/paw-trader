import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('./knobs.js', () => ({ traderKnob: vi.fn() }))
vi.mock('../logger.js', () => ({ logger: { warn: vi.fn() } }))

import { traderKnob } from './knobs.js'
import { daysToEarnings, parseEarningsDate, clearEarningsCache } from './earnings.js'

const NOW = Date.UTC(2026, 9, 27, 15) // 2026-10-27
const ok = (text: string) => vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: { reportText: text } }) })

describe('earnings', () => {
  beforeEach(() => { clearEarningsCache(); vi.mocked(traderKnob).mockReturnValue(5) })

  it('parses the Nasdaq date', () => {
    expect(parseEarningsDate('report earnings on  10/29/2026. The')).toBe(Date.UTC(2026, 9, 29))
    expect(parseEarningsDate('no date')).toBeNull()
  })

  it('returns days until earnings and caches the lookup', async () => {
    const f = ok('report earnings on  10/29/2026.')
    expect(await daysToEarnings('AAPL', NOW, f as never)).toBe(2)
    expect(await daysToEarnings('AAPL', NOW, f as never)).toBe(2)
    expect(f).toHaveBeenCalledTimes(1)
  })

  it('is null for ETFs, past dates, crypto, errors, and when the knob is off', async () => {
    expect(await daysToEarnings('SPY', NOW, vi.fn().mockResolvedValue({ ok: false }) as never)).toBeNull()
    expect(await daysToEarnings('MSFT', NOW, ok('on 10/20/2026') as never)).toBeNull()
    expect(await daysToEarnings('BTC/USD', NOW, ok('on 10/28/2026') as never)).toBeNull()
    expect(await daysToEarnings('NVDA', NOW, vi.fn().mockRejectedValue(new Error('down')) as never)).toBeNull()
    vi.mocked(traderKnob).mockReturnValue(0)
    expect(await daysToEarnings('AMZN', NOW, ok('on 10/28/2026') as never)).toBeNull()
  })
})
