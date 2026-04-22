import { randomUUID } from 'crypto'
import type Database from 'better-sqlite3'

export type SuppressionReason = 'skip' | 'timeout' | 'committee_abstain'

export interface SignalSuppressionSnapshot {
  signal_id: string
  strategy_id: string
  asset: string
  side: 'buy' | 'sell'
  raw_score: number
  enrichment_json: string | null
}

export interface SignalSuppressionRow {
  id: string
  signal_id: string | null
  strategy_id: string
  asset: string
  side: 'buy' | 'sell'
  reason: SuppressionReason
  raw_score: number
  enrichment_fingerprint: string | null
  suppressed_at: number
}

export const SIGNAL_RE_ALERT_MAX_AGE_MS = 24 * 60 * 60 * 1000
export const SIGNAL_RE_ALERT_SCORE_DELTA = 0.05

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortJson)
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, child]) => [key, sortJson(child)]),
    )
  }
  return value
}

export function fingerprintEnrichment(enrichmentJson: string | null): string | null {
  if (!enrichmentJson) return null
  const trimmed = enrichmentJson.trim()
  if (!trimmed) return null
  try {
    return JSON.stringify(sortJson(JSON.parse(trimmed)))
  } catch {
    return trimmed
  }
}

export function recordSignalSuppression(
  db: Database.Database,
  snapshot: SignalSuppressionSnapshot,
  reason: SuppressionReason,
  suppressedAt = Date.now(),
): void {
  db.prepare(`
    INSERT INTO trader_signal_suppressions
      (id, signal_id, strategy_id, asset, side, reason, raw_score, enrichment_fingerprint, suppressed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    randomUUID(),
    snapshot.signal_id,
    snapshot.strategy_id,
    snapshot.asset,
    snapshot.side,
    reason,
    snapshot.raw_score,
    fingerprintEnrichment(snapshot.enrichment_json),
    suppressedAt,
  )
}

export function recordSignalSuppressionBySignalId(
  db: Database.Database,
  signalId: string,
  reason: SuppressionReason,
  suppressedAt = Date.now(),
): void {
  const signal = db.prepare(`
    SELECT id AS signal_id, strategy_id, asset, side, raw_score, enrichment_json
    FROM trader_signals
    WHERE id = ?
  `).get(signalId) as SignalSuppressionSnapshot | undefined
  if (!signal) return
  recordSignalSuppression(db, signal, reason, suppressedAt)
}

export function getLatestSignalSuppression(
  db: Database.Database,
  strategyId: string,
  asset: string,
  side: 'buy' | 'sell',
): SignalSuppressionRow | null {
  const row = db.prepare(`
    SELECT id, signal_id, strategy_id, asset, side, reason, raw_score, enrichment_fingerprint, suppressed_at
    FROM trader_signal_suppressions
    WHERE strategy_id = ?
      AND asset = ?
      AND side = ?
    ORDER BY suppressed_at DESC
    LIMIT 1
  `).get(strategyId, asset, side) as SignalSuppressionRow | undefined
  return row ?? null
}

export function shouldSuppressSignalRealert(
  db: Database.Database,
  snapshot: Omit<SignalSuppressionSnapshot, 'signal_id'>,
  now = Date.now(),
): boolean {
  const latest = getLatestSignalSuppression(db, snapshot.strategy_id, snapshot.asset, snapshot.side)
  if (!latest) return false
  if (now - latest.suppressed_at >= SIGNAL_RE_ALERT_MAX_AGE_MS) return false
  if (Math.abs(snapshot.raw_score - latest.raw_score) >= SIGNAL_RE_ALERT_SCORE_DELTA) return false
  if (fingerprintEnrichment(snapshot.enrichment_json) !== latest.enrichment_fingerprint) return false
  return true
}
