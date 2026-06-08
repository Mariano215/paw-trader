/**
 * Shared numeric constants for the trader subsystem.
 *
 * Lives here (not in decision-dispatcher.ts) so modules in
 * src/trader/strategy/ can import them without creating a circular
 * dependency (decision-dispatcher imports strategy/gate-decision,
 * so strategy/* must not import decision-dispatcher).
 */

/** Absolute notional ceiling per order. No single trade can exceed this
 *  regardless of NAV or strategy config. Matches the Phase 5 hard cap. */
export const HARD_CEILING_USD = 1000
