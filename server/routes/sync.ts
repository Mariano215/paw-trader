/**
 * trader-routes/sync.ts
 *
 * POST /api/v1/internal/trader-sync
 *
 * Bot-internal endpoint. After each trader tick the bot POSTs a compact
 * snapshot of every trader table so the dashboard server always has
 * current data -- without a full DB push or a separate cron job.
 *
 * Auth: requireBotOrAdmin (same gate as other /internal/* routes).
 * Body: TraderSyncPayload (see interface below).
 *
 * Each table uses INSERT OR REPLACE so rows are idempotent. The server
 * never deletes rows -- omitting a row from the payload leaves it intact.
 * This means the server gradually accumulates a full history as each
 * sync window slides forward; the first sync seeds all recent rows and
 * subsequent syncs keep them up to date.
 *
 * Row counts are capped server-side at MAX_ROWS_PER_TABLE to protect
 * against accidental oversized payloads. The bot naturally sends at most
 * 30-day windows so this cap is a safety net, not a normal limit.
 */

import { Router, type Request, type Response } from 'express'
import { getBotDbWrite } from '../db.js'
import { logger } from '../logger.js'
import { requireBotOrAdmin } from '../auth.js'

const router = Router()

const MAX_ROWS_PER_TABLE = 5000

// ---------------------------------------------------------------------------
// Payload shape -- mirrors the bot's trader DB tables exactly.
// All fields are optional so the bot can send partial payloads when only
// some tables changed; missing keys are silently skipped.
// ---------------------------------------------------------------------------

interface TraderSyncPayload {
  strategies?:    Record<string, unknown>[]
  signals?:       Record<string, unknown>[]
  approvals?:     Record<string, unknown>[]
  decisions?:     Record<string, unknown>[]
  transcripts?:   Record<string, unknown>[]
  verdicts?:      Record<string, unknown>[]
  track_records?: Record<string, unknown>[]
  circuit_breakers?: Record<string, unknown>[]
  pnl_snapshots?: Record<string, unknown>[]
  alert_state?:   Record<string, unknown>[]
}

// Maps payload key → { table name, columns in insert order }
const TABLE_MAP: Record<keyof TraderSyncPayload, { table: string; cols: string[] }> = {
  strategies: {
    table: 'trader_strategies',
    cols: ['id', 'name', 'asset_class', 'tier', 'status', 'params_json', 'created_at', 'updated_at', 'max_size_usd'],
  },
  signals: {
    table: 'trader_signals',
    cols: ['id', 'strategy_id', 'asset', 'side', 'raw_score', 'horizon_days', 'enrichment_json', 'generated_at', 'status'],
  },
  approvals: {
    table: 'trader_approvals',
    cols: ['id', 'decision_id', 'sent_at', 'responded_at', 'response', 'override_size'],
  },
  decisions: {
    table: 'trader_decisions',
    cols: ['id', 'signal_id', 'action', 'asset', 'size_usd', 'entry_type', 'entry_price', 'stop_loss', 'take_profit', 'thesis', 'confidence', 'committee_transcript_id', 'decided_at', 'status'],
  },
  transcripts: {
    table: 'trader_committee_transcripts',
    cols: ['id', 'signal_id', 'transcript_json', 'rounds', 'total_tokens', 'total_cost_usd', 'created_at'],
  },
  verdicts: {
    table: 'trader_verdicts',
    cols: ['id', 'decision_id', 'pnl_gross', 'pnl_net', 'bench_return', 'hold_drawdown', 'thesis_grade', 'agent_attribution_json', 'embedding_id', 'closed_at', 'returns_backfilled'],
  },
  track_records: {
    table: 'trader_strategy_track_record',
    cols: ['strategy_id', 'trade_count', 'win_count', 'rolling_sharpe', 'avg_winner_pct', 'avg_loser_pct', 'max_dd_pct', 'net_pnl_usd', 'computed_at'],
  },
  circuit_breakers: {
    table: 'trader_circuit_breakers',
    cols: ['id', 'rule', 'tripped_at', 'reason', 'cleared_at', 'cleared_by'],
  },
  pnl_snapshots: {
    table: 'trader_pnl_snapshots',
    cols: ['date', 'nav_open', 'nav_close', 'pnl_day', 'trades_count', 'bench_return', 'cumulative_pnl'],
  },
  alert_state: {
    table: 'trader_alert_state',
    cols: ['alert_id', 'last_alerted_at'],
  },
}

router.post('/api/v1/internal/trader-sync', requireBotOrAdmin, (req: Request, res: Response) => {
  const bdb = getBotDbWrite()
  if (!bdb) {
    res.status(503).json({ error: 'bot database unavailable' })
    return
  }

  const payload = req.body as TraderSyncPayload
  if (!payload || typeof payload !== 'object') {
    res.status(400).json({ error: 'invalid payload' })
    return
  }

  const results: Record<string, number> = {}

  try {
    const syncAll = bdb.transaction(() => {
      for (const [key, spec] of Object.entries(TABLE_MAP) as [keyof TraderSyncPayload, { table: string; cols: string[] }][]) {
        const rows = payload[key]
        if (!rows || !Array.isArray(rows) || rows.length === 0) continue

        const capped = rows.slice(0, MAX_ROWS_PER_TABLE)
        const placeholders = spec.cols.map(() => '?').join(', ')
        const stmt = bdb.prepare(
          `INSERT OR REPLACE INTO ${spec.table} (${spec.cols.join(', ')}) VALUES (${placeholders})`
        )

        let count = 0
        for (const row of capped) {
          const values = spec.cols.map(c => {
            const v = (row as Record<string, unknown>)[c]
            return v === undefined ? null : v
          })
          stmt.run(...values)
          count++
        }
        results[key] = count
      }
    })

    syncAll()
    logger.info({ results }, 'trader-sync: upserted rows')
    res.json({ ok: true, results })
  } catch (err) {
    logger.warn({ err }, 'trader-sync: failed')
    res.status(500).json({ error: 'sync failed' })
  }
})

export default router
