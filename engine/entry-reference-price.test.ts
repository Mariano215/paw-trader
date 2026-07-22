import { describe, it, expect } from 'vitest'
import { entryRefFromEnrichment, resolveEntryReferencePrice } from './entry-reference-price.js'

const NOW = 1_784_000_000_000

const client = (bars: Array<{ close: number }> | Error) => ({
  getPrices: async () => {
    if (bars instanceof Error) throw bars
    return bars
  },
})

describe('entryRefFromEnrichment', () => {
  it('reads a usable price', () => {
    expect(entryRefFromEnrichment('{"price_current":66.7}')).toBe(66.7)
  })
  it('returns 0 for missing, null, zero, or malformed', () => {
    expect(entryRefFromEnrichment(null)).toBe(0)
    expect(entryRefFromEnrichment('{}')).toBe(0)
    expect(entryRefFromEnrichment('{"price_current":null}')).toBe(0)
    expect(entryRefFromEnrichment('{"price_current":0}')).toBe(0)
    expect(entryRefFromEnrichment('not json')).toBe(0)
  })
})

describe('resolveEntryReferencePrice', () => {
  it('prefers enrichment and does not call the engine', async () => {
    let called = false
    const c = { getPrices: async () => { called = true; return [{ close: 99 }] } }
    expect(await resolveEntryReferencePrice(c, 'EEM', '{"price_current":66.7}', NOW)).toBe(66.7)
    expect(called).toBe(false)
  })

  it('falls back to the engine latest close when enrichment has no price', async () => {
    // The 43%-of-the-book case: without this the position ships with no stop.
    const r = await resolveEntryReferencePrice(client([{ close: 60 }, { close: 62.5 }]), 'EEM', null, NOW)
    expect(r).toBe(62.5)
  })

  it('skips trailing unusable bars', async () => {
    const bars = [{ close: 61 }, { close: NaN }, { close: 0 }] as Array<{ close: number }>
    expect(await resolveEntryReferencePrice(client(bars), 'EEM', null, NOW)).toBe(61)
  })

  it('returns 0 when the engine has no bars', async () => {
    expect(await resolveEntryReferencePrice(client([]), 'EEM', null, NOW)).toBe(0)
  })

  it('returns 0 rather than throwing when the engine errors', async () => {
    expect(await resolveEntryReferencePrice(client(new Error('boom')), 'EEM', null, NOW)).toBe(0)
  })
})
