import { describe, it, expect } from 'vitest'
import { dailyBenchReturn } from './close-out-watcher.js'

const bar = (date: string, close: number) => ({ date, close, ts_ms: Date.parse(date) })

describe('dailyBenchReturn', () => {
  it('returns the SPY close-to-close return for the snapshot date', async () => {
    const engine = { getPrices: async () => [bar('2026-10-16', 500), bar('2026-10-19', 505)] } as never
    expect(await dailyBenchReturn(engine, '2026-10-19')).toBeCloseTo(0.01, 10)
  })

  it('returns null (not 0) when the date has no bar or the fetch fails', async () => {
    const missing = { getPrices: async () => [bar('2026-10-16', 500)] } as never
    const broken = { getPrices: async () => { throw new Error('down') } } as never
    expect(await dailyBenchReturn(missing, '2026-10-19')).toBeNull()
    expect(await dailyBenchReturn(broken, '2026-10-19')).toBeNull()
  })
})
