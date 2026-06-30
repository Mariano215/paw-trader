import { describe, it, expect } from 'vitest'
import { evaluateClusterGate, clusterFor, DEFAULT_CLUSTER_CAP_PCT } from './correlation-gate.js'
import type { EnginePosition } from './types.js'

function pos(asset: string, mv: number): EnginePosition {
  return { asset, qty: 1, avg_entry_price: mv, market_value: mv, unrealized_pnl: 0, source: 'test', updated_at: Date.now() }
}

describe('correlation cluster gate', () => {
  it('maps SPY/QQQ/AAPL into one cluster and a new ticker to itself', () => {
    expect(clusterFor('SPY')).toBe('us-large-cap-beta')
    expect(clusterFor('qqq')).toBe('us-large-cap-beta')
    expect(clusterFor('AAPL')).toBe('us-large-cap-beta')
    expect(clusterFor('TSLA')).toBe('TSLA')
  })

  it('blocks a buy that pushes the cluster over the NAV cap', () => {
    const r = evaluateClusterGate({
      asset: 'AAPL',
      proposedSizeUsd: 2000,
      positions: [pos('SPY', 2000), pos('QQQ', 1000)],
      nav: 10000,
      capPct: 0.25, // cap = 2500, current = 3000 already over
    })
    expect(r.allowed).toBe(false)
    expect(r.currentExposureUsd).toBe(3000)
    expect(r.allowedSizeUsd).toBe(0)
  })

  it('allows a buy that fits under the cap and reports headroom size', () => {
    const r = evaluateClusterGate({
      asset: 'AAPL',
      proposedSizeUsd: 200,
      positions: [pos('SPY', 1000)],
      nav: 10000,
      capPct: 0.25, // cap = 2500, current = 1000, headroom = 1500
    })
    expect(r.allowed).toBe(true)
    expect(r.allowedSizeUsd).toBe(200)
  })

  it('is a no-op pass when NAV is unavailable', () => {
    const r = evaluateClusterGate({ asset: 'SPY', proposedSizeUsd: 5000, positions: [pos('QQQ', 9999)], nav: null })
    expect(r.allowed).toBe(true)
    expect(r.allowedSizeUsd).toBe(5000)
  })

  it('does not count unrelated clusters toward the cap', () => {
    const r = evaluateClusterGate({
      asset: 'SPY',
      proposedSizeUsd: 1000,
      positions: [pos('TSLA', 5000)],
      nav: 10000,
      capPct: 0.25,
    })
    expect(r.allowed).toBe(true)
    expect(r.currentExposureUsd).toBe(0)
  })

  it('maps E4 diversifier sleeves to their own clusters (not lumped with equity)', () => {
    expect(clusterFor('TLT')).toBe('long-treasuries')
    expect(clusterFor('IEF')).toBe('long-treasuries')
    expect(clusterFor('GLD')).toBe('gold')
    expect(clusterFor('IAU')).toBe('gold')
    expect(clusterFor('DBC')).toBe('commodities')
    expect(clusterFor('VEA')).toBe('intl-equity')
    expect(clusterFor('EEM')).toBe('intl-equity')
  })

  it('does not count treasury exposure toward the equity cluster cap', () => {
    // TLT is in long-treasuries, not us-large-cap-beta. A large TLT position
    // should not block an SPY buy.
    const r = evaluateClusterGate({
      asset: 'SPY',
      proposedSizeUsd: 500,
      positions: [pos('TLT', 8000)],
      nav: 10000,
      capPct: 0.20,
    })
    expect(r.allowed).toBe(true)
    expect(r.currentExposureUsd).toBe(0)
    expect(r.cluster).toBe('us-large-cap-beta')
  })

  it('caps treasuries independently from equities', () => {
    // TLT already at cap; a second TLT buy should be blocked.
    const r = evaluateClusterGate({
      asset: 'TLT',
      proposedSizeUsd: 500,
      positions: [pos('TLT', 2000)],
      nav: 10000,
      capPct: 0.20,
    })
    expect(r.cluster).toBe('long-treasuries')
    expect(r.allowed).toBe(false)
    expect(r.allowedSizeUsd).toBe(0)
  })

  it('uses DEFAULT_CLUSTER_CAP_PCT (0.50) when capPct is omitted', () => {
    expect(DEFAULT_CLUSTER_CAP_PCT).toBe(0.50)
    // nav=10000, default cap = 10000 * 0.50 = 5000. Current=4500, headroom=500.
    // proposed=300 fits -> allowed. allowedSizeUsd = 300.
    const fits = evaluateClusterGate({
      asset: 'SPY',
      proposedSizeUsd: 300,
      positions: [pos('QQQ', 4500)],
      nav: 10000,
      // capPct intentionally omitted
    })
    expect(fits.allowed).toBe(true)
    expect(fits.capUsd).toBe(5000)
    expect(fits.allowedSizeUsd).toBe(300)

    // proposed=600 exceeds headroom of 500 -> not allowed, allowedSizeUsd=500.
    const exceeds = evaluateClusterGate({
      asset: 'SPY',
      proposedSizeUsd: 600,
      positions: [pos('QQQ', 4500)],
      nav: 10000,
    })
    expect(exceeds.allowed).toBe(false)
    expect(exceeds.allowedSizeUsd).toBe(500)
  })
})
