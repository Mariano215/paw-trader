/**
 * trader-routes/shared.ts
 *
 * Common types, constants, and helpers used by two or more trader-route
 * sub-modules. The Paw Trader engine is a long-running Python service on
 * WSL2 that exposes a REST API protected by a shared X-Engine-Token
 * header. The dashboard shouldn't call that API directly from the browser
 * (the engine token would leak into client code), so these helpers back
 * the minimal read-only status proxies we need.
 *
 * Credentials live in the bot DB (project_credentials table,
 * project_id='trader') and are consumed here via the same pattern other
 * server routes use (getBotDb + credDecryptForVerify). We intentionally
 * don't import from ../../src -- server/tsconfig.json has rootDir=src and
 * those imports would fall outside it, and the bot's credentials module
 * keeps its own private DB handle that isn't initialised in this process
 * anyway.
 */

import { getBotDb, credDecryptForVerify } from '../db.js'
import { logger } from '../logger.js'

export const ENGINE_REQUEST_TIMEOUT_MS = 5000

// Minimal shape of /health we care about on the dashboard. Mirrors
// src/trader/types.ts in the bot package. Kept narrow on purpose.
export interface EngineHealth {
  status: string
  version?: string
  alpaca_connected: boolean
  alpaca_mode: 'paper' | 'live' | string
  // Phase 5 Task 2c -- optional because older engine builds predate the
  // field. Dashboard null-coalesces to suppress the Coinbase pill in that
  // case rather than showing a misleading "Coinbase ERROR".
  coinbase_connected?: boolean
}

export interface EngineReconcile {
  id: string
  ran_at: number
  drift_detected: boolean
  drift_summary: string | null
  action_taken: string
}

// ---------------------------------------------------------------------------
// Credential lookup
// ---------------------------------------------------------------------------

export function readTraderCredential(key: string): string | null {
  const bdb = getBotDb()
  if (!bdb) return null
  try {
    const row = bdb
      .prepare(
        'SELECT value, iv, tag FROM project_credentials WHERE project_id = ? AND service = ? AND key = ?',
      )
      .get('trader', 'engine', key) as
      | { value: Buffer; iv: Buffer; tag: Buffer }
      | undefined
    if (!row) return null
    return credDecryptForVerify(row.value, row.iv, row.tag)
  } catch (err) {
    logger.warn({ err, key }, 'trader: credential read failed')
    return null
  }
}

export interface EngineConfig {
  baseUrl: string
  token: string
}

export function getEngineConfig(): EngineConfig | null {
  // Env vars take priority (simplest for server-side deployment on Hostinger)
  const envUrl = process.env.TRADER_ENGINE_URL
  const envToken = process.env.TRADER_ENGINE_TOKEN
  if (envUrl && envToken) return { baseUrl: envUrl.replace(/\/$/, ''), token: envToken }

  // Fall back to credential store -- try both key name conventions
  const baseUrl = readTraderCredential('url') ?? readTraderCredential('base_url')
  const token = readTraderCredential('token') ?? readTraderCredential('auth_token')
  if (!baseUrl || !token) return null
  return { baseUrl: baseUrl.replace(/\/$/, ''), token }
}

/**
 * Fetch a JSON payload from the engine with the shared X-Engine-Token
 * auth and the ENGINE_REQUEST_TIMEOUT_MS abort signal applied for free.
 *
 * GET is the default.  Pass an optional RequestInit to override method,
 * attach a body, or pass additional headers:
 *
 *   await engineFetch<{ status: string }>(cfg, '/risk/halt', {
 *     method: 'POST',
 *     body: JSON.stringify({ reason }),
 *   })
 *
 * The caller is responsible for JSON.stringify on body payloads -- the
 * helper is a thin typed wrapper around fetch, not a serialiser.  Any
 * headers on init are merged on top of the auth + Content-Type defaults,
 * so a caller can override Content-Type for a non-JSON request without
 * needing a second helper.  Any non-2xx response throws so the caller
 * can surface it as a 502 to the dashboard.
 *
 * Phase 7 Task 6 -- this helper used to be GET-only; the halt and
 * clear-breaker handlers each inlined their own fetch with the auth
 * header hand-copied.  The init overload folded that duplication back
 * into one code path.
 */
export async function engineFetch<T>(
  cfg: EngineConfig,
  path: string,
  init?: RequestInit,
): Promise<T> {
  const headers: Record<string, string> = {
    'X-Engine-Token': cfg.token,
    'Content-Type': 'application/json',
    ...(init?.headers as Record<string, string> | undefined),
  }
  const resp = await fetch(cfg.baseUrl + path, {
    ...init,
    headers,
    signal: init?.signal ?? AbortSignal.timeout(ENGINE_REQUEST_TIMEOUT_MS),
  })
  if (!resp.ok) {
    throw new Error('Engine API error ' + resp.status + ' on ' + path)
  }
  return (await resp.json()) as T
}

// ---------------------------------------------------------------------------
// Shared DB row shapes used by two or more sub-modules.
// ---------------------------------------------------------------------------

// Row shape used by both the trader-wide decisions list (committee.ts) and
// the per-strategy decisions list (strategies.ts). Kept in shared so the
// two endpoints cannot drift.
export interface TraderDecisionRow {
  id: string
  signal_id: string
  action: string
  asset: string
  size_usd: number | null
  entry_type: string | null
  thesis: string
  confidence: number
  committee_transcript_id: string | null
  decided_at: number
  status: string
}

// Attribution JSON wrapper used by per-strategy attribution (strategies.ts)
// and trader-wide committee-report (committee.ts). Both routes feed these
// rows into `aggregateAttribution` from trader-attribution-aggregator.ts.
export interface VerdictAttributionRow {
  agent_attribution_json: string
}

// ---------------------------------------------------------------------------
// Strategy existence / status helpers
//
// Used by every per-strategy drill-down route (strategies.ts, verdicts.ts)
// plus the CSV export, so they live here rather than being duplicated.
// ---------------------------------------------------------------------------

export function strategyExists(bdb: ReturnType<typeof getBotDb>, strategyId: string): boolean {
  if (!bdb) return false
  try {
    const row = bdb
      .prepare('SELECT 1 AS present FROM trader_strategies WHERE id = ? LIMIT 1')
      .get(strategyId) as { present: number } | undefined
    return Boolean(row)
  } catch (err) {
    logger.warn({ err, strategyId }, 'trader: strategy existence check failed')
    return false
  }
}

// Returns the strategy.status string when the row exists, null otherwise.
// Used by the verdicts response so the drill-down page can render the
// pause button in the correct enabled/disabled state without an extra
// round-trip to a separate strategy detail endpoint.
export function strategyStatus(bdb: ReturnType<typeof getBotDb>, strategyId: string): string | null {
  if (!bdb) return null
  try {
    const row = bdb
      .prepare('SELECT status FROM trader_strategies WHERE id = ? LIMIT 1')
      .get(strategyId) as { status: string } | undefined
    return row ? row.status : null
  } catch (err) {
    logger.warn({ err, strategyId }, 'trader: strategy status read failed')
    return null
  }
}
