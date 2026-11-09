/**
 * Sizing constants shared by the decision dispatcher and the dashboard
 * manual-action path. The Telegram approval-card flow that used to live
 * here was removed once the committee took over dispatch (2026-07-02);
 * trader_approvals rows are now only written by handleTraderSignalAction.
 */

/**
 * Default trade size used as the base the committee scales by its
 * size_multiplier. Phase 3 Task 6 lifted this from $100 to $200 once the
 * autonomy ladder (Task 5) was in place to gate size on the strategy's
 * track record.
 */
export const DEFAULT_SIZE_USD = 200

/**
 * Larger size available as a discretionary override from the dashboard
 * signal-action route ("bigger").
 */
export const BIGGER_SIZE_USD = 250
