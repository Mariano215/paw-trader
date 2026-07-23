import { describe, it, expect } from 'vitest'
import Database from 'better-sqlite3'
import { evaluateSymbolCooldown } from './symbol-cooldown.js'
import type { EnginePosition } from './types.js'

const DAY = 24 * 60 * 60 * 1000
const NOW = 1_784_000_000_000

function db(): Database.Database {
  const d = new Database(':memory:')
  d.exec(`CREATE TABLE trader_realized_pnl (
    id TEXT PRIMARY KEY, decision_id TEXT, asset TEXT, qty REAL,
    entry_price REAL, exit_price REAL, entry_ts_ms INTEGER, exit_ts_ms INTEGER,
    fees_usd REAL, pnl_gross REAL, pnl_net REAL, lot_match_rule TEXT, computed_at INTEGER)`)
  return d
}

function loss(d: Database.Database, asset: string, pnl: number, exitMs: number) {
  d.prepare(
    `INSERT INTO trader_realized_pnl VALUES (?,?,?,1,0,0,0,?,0,?,?, 'fifo', 0)`,
  ).run(`${asset}-${exitMs}`, 'dec', asset, exitMs, pnl, pnl)
}

function pos(asset: string, marketValue: number, unrealized: number): EnginePosition {
  return { asset, qty: 10, avg_entry_price: 1, market_value: marketValue, unrealized_pnl: unrealized, source: 'adopted', updated_at: NOW }
}

describe('evaluateSymbolCooldown', () => {
  it('blocks re-entry into a symbol that closed red inside the cooldown', () => {
    // The real EEM sequence: closed red 2026-07-02, bought again 5 days later.
    const d = db()
    loss(d, 'EEM', -118.57, NOW - 5 * DAY)
    const r = evaluateSymbolCooldown({ db: d, asset: 'EEM', side: 'buy', positions: [], nowMs: NOW })
    expect(r.allowed).toBe(false)
    expect(r.rule).toBe('cooldown')
    expect(r.reason).toContain('EEM')
  })

  it('allows re-entry once the cooldown has elapsed', () => {
    const d = db()
    loss(d, 'EEM', -118.57, NOW - 11 * DAY)
    expect(evaluateSymbolCooldown({ db: d, asset: 'EEM', side: 'buy', positions: [], nowMs: NOW }).allowed).toBe(true)
  })

  it('never gates an exit', () => {
    const d = db()
    loss(d, 'EEM', -118.57, NOW - 1 * DAY)
    expect(evaluateSymbolCooldown({ db: d, asset: 'EEM', side: 'sell', positions: [], nowMs: NOW }).allowed).toBe(true)
  })

  it('refuses to add to a position that is underwater', () => {
    const d = db()
    // market_value 9000, unrealized -1000 => basis 10000, down 10%
    const r = evaluateSymbolCooldown({ db: d, asset: 'IWM', side: 'buy', positions: [pos('IWM', 9000, -1000)], nowMs: NOW })
    expect(r.allowed).toBe(false)
    expect(r.rule).toBe('average_down')
  })

  it('ignores a short position (buy-only system never holds one; a buy would cover)', () => {
    const d = db()
    const short = { asset: 'IWM', qty: -10, avg_entry_price: 1, market_value: -9000, unrealized_pnl: -1000, source: 'adopted', updated_at: NOW }
    expect(evaluateSymbolCooldown({ db: d, asset: 'IWM', side: 'buy', positions: [short], nowMs: NOW }).allowed).toBe(true)
  })

  it('allows adding to a winner, and to a position only trivially red', () => {
    const d = db()
    expect(evaluateSymbolCooldown({ db: d, asset: 'VTI', side: 'buy', positions: [pos('VTI', 10500, 500)], nowMs: NOW }).allowed).toBe(true)
    // down 0.5%, inside the tolerance
    expect(evaluateSymbolCooldown({ db: d, asset: 'VTI', side: 'buy', positions: [pos('VTI', 9950, -50)], nowMs: NOW }).allowed).toBe(true)
  })

  it('ignores a profitable prior exit', () => {
    const d = db()
    loss(d, 'SPY', 63.06, NOW - 1 * DAY) // positive pnl_net, not a loss
    expect(evaluateSymbolCooldown({ db: d, asset: 'SPY', side: 'buy', positions: [], nowMs: NOW }).allowed).toBe(true)
  })

  it('allows when the realized-pnl table does not exist', () => {
    const d = new Database(':memory:')
    expect(evaluateSymbolCooldown({ db: d, asset: 'EEM', side: 'buy', positions: [], nowMs: NOW }).allowed).toBe(true)
  })
})
