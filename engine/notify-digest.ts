/**
 * Trader Telegram throttle + plain-English digest.
 *
 * Goal: stop per-event trader spam. Real problems ("issues") still page the
 * operator the instant they happen. Everything routine (trades placed, signals
 * skipped, self-healed hiccups) is buffered and summarised in plain English
 * twice a day so a non-trader can understand what happened without jargon.
 *
 * Wiring:
 *   - index.ts wraps `traderSend` with makeDigestingSend(): issues pass straight
 *     through, routine messages land in trader_digest_buffer.
 *   - the scheduler calls maybeFireTraderDigest() every tick; it fires at the two
 *     daily slots, drains the buffer, and sends one plain-English summary via the
 *     RAW send (so the digest itself is never re-buffered).
 *
 * State (mirrors weekly-report.ts): last-fire ms in kv_settings, buffer rows in
 * trader_digest_buffer. All timestamps are ms (Date.now()), per project rule.
 */
import type Database from 'better-sqlite3'
import { logger as baseLogger } from '../logger.js'

const logger = baseLogger.child({ mod: 'trader-digest' })

const DIGEST_KV_KEY = 'trader:digest_last_fire'
/** Local hours at which the digest fires. */
const DIGEST_HOURS = [8, 20]
/** Min gap since last fire so two ticks in the same slot can't double-send. */
const MIN_GAP_MS = 6 * 60 * 60 * 1000

let inFlightFire = false

/**
 * Issue = a real problem the operator must see now. Matched case-insensitively
 * against the message text. Keep this list aligned with the trader alert call
 * sites: anything that is NOT an issue gets buffered into the digest.
 */
const ISSUE_RE = /\bALERT\b|\bhalt(ed)?\b|unreachable|could not|did not start|kill[\s-]?switch|NAV drop|engine submit rejected/i
/** Weekly report is low-volume and already a digest; let it through instantly. */
const REPORT_RE = /weekly report|^Report:|\bReport:\s/im
/** Trade event lines we can render into plain English. */
const TRADE_RE = /^(EXECUTED|SKIPPED):\s*(BUY|SELL)?\s*([A-Z][A-Z0-9/]*)?\s*\$?([\d.]+)?/i

/** Plain-English names for the ETFs/stocks the strategies actually trade. */
const TICKER_NAMES: Record<string, string> = {
  SPY: 'S&P 500 fund',
  QQQ: 'Nasdaq-100 fund',
  IWM: 'small US companies fund',
  VTI: 'total US market fund',
  EFA: 'developed international fund',
  EEM: 'emerging markets fund',
  DIA: 'Dow Jones fund',
  AAPL: 'Apple',
  'BTC/USD': 'Bitcoin',
  'ETH/USD': 'Ethereum',
}

function plainName(ticker: string): string {
  const t = ticker.toUpperCase()
  return TICKER_NAMES[t] ? `${t} (${TICKER_NAMES[t]})` : t
}

export function isTraderIssue(text: string): boolean {
  if (REPORT_RE.test(text)) return true // reports go out instantly, not in digest
  return ISSUE_RE.test(text)
}

function ensureBufferTable(db: Database.Database): void {
  db.prepare(`
    CREATE TABLE IF NOT EXISTS trader_digest_buffer (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      text       TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )
  `).run()
}

function bufferRoutine(db: Database.Database, text: string, nowMs: number): void {
  ensureBufferTable(db)
  db.prepare('INSERT INTO trader_digest_buffer (text, created_at) VALUES (?, ?)').run(text, nowMs)
}

/**
 * Wrap the raw trader send. Issues (and reports) send immediately; everything
 * else is buffered for the next digest. A buffer failure falls back to sending
 * the raw message so we never silently swallow output.
 */
export function makeDigestingSend(
  db: Database.Database,
  rawSend: (text: string) => Promise<void>,
): (text: string) => Promise<void> {
  return async (text: string) => {
    if (isTraderIssue(text)) {
      await rawSend(text)
      return
    }
    try {
      bufferRoutine(db, text, Date.now())
    } catch (err) {
      logger.warn({ err }, 'digest buffer write failed; sending raw to avoid losing the message')
      await rawSend(text)
    }
  }
}

export function readLastDigestMs(db: Database.Database): number | null {
  try {
    const row = db.prepare('SELECT value FROM kv_settings WHERE key = ?').get(DIGEST_KV_KEY) as
      | { value: string }
      | undefined
    if (!row) return null
    const n = Number(row.value)
    return Number.isFinite(n) ? n : null
  } catch {
    return null
  }
}

function writeLastDigestMs(db: Database.Database, ms: number): void {
  db.prepare('CREATE TABLE IF NOT EXISTS kv_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)').run()
  db.prepare('INSERT OR REPLACE INTO kv_settings (key, value) VALUES (?, ?)').run(DIGEST_KV_KEY, String(ms))
}

/**
 * Fire when the local hour is one of DIGEST_HOURS and we have not fired within
 * MIN_GAP_MS. Pure function so it is unit-testable with injected clocks.
 */
export function shouldFireDigest(nowMs: number, lastFireMs: number | null): boolean {
  const hour = new Date(nowMs).getHours()
  if (!DIGEST_HOURS.includes(hour)) return false
  if (lastFireMs != null && nowMs - lastFireMs < MIN_GAP_MS) return false
  return true
}

interface BufferRow { id: number; text: string; created_at: number }

/**
 * Turn buffered routine messages into one plain-English summary. Exported for
 * unit testing. `nowMs` only drives the closing "next update" hint.
 */
export function renderDigest(rows: BufferRow[], nowMs: number): string {
  const bought: string[] = []
  const sold: string[] = []
  let skipped = 0
  const other: string[] = []

  for (const r of rows) {
    const firstLine = r.text.split('\n')[0]?.trim() ?? ''
    const m = firstLine.match(TRADE_RE)
    if (m) {
      const kind = m[1].toUpperCase()
      const side = (m[2] ?? '').toUpperCase()
      const asset = m[3] ?? ''
      const size = m[4]
      if (kind === 'SKIPPED') {
        skipped++
      } else if (asset) {
        const dollars = size ? `$${size} of ` : ''
        const line = `${dollars}${plainName(asset)}`
        if (side === 'SELL') sold.push(line)
        else bought.push(line)
      }
      continue
    }
    if (firstLine) other.push(firstLine)
  }

  const parts: string[] = ['Trading update (since the last one):', '']

  if (bought.length === 0 && sold.length === 0 && skipped === 0 && other.length === 0) {
    parts.push('Quiet stretch. No trades and nothing needed attention.')
  } else {
    if (bought.length > 0) {
      parts.push(`Bought: ${bought.length}`)
      for (const b of bought) parts.push(`  - ${b}`)
    }
    if (sold.length > 0) {
      parts.push(`Sold: ${sold.length}`)
      for (const s of sold) parts.push(`  - ${s}`)
    }
    if (skipped > 0) {
      parts.push(`Passed on ${skipped} possible ${skipped === 1 ? 'trade' : 'trades'} (did not meet the bar).`)
    }
    if (other.length > 0) {
      parts.push('')
      parts.push('Other updates:')
      for (const o of other) parts.push(`  - ${o}`)
    }
  }

  parts.push('')
  const nextHour = DIGEST_HOURS.find(h => h > new Date(nowMs).getHours()) ?? DIGEST_HOURS[0]
  parts.push(`No problems to report. Next update around ${nextHour}:00.`)
  return parts.join('\n')
}

/**
 * Scheduler gate: at each daily slot, drain the buffer and send one plain
 * summary via the RAW send. Mirrors maybeFireWeeklyReport: state persisted
 * FIRST so a send failure cannot loop, plus an in-flight guard against
 * overlapping ticks.
 */
export async function maybeFireTraderDigest(args: {
  db: Database.Database
  send: (text: string) => Promise<void>
  nowMs?: number
}): Promise<{ fired: boolean; reason?: string; count?: number }> {
  const nowMs = args.nowMs ?? Date.now()
  if (!shouldFireDigest(nowMs, readLastDigestMs(args.db))) {
    return { fired: false, reason: 'not a digest slot or fired too recently' }
  }
  if (inFlightFire) return { fired: false, reason: 'fire already in flight' }
  inFlightFire = true
  try {
    // Persist FIRST so a downstream send failure cannot re-fire next tick.
    writeLastDigestMs(args.db, nowMs)

    ensureBufferTable(args.db)
    const rows = args.db
      .prepare('SELECT id, text, created_at FROM trader_digest_buffer ORDER BY created_at ASC')
      .all() as BufferRow[]

    // Nothing buffered = nothing worth a ping. Skip the "quiet stretch"
    // message entirely; silence IS the all-clear.
    if (rows.length === 0) {
      return { fired: false, reason: 'buffer empty, skipping quiet digest', count: 0 }
    }

    const summary = renderDigest(rows, nowMs)
    await args.send(summary)

    // Clear only the rows we just summarised (id <= max seen), so anything
    // buffered during the send survives to the next digest.
    if (rows.length > 0) {
      const maxId = rows[rows.length - 1].id
      args.db.prepare('DELETE FROM trader_digest_buffer WHERE id <= ?').run(maxId)
    }
    return { fired: true, count: rows.length }
  } finally {
    inFlightFire = false
  }
}
