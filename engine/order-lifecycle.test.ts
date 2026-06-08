import { describe, it, expect } from 'vitest'
import { isTerminalSubmitError, OPEN_AT_BROKER, DECISION_STATUS } from './order-lifecycle.js'

describe('isTerminalSubmitError', () => {
  it('treats 4xx as terminal', () => {
    expect(isTerminalSubmitError(new Error('Engine API error 422 on /decisions/submit :: bad size'))).toBe(true)
    expect(isTerminalSubmitError(new Error('Engine API error 400 on /decisions/submit'))).toBe(true)
  })
  it('treats 5xx as transient', () => {
    expect(isTerminalSubmitError(new Error('Engine API error 503 on /decisions/submit'))).toBe(false)
  })
  it('treats network / timeout (no status code) as transient', () => {
    expect(isTerminalSubmitError(new Error('The operation was aborted due to timeout'))).toBe(false)
    expect(isTerminalSubmitError(new TypeError('fetch failed'))).toBe(false)
  })
})

describe('lifecycle constants', () => {
  it('OPEN_AT_BROKER holds submitted + pending_fill only', () => {
    expect(OPEN_AT_BROKER).toEqual([DECISION_STATUS.SUBMITTED, DECISION_STATUS.PENDING_FILL])
  })

  // M1: exit_submitted must be a named constant so exit-evaluator.ts does not
  // rely on a hard-coded string literal.
  it('M1: DECISION_STATUS.EXIT_SUBMITTED equals exit_submitted', () => {
    expect(DECISION_STATUS.EXIT_SUBMITTED).toBe('exit_submitted')
  })
})
