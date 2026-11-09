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
  it('labels the paused predeclared Bitcoin family as research, not invalidated', () => {
    const state = load('_traderEvidenceLaneState', {})('crypto', [{
      id: 'order-flow-imbalance-crypto', status: 'paused',
    }], [{id: 'bitcoin-4h-v5', status: 'invalidated'}]) as {label: string; cohort: {id: string}}
    expect(state.label).toBe('RESEARCH PAUSED')
    expect(state.cohort.id).toBe('bitcoin-4h-v5')
  })

  it('renders fail-closed Bitcoin forward-research progress', () => {
    const facts = load('_traderBitcoinResearchProgressFacts', {Date})({
      declaration_at: Date.UTC(2026, 8, 9),
      eligible_bars_total: 7,
      ineligible_bars_total: 2,
      collection_days_completed: 1,
      minimum_forward_days: 180,
      earliest_evaluation_at: Date.UTC(2027, 2, 8),
      collection_mature: false,
    }) as string[]
    expect(facts).toEqual([
      '7 / 9 eligible decision bars',
      '1 / 180 forward days collected',
      expect.stringContaining('Final evaluation no earlier than'),
    ])
  })

  it.each([
    ['passed', 'Frozen research evaluation passed · production review only'],
    ['rejected_pre_holdout', 'Research rejected before holdout · no qualifying frozen variant'],
    ['rejected', 'One-time holdout rejected the research family'],
    ['error', 'Evaluation blocked by an integrity or execution-lock check'],
  ])('renders the terminal frozen evaluation state %s', (evaluationStatus, expected) => {
    const facts = load('_traderBitcoinResearchProgressFacts', {Date})({
      declaration_at: Date.UTC(2026, 8, 9), eligible_bars_total: 100,
      ineligible_bars_total: 2, collection_days_completed: 180,
      minimum_forward_days: 180, collection_mature: true,
      evaluation_status: evaluationStatus, evaluation_trade_count: 123,
    }) as string[]
    expect(facts).toContain(expected)
    expect(facts).toContain('123 one-time holdout trades')
  })

  it('merges each operational event UUID into the visible tape once', () => {
    const state = {
      operationalSeen: {}, operationalEvents: [], operationalAnimated: {},
      operationalPulseIds: {}, operationalStagePulses: {},
    }
    const merge = load('_mergeTraderOperationalEvents', {
      TRADER_STATE: state,
      _traderAgeMs: () => 0,
      setTimeout: vi.fn(),
      renderTraderMissionControl: vi.fn(),
    })
    const event = {event_id: 'event-1', seq: 1, stage: 'scheduler', source_ts: Date.now()}
    merge([event, event], true)
    merge([event], true)
    expect(state.operationalEvents).toEqual([event])
  })

  it.each([
    ['BTC/USD', true], ['BTCUSD', true], ['ETH/USDC', true], ['AAPL', false], ['BITO', false],
  ])('classifies %s for the stock/crypto lanes', (asset, expected) => {
    expect(load('_traderIsCrypto', {})(asset)).toBe(expected)
  })

  it('loads open orders independently from recent terminal history', async () => {
    const state: Record<string, unknown> = {orders: [], strategies: []}
    const fetchFromAPI = vi.fn()
      .mockResolvedValueOnce([{client_order_id: 'open', status: 'accepted'}])
      .mockResolvedValueOnce([{client_order_id: 'closed', status: 'filled'}])
      .mockResolvedValueOnce({strategies: [{id: 'momentum-crypto', status: 'paused'}]})
    const render = vi.fn()
    await load('refreshTraderMissionControl', {TRADER_STATE: state, fetchFromAPI, renderTraderMissionControl: render, Date})()
    expect(fetchFromAPI).toHaveBeenNthCalledWith(1, '/api/v1/trader/orders?status=open&limit=500&offset=0')
    expect(fetchFromAPI).toHaveBeenNthCalledWith(2, '/api/v1/trader/orders?status=closed&limit=20&offset=0')
    expect(state.orders).toEqual([
      {client_order_id: 'open', status: 'accepted'},
      {client_order_id: 'closed', status: 'filled'},
    ])
    expect(state.ordersAvailable).toBe(true)
    expect(state.strategies).toEqual([{id: 'momentum-crypto', status: 'paused'}])
    expect(render).toHaveBeenCalledOnce()
  })

  it('requires two deliberate clicks before canceling an order', () => {
    const executeTraderOrderCancel = vi.fn()
    const render = vi.fn()
    const context = {
      _armedCancelOrderId: null,
      _armedCancelTimer: null,
      executeTraderOrderCancel,
      _renderMissionOrders: render,
      setTimeout: vi.fn(() => 1),
      clearTimeout: vi.fn(),
    }
    const arm = load('armTraderOrderCancel', context)
    arm('order-1')
    expect(executeTraderOrderCancel).not.toHaveBeenCalled()
    expect(render).toHaveBeenCalledOnce()
    arm('order-1')
    expect(executeTraderOrderCancel).toHaveBeenCalledWith('order-1')
  })

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
    await load('refreshTraderGateProgress', {document, Date, TRADER_STATE: {}, renderTraderMissionControl: vi.fn(), fetchFromAPI: vi.fn().mockResolvedValue({
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
      document: {getElementById: () => null}, _renderCol1: vi.fn(), renderTraderMissionControl: vi.fn(),
    })()
    expect(state.positions).toEqual([{asset: 'SPY', qty: 1}])
    expect(state.positionsUpdatedAt).toBe(100)
    expect(state.positionsStale).toBe(true)
  })

  it('renders unavailable accounting as unknown rather than stale unlabelled profit', async () => {
    const render = vi.fn()
    await load('refreshTraderKPI_brokerPnl', {
      TRADER_STATE: {}, renderTraderMissionControl: vi.fn(),
      fetchFromAPI: vi.fn().mockResolvedValue({available: false}), _renderKpiCell: render,
    })()
    expect(render).toHaveBeenCalledWith('kpi-realized', 'CORRECTED NET P&L', '--', 'Accounting unavailable', null, null, null)
  })
})
