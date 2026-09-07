import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

const source = readFileSync(new URL('../../server/public/app.js', import.meta.url), 'utf8')
const ast = ts.createSourceFile('app.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
function load(name: string, context: Record<string, unknown>): (...args: unknown[]) => unknown {
  const fn = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name)
  if (!fn) throw new Error(`Missing dashboard function ${name}`)
  return runInNewContext(`(${fn.getText(ast)})`, context)
}

describe('PawTrader degraded dashboard states', () => {
  it.each([true, false])('ticker distinguishes unknown holdings from a confirmed empty account: %s', stale => {
    const nodes: Array<{textContent: string; className: string; appendChild: ReturnType<typeof vi.fn>}> = []
    const document = {createElement: () => {
      const node = {textContent: '', className: '', appendChild: vi.fn()}
      nodes.push(node)
      return node
    }}
    load('_buildTickerItems', {document, TRADER_STATE: {positions: [], positionsStale: stale, positionsUpdatedAt: 100}})({appendChild: vi.fn()})
    const text = nodes.map(n => n.textContent).join(' ')
    expect(text).toContain(stale ? 'Holdings unknown' : 'No open positions')
    if (stale) expect(text).not.toContain('No open positions')
  })
  it.each([true, false])('shows monitoring confirmation only when fresh: %s', async fresh => {
    const nodes: Array<{textContent: string; style: {cssText: string}; appendChild: ReturnType<typeof vi.fn>}> = []
    const document = {
      getElementById: () => ({appendChild: vi.fn()}),
      createElement: () => {
        const node = {textContent: '', style: {cssText: ''}, appendChild: vi.fn()}
        nodes.push(node)
        return node
      },
    }
    await load('refreshTraderGateProgress', {document, Date, fetchFromAPI: vi.fn().mockResolvedValue({
      available: false, progress: {checked_at: Date.now() - (fresh ? 0 : 3600000)},
    })})()
    expect(nodes.map(n => n.textContent).join(' ')).toContain(fresh ? 'Daily update: 5 p.m. Eastern' : 'not yet confirmed or stale')
  })
  it('coalesces overlapping card refreshes and releases the lock afterward', async () => {
    let finish!: () => void
    const fn = vi.fn(() => new Promise<void>(resolve => {finish = resolve}))
    const refresh = load('runTraderRefresh', {_traderRefreshPending: new Set()})
    const first = refresh(fn)
    await refresh(fn)
    expect(fn).toHaveBeenCalledTimes(1)
    finish()
    await first
    const second = refresh(fn)
    expect(fn).toHaveBeenCalledTimes(2)
    finish()
    await second
  })
  it.each([null, {engine_connected: false, alpaca_mode: 'paper'}, {engine_connected: true}])('never calls unknown/offline state paper', state => {
    const render = vi.fn()
    load('_renderKpiEngineCell', {_renderKpiCell: render, _renderTraderHaltBanner: vi.fn()})(state)
    expect(render.mock.calls[0][2]).toContain('unknown / offline')
    expect(render.mock.calls[0][2]).not.toContain('○ Paper')
  })

  it('preserves last known holdings and marks them stale after a failed read', async () => {
    const state = {positions: [{asset: 'SPY', qty: 1}], positionsUpdatedAt: 100, positionsStale: false, verdictCursor: {loaded: true}}
    await load('refreshTraderCol1', {
      TRADER_STATE: state, fetchFromAPI: vi.fn().mockRejectedValue(new Error('offline')),
      document: {getElementById: () => null}, _renderCol1: vi.fn(), _renderTraderTicker: vi.fn(),
    })()
    expect(state.positions).toEqual([{asset: 'SPY', qty: 1}])
    expect(state.positionsUpdatedAt).toBe(100)
    expect(state.positionsStale).toBe(true)
  })

  it('renders unavailable accounting as unknown rather than stale unlabelled profit', async () => {
    const render = vi.fn()
    await load('refreshTraderKPI_brokerPnl', {
      fetchFromAPI: vi.fn().mockResolvedValue({available: false}), _renderKpiCell: render,
    })()
    expect(render).toHaveBeenCalledWith('kpi-realized', 'REALIZED P&L', '--', 'Accounting unavailable', null, null, null)
  })
})
