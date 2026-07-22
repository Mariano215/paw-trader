/** Decision lifecycle states. Ordered submit -> fill -> close, plus error branches. */
export const DECISION_STATUS = {
  SUBMITTING: 'submitting',
  SUBMITTED: 'submitted',
  PENDING_FILL: 'pending_fill',
  EXECUTED: 'executed', // == confirmed filled
  CLOSED: 'closed',
  FAILED: 'failed', // 4xx terminal
  RETRY_PENDING: 'retry_pending', // transient (network/timeout/5xx)
  ENGINE_DOWN: 'engine_down', // retry budget exhausted while engine unreachable
  COMMITTEE_ABSTAIN: 'committee_abstain',
  EXIT_SUBMITTED: 'exit_submitted', // closing order submitted by the exit-evaluator
} as const

export type DecisionStatus = (typeof DECISION_STATUS)[keyof typeof DECISION_STATUS]

/** States where the broker has (or may have) a live order we must reconcile. */
export const OPEN_AT_BROKER: DecisionStatus[] = [
  DECISION_STATUS.SUBMITTED,
  DECISION_STATUS.PENDING_FILL,
]

/** Max transient retries before a decision parks at engine_down. */
export const MAX_SUBMIT_RETRIES = 3

/**
 * Classify an engine submit error as terminal (4xx, do not retry) or
 * transient (network / timeout / 5xx, retry-eligible). The engine client
 * throws Error("Engine API error NNN on /path :: body") on non-2xx
 * (engine-client.ts:62) and a bare fetch/abort error on network/timeout.
 */
export function isTerminalSubmitError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  const m = msg.match(/Engine API error (\d{3})/)
  if (!m) return false // no status code => network/timeout/abort => transient
  const status = Number(m[1])
  if (status < 400 || status >= 500) return false

  // Not every 4xx is permanent. The engine returns 422 with a blocked_by
  // payload for guard rails, and some of those clear on their own: the
  // market opens, the reconciler goes clean. Burning the signal for those
  // throws away work that would have succeeded minutes later -- on
  // 2026-07-22 an after-hours retry sweep killed three otherwise valid
  // signals on market_closed alone.
  return !TRANSIENT_BLOCKERS.some((b) => msg.includes(b))
}

/** blocked_by reasons that resolve with time and must not kill a decision. */
const TRANSIENT_BLOCKERS = ['market_closed', 'reconcile_drift'] as const
