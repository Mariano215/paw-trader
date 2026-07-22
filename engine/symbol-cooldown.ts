// src/trader/symbol-cooldown.ts
//
// Per-symbol re-entry gate. Two rules, both learned the expensive way from
// EEM between 2026-06-15 and 2026-07-17:
//
//   Rule 1 (cooldown): EEM was bought five times on 06-15, all five closed red
//   on 07-02. Five days later the momentum strategy fired on it again, the book
//   bought five more times, and those closed red on 07-17. Ten trades, zero
//   wins, -$874 -- which was the ENTIRE realized loss of the account. Every
//   other symbol combined was +$215. Nothing in the pipeline noticed that the
//   symbol had just paid out negative; the strategy re-scored it from scratch
//   each bar and the risk gates only ever looked at exposure, never at outcome.
//
//   Rule 2 (no averaging down): the existing symbol cap is a notional ceiling
//   (15% of NAV), so it happily allows adding to a position that is currently
//   underwater as long as there is headroom. That converts a small loser into
//   a large one, which is exactly the second EEM leg.
//
// Both rules only ever BLOCK entries. Exits are never gated -- a cooldown that
// stops you selling would be considerably worse than the disease.

import type Database from 'better-sqlite3'
import type { EnginePosition } from './types.js'

/** Days a symbol is benched after a losing realized exit. The EEM re-entry gap
 *  was 5 days, so anything below that is decorative. 10 gives a real pause
 *  without benching a symbol for a whole quarter. Env-tunable for retuning. */
export const SYMBOL_COOLDOWN_DAYS = Number(process.env.TRADER_SYMBOL_COOLDOWN_DAYS ?? 10)

/** How underwater an open position must be before adding to it is refused.
 *  Not zero: a position a few cents red is noise, not a losing thesis. */
export const AVERAGE_DOWN_TOLERANCE_PCT = Number(process.env.TRADER_AVERAGE_DOWN_TOLERANCE_PCT ?? 0.02)

const ONE_DAY_MS = 24 * 60 * 60 * 1000

export interface SymbolCooldownInput {
  db: Database.Database
  asset: string
  /** 'buy' opens or adds; 'sell' closes. Only 'buy' is gated. */
  side: string
  positions: EnginePosition[]
  nowMs: number
  cooldownDays?: number
}

export interface SymbolCooldownResult {
  allowed: boolean
  /** 'cooldown' | 'average_down' | null */
  rule: 'cooldown' | 'average_down' | null
  reason: string
}

const ALLOW: SymbolCooldownResult = { allowed: true, rule: null, reason: '' }

/**
 * Returns allowed=false when this symbol must not be entered right now.
 *
 * Deliberately reads trader_realized_pnl rather than trader_decisions: a
 * decision only records intent, and we care about what the position actually
 * paid out. Missing table (fresh DB, tests) is treated as "no history, allow".
 */
export function evaluateSymbolCooldown(input: SymbolCooldownInput): SymbolCooldownResult {
  const { db, asset, side, positions, nowMs } = input
  if (side !== 'buy') return ALLOW

  const cooldownDays = input.cooldownDays ?? SYMBOL_COOLDOWN_DAYS

  // --- Rule 1: recent losing exit in this symbol -------------------------
  if (cooldownDays > 0) {
    let lastLoss: { exit_ts_ms: number; pnl_net: number } | undefined
    try {
      lastLoss = db
        .prepare(
          `SELECT exit_ts_ms, pnl_net FROM trader_realized_pnl
             WHERE asset = ? AND pnl_net < 0
             ORDER BY exit_ts_ms DESC LIMIT 1`,
        )
        .get(asset) as { exit_ts_ms: number; pnl_net: number } | undefined
    } catch {
      // ponytail: table absent on a fresh DB -- no history means no cooldown.
      lastLoss = undefined
    }

    if (lastLoss) {
      const ageMs = nowMs - lastLoss.exit_ts_ms
      if (ageMs >= 0 && ageMs < cooldownDays * ONE_DAY_MS) {
        const daysAgo = (ageMs / ONE_DAY_MS).toFixed(1)
        const daysLeft = (cooldownDays - ageMs / ONE_DAY_MS).toFixed(1)
        return {
          allowed: false,
          rule: 'cooldown',
          reason:
            `${asset} closed at a loss of $${Math.abs(lastLoss.pnl_net).toFixed(2)} ` +
            `${daysAgo}d ago; symbol is benched for another ${daysLeft}d ` +
            `(${cooldownDays}d cooldown)`,
        }
      }
    }
  }

  // --- Rule 2: already holding it, and it is underwater -------------------
  const held = positions.find((p) => p.asset === asset && p.qty !== 0)
  if (held) {
    const basis = Math.abs(held.market_value) - held.unrealized_pnl
    if (basis > 0) {
      const lossPct = -held.unrealized_pnl / basis
      if (lossPct > AVERAGE_DOWN_TOLERANCE_PCT) {
        return {
          allowed: false,
          rule: 'average_down',
          reason:
            `${asset} is already held and down ${(lossPct * 100).toFixed(1)}% ` +
            `($${held.unrealized_pnl.toFixed(2)}); refusing to average down`,
        }
      }
    }
  }

  return ALLOW
}
