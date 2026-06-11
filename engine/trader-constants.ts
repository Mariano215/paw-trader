/**
 * Shared numeric constants for the trader subsystem.
 *
 * Lives here (not in decision-dispatcher.ts) so modules in
 * src/trader/strategy/ can import them without creating a circular
 * dependency (decision-dispatcher imports strategy/gate-decision,
 * so strategy/* must not import decision-dispatcher).
 */

/** Absolute notional ceiling per order. No single trade can exceed this
 *  regardless of NAV or strategy config.
 *
 *  History: $1000 through Phase 5. Lifted to $2500 on 2026-06-11 (operator
 *  decision) so the risk model owns sizing for the paper evaluation: 1%
 *  equity risk / 8% stop suggests ~$12.5k on a $100k NAV, the NAV*2%
 *  fallback cap clamps to ~$2k, and this ceiling is the absolute backstop.
 *  MUST move in lockstep with the engine's per-trade cap (trader-engine
 *  src/trader_engine/risk/position_sizer.py DEFAULT_SIZE_USD) -- the engine
 *  silently clips anything above its own cap. */
export const HARD_CEILING_USD = 2500
