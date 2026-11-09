import type Database from 'better-sqlite3'
import type { EnginePosition } from './types.js'

export const POSITION_QTY_EPSILON = 1e-9
export const UNEXPECTED_SHORT_KV_KEY = 'trader.position_safety.unexpected_shorts'

export function findUnexpectedShortPositions(positions: EnginePosition[]): EnginePosition[] {
  return positions
    .filter(position => Number.isFinite(position.qty) && position.qty < -POSITION_QTY_EPSILON)
    .sort((a, b) => a.asset.localeCompare(b.asset))
}

function shortFingerprint(shorts: EnginePosition[]): string {
  return JSON.stringify(shorts.map(({asset, qty}) => [asset, qty]))
}

export function renderUnexpectedShortAlert(shorts: EnginePosition[]): string {
  const holdings = shorts.map(position => `${position.asset} ${position.qty}`).join(', ')
  return `TRADER ALERT: UNEXPECTED SHORT POSITION: ${holdings}. ` +
    'New entries are blocked. Flatten the short at the broker, then verify positions and fill history before resuming.'
}

/** Persisted edge-triggered alert. A process restart does not re-page the same exposure. */
export async function notifyUnexpectedShortPositions(
  db: Database.Database,
  positions: EnginePosition[],
  send: (text: string) => Promise<void>,
): Promise<EnginePosition[]> {
  const shorts = findUnexpectedShortPositions(positions)
  db.prepare('CREATE TABLE IF NOT EXISTS kv_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)').run()
  if (shorts.length === 0) {
    db.prepare('DELETE FROM kv_settings WHERE key = ?').run(UNEXPECTED_SHORT_KV_KEY)
    return []
  }

  const fingerprint = shortFingerprint(shorts)
  const prior = db.prepare('SELECT value FROM kv_settings WHERE key = ?').get(UNEXPECTED_SHORT_KV_KEY) as
    | {value: string}
    | undefined
  if (prior?.value === fingerprint) return shorts

  try {
    await send(renderUnexpectedShortAlert(shorts))
    db.prepare('INSERT OR REPLACE INTO kv_settings (key, value) VALUES (?, ?)')
      .run(UNEXPECTED_SHORT_KV_KEY, fingerprint)
  } catch {
    // Keep the prior fingerprint so a transient channel failure retries next tick.
  }
  return shorts
}
