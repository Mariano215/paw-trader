import { describe, it, expect, vi } from 'vitest'
import Database from 'better-sqlite3'
import { initTraderTables } from './db.js'
import { buildProgressSnapshot, checkPaperProgress, PROGRESS_DELIVERY_KEY, PROGRESS_KV_KEY, renderProgressReport } from './progress-monitor.js'

const health = {status: 'ok', version: 'test', alpaca_mode: 'paper', alpaca_connected: true, reconciler_halted: false}
const summer = Date.parse('2026-09-06T21:00:00Z') // 17:00 EDT
function fixture(now = summer) {
  const db = new Database(':memory:')
  initTraderTables(db)
  db.exec('CREATE TABLE IF NOT EXISTS kv_settings (key TEXT PRIMARY KEY,value TEXT NOT NULL)')
  db.prepare('INSERT INTO kv_settings VALUES (?,?)').run('trader.accounting.last', JSON.stringify({
    evaluated_at: now, round_trips: 12, realized_total: 98, costs_complete: false,
  }))
  return db
}

describe('paper progress monitoring', () => {
  it('stores a snapshot without sending before 17:00 Eastern', async () => {
    const db = fixture(), send = vi.fn()
    expect((await checkPaperProgress(db, health, send, summer - 1)).sent).toBe(false)
    expect(send).not.toHaveBeenCalled()
    expect(db.prepare('SELECT value FROM kv_settings WHERE key=?').get(PROGRESS_KV_KEY)).toBeDefined()
    db.close()
  })

  it('delivers once per day, persists the marker, and catches up after a missed slot', async () => {
    const db = fixture(), send = vi.fn().mockResolvedValue(undefined)
    expect((await checkPaperProgress(db, health, send, summer)).sent).toBe(true)
    expect((await checkPaperProgress(db, health, send, summer + 300000)).sent).toBe(false)
    expect((await checkPaperProgress(db, health, send, summer + 86400000 + 3600000)).sent).toBe(true)
    expect(send).toHaveBeenCalledTimes(2)
    expect(db.prepare('SELECT value FROM kv_settings WHERE key=?').get(PROGRESS_DELIVERY_KEY)).toBeDefined()
    db.close()
  })

  it('uses Eastern standard time after DST ends', async () => {
    const db = fixture(), send = vi.fn().mockResolvedValue(undefined)
    const winter = Date.parse('2026-11-02T22:00:00Z')
    expect((await checkPaperProgress(db, health, send, winter - 1)).sent).toBe(false)
    expect((await checkPaperProgress(db, health, send, winter)).sent).toBe(true)
    db.close()
  })

  it('retries failed delivery without setting a success marker', async () => {
    const db = fixture(), send = vi.fn().mockRejectedValueOnce(new Error('delivery unavailable')).mockResolvedValue(undefined)
    await expect(checkPaperProgress(db, health, send, summer)).rejects.toThrow('delivery unavailable')
    expect(db.prepare('SELECT value FROM kv_settings WHERE key=?').get(PROGRESS_DELIVERY_KEY)).toBeUndefined()
    expect((await checkPaperProgress(db, health, send, summer + 300000)).sent).toBe(true)
    db.close()
  })

  it('coalesces concurrent sends', async () => {
    const db = fixture()
    let done!: () => void
    const send = vi.fn(() => new Promise<void>(resolve => {done = resolve}))
    const first = checkPaperProgress(db, health, send, summer)
    expect((await checkPaperProgress(db, health, send, summer)).sent).toBe(false)
    done()
    await first
    expect(send).toHaveBeenCalledTimes(1)
    db.close()
  })

  it('reports missing/stale data as unknown and never certifies readiness', () => {
    const db = fixture()
    const snapshot = buildProgressSnapshot(db, null, summer + 3600000)
    expect(snapshot.mode).toBe('unknown')
    expect(snapshot.completed_entries).toBeNull()
    expect(snapshot.realized_recorded_fees).toBeNull()
    expect(snapshot.gate_current).toBe(false)
    const report = renderProgressReport(snapshot, 10)
    expect(report).toContain('unavailable/stale')
    expect(report).toContain('No automatic live switch')
    expect(report).toContain('More calendar time alone cannot clear missing evidence')
    db.close()
  })

  it('labels the completed-entry delta and incomplete costs', () => {
    const db = fixture()
    const report = renderProgressReport(buildProgressSnapshot(db, health, summer), 10)
    expect(report).toContain('+2 since prior report')
    expect(report).toContain('recorded fees only: $98.00')
    expect(report).toContain('not verified')
    db.close()
  })
})
