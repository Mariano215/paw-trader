import { describe, it, expect } from 'vitest'
import { normalizeSizeWeight, applySizeWeight } from './size-weight.js'

describe('size weight', () => {
  it('missing or non-finite means full size', () => {
    for (const raw of [null, undefined, Number.NaN, Number.POSITIVE_INFINITY, 'x']) {
      expect(normalizeSizeWeight(raw)).toBe(1)
    }
  })
  it('clamps to [0, 1] so a weight never grows a trade', () => {
    expect(normalizeSizeWeight(1.5)).toBe(1)
    expect(normalizeSizeWeight(-0.2)).toBe(0)
    expect(normalizeSizeWeight(0.37)).toBe(0.37)
  })
  it('scales the cap and rounds to cents', () => {
    expect(applySizeWeight(200, 0.333)).toBe(66.6)
    expect(applySizeWeight(200, null)).toBe(200)
    expect(applySizeWeight(200, 0)).toBe(0)
  })
})
