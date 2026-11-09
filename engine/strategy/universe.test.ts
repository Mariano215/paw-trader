import { describe, it, expect } from 'vitest'
import { classifySleeve, sleevesInUse, SLEEVE_SYMBOLS } from './universe.js'

describe('universe sleeve classifier', () => {
  it('maps the tech-beta cluster all into us_equity (one bet, not three)', () => {
    expect(classifySleeve('SPY')).toBe('us_equity')
    expect(classifySleeve('QQQ')).toBe('us_equity')
    expect(classifySleeve('AAPL')).toBe('us_equity')
  })

  it('maps each diversifier to its own sleeve', () => {
    expect(classifySleeve('TLT')).toBe('treasuries')
    expect(classifySleeve('GLD')).toBe('gold')
    expect(classifySleeve('DBC')).toBe('commodities')
    expect(classifySleeve('VEA')).toBe('intl_equity')
  })

  it('treats crypto pairs as their own sleeve', () => {
    expect(classifySleeve('BTC/USD')).toBe('crypto')
    expect(classifySleeve('eth/usd')).toBe('crypto')
  })

  it('defaults unknown US-listed names to us_equity (fail toward concentration awareness)', () => {
    expect(classifySleeve('TSLA')).toBe('us_equity')
  })

  it('sleevesInUse dedupes correlated names into a single sleeve', () => {
    const s = sleevesInUse(['SPY', 'QQQ', 'AAPL'])
    expect(s.size).toBe(1)
    expect(s.has('us_equity')).toBe(true)
  })

  it('exposes a representative symbol per non-crypto sleeve', () => {
    expect(SLEEVE_SYMBOLS.us_equity).toBe('VTI')
    expect(SLEEVE_SYMBOLS.treasuries).toBe('TLT')
  })
})
