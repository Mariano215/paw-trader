import { describe, it, expect } from 'vitest'
import {
  renderAlert,
  parseBlockReasons,
  explainOrderRefused,
  explainServiceDown,
  explainPositionMismatch,
  explainLostOrder,
} from './plain-english.js'

/** The vocabulary an operator should never have to decode. */
const JARGON = [
  'engine', 'dispatch', 'reconcil', 'signal', 'decision', 'committee',
  '422', 'http', 'blocked_by', 'json', 'null', 'undefined', 'launchctl',
  'npx', 'tsx', 'schema', '/decisions', 'uuid',
]

function assertPlain(msg: string) {
  const lower = msg.toLowerCase()
  for (const word of JARGON) {
    expect(lower, `leaked jargon "${word}" in: ${msg}`).not.toContain(word)
  }
  // No UUIDs.
  expect(msg).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/i)
}

describe('parseBlockReasons', () => {
  it('extracts reasons from an engine error body', () => {
    expect(parseBlockReasons('Engine API error 422 on /decisions/submit :: {"detail":{"blocked_by":["market_closed"]}}'))
      .toEqual(['market_closed'])
  })
  it('handles several reasons', () => {
    expect(parseBlockReasons('{"blocked_by":["market_closed","position_sizer"]}'))
      .toEqual(['market_closed', 'position_sizer'])
  })
  it('returns nothing when there is no payload', () => {
    expect(parseBlockReasons('fetch failed')).toEqual([])
  })
})

describe('explainOrderRefused', () => {
  it('turns the closed-market alert into something a person can read', () => {
    // This is verbatim the message that confused the operator on 2026-07-22.
    const raw = 'Engine API error 422 on /decisions/submit :: {"detail":{"blocked_by":["market_closed"]}}'
    const msg = renderAlert(explainOrderRefused('AAPL', 'buy', raw, false))
    assertPlain(msg)
    expect(msg).toContain('AAPL')
    expect(msg.toLowerCase()).toContain('market is closed')
    expect(msg).toContain('Nothing for you to do.')
  })

  it('says it will try again when the failure is transient', () => {
    const raw = '{"blocked_by":["market_closed"]}'
    const msg = renderAlert(explainOrderRefused('AAPL', 'buy', raw, true))
    expect(msg.toLowerCase()).toContain('try again')
  })

  it('escalates to the worst reason when several are given', () => {
    const a = explainOrderRefused('SPY', 'buy', '{"blocked_by":["market_closed","max_drawdown"]}', false)
    expect(a.level).toBe('urgent')
    expect(a.action).toBeDefined()
  })

  it('admits when it does not recognise the reason instead of pasting the error', () => {
    const msg = renderAlert(explainOrderRefused('QQQ', 'buy', 'Engine API error 418 :: teapot', false))
    assertPlain(msg)
  })

  it('says sell, not buy, for an exit', () => {
    expect(renderAlert(explainOrderRefused('EEM', 'sell', '{"blocked_by":["no_position"]}', false)))
      .toContain('did not sell EEM')
  })
})

describe('other alerts stay plain', () => {
  it('service down, restart issued', () => {
    const msg = renderAlert(explainServiceDown(25, true))
    assertPlain(msg)
    expect(msg).toContain('Nothing for you to do.')
  })

  it('service down for over an hour is urgent and asks for help', () => {
    const a = explainServiceDown(75, false)
    expect(a.level).toBe('urgent')
    assertPlain(renderAlert(a))
  })

  it('position mismatch, healed and unhealed', () => {
    assertPlain(renderAlert(explainPositionMismatch(['SPY'], true)))
    const bad = explainPositionMismatch(['SPY'], false)
    expect(bad.level).toBe('urgent')
    assertPlain(renderAlert(bad))
  })

  it('lost order', () => {
    assertPlain(renderAlert(explainLostOrder('IWM', 'buy', 6)))
  })

  it('urgent messages are visibly urgent', () => {
    expect(renderAlert(explainPositionMismatch(['SPY'], false))).toContain('needs you')
  })
})
