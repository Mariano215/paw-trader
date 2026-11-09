/**
 * trader-db-sync.ts
 *
 * Periodic, deterministic sync of trader history tables (signals/decisions/
 * strategies) from the local bot DB to the Hostinger server DB. Prevents the
 * dashboard's Signal Funnel from drifting behind as the bot generates signals
 * locally that never reach the server copy.
 *
 * Runs IN the bot process on purpose: the bot's launchd context already has
 * disk access to <volume> and SSH access to the server, so it sidesteps the
 * TCC block that hits launchd+bash jobs reading the external volume directly.
 * No LLM -- this is a pure shell-out to scripts/sync-trader-db.sh (upsert), the
 * same script `npm run sync:trader-db` runs.
 *
 * Disable with TRADER_DB_SYNC_ENABLED=false.
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { logger } from '../logger.js'

const execFileP = promisify(execFile)

// dist/trader/trader-db-sync.js -> ../../scripts/sync-trader-db.sh
const SYNC_SCRIPT = fileURLToPath(new URL('../../scripts/sync-trader-db.sh', import.meta.url))
const INTERVAL_MS = 60 * 60 * 1000 // hourly
const FIRST_RUN_DELAY_MS = 5 * 60 * 1000 // let startup settle first
const RUN_TIMEOUT_MS = 120_000

let timer: NodeJS.Timeout | null = null

export async function runTraderDbSyncOnce(): Promise<void> {
  try {
    const { stdout } = await execFileP('bash', [SYNC_SCRIPT], { timeout: RUN_TIMEOUT_MS })
    const summary = stdout.trim().split('\n').slice(-2).join(' | ')
    logger.info({ summary }, 'trader-db-sync: completed')
  } catch (err) {
    // Never throw -- a failed sync must not affect the bot. Next tick retries.
    logger.warn({ err: (err as Error).message }, 'trader-db-sync: failed (will retry next tick)')
  }
}

export function startTraderDbSyncSchedule(): void {
  if (timer) return
  if (process.env.TRADER_DB_SYNC_ENABLED === 'false') {
    logger.info('trader-db-sync: disabled via TRADER_DB_SYNC_ENABLED=false')
    return
  }
  setTimeout(() => { void runTraderDbSyncOnce() }, FIRST_RUN_DELAY_MS)
  timer = setInterval(() => { void runTraderDbSyncOnce() }, INTERVAL_MS)
  timer.unref?.()
  logger.info('trader-db-sync: hourly schedule started')
}
