import { EngineClient } from '../engine-client.js'
import type { BacktestGateReport, BacktestResult, Candidate, DecisionRequest, DecisionStatus, EngineOrder, EnginePosition, HealthResponse,
  MarkovRegimePayload, NavPeriod, NavSnapshot, PricePoint, ReconcileResult, RiskState, SubmitDecisionResult } from '../types.js'

export interface OhlcBar { date: string; open: number; high: number; low: number; close: number }
export interface FakeEngineOpts { bars: Record<string, OhlcBar[]>; signals: Candidate[]; startingCash: number; now: () => number }

const nyDate = (ms: number) => new Date(ms).toLocaleDateString('en-CA', { timeZone: 'America/New_York' })
const nyMinutes = (ms: number) => {
  const p = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(ms)
  return Number(p.find(x => x.type === 'hour')!.value) * 60 + Number(p.find(x => x.type === 'minute')!.value)
}
const AFTER_CLOSE = 16 * 60

interface Order { req: DecisionRequest; order: EngineOrder; submitDay: string }

export class FakeEngine {
  faults = { submitThrows: 0, submit4xx: 0, unreachableUntil: 0 }
  fills: Array<{ decision_id: string; asset: string; side: 'buy' | 'sell'; qty: number; price: number; date: string }> = []
  private cash: number
  private positions = new Map<string, { qty: number; cost: number }>()
  private orders = new Map<string, Order>()
  private navLog: NavSnapshot[] = []

  constructor(private opts: FakeEngineOpts) {
    this.cash = opts.startingCash
    // Throw only for real EngineClient methods we lack; probes like `then` or `toJSON` read as undefined.
    return new Proxy(this, {
      get: (t, k, r) => {
        if (typeof k === 'string' && !(k in t) && k in EngineClient.prototype) throw new Error(`fake-engine: ${k} not supported`)
        return Reflect.get(t, k, r)
      },
    })
  }

  private today() { return nyDate(this.opts.now()) }
  private visibleBars(asset: string): OhlcBar[] {
    const bars = this.opts.bars[asset]
    if (!bars) throw new Error(`fake-engine: no bars for ${asset}`)
    const today = this.today()
    const afterClose = nyMinutes(this.opts.now()) >= AFTER_CLOSE
    return bars.filter(b => b.date < today || (afterClose && b.date === today))
  }
  /** The bar a trade on `day` fills against: the first bar dated on or after it, but not after today. */
  private fillBar(asset: string, day: string): OhlcBar | null {
    const b = (this.opts.bars[asset] ?? []).find(x => x.date >= day)
    if (!b || b.date > this.today()) return null
    return b
  }
  private mark(asset: string): number {
    const today = this.today()
    const bars = this.opts.bars[asset]
    if (!bars) throw new Error(`fake-engine: no bars for ${asset}`)
    const t = bars.find(b => b.date === today)
    if (t) {
      // Intraday walk: low before high on every bar, matching the backtest (stop checked before target, longs only).
      const m = nyMinutes(this.opts.now())
      if (m < 570) { const prev = bars.filter(b => b.date < today).at(-1); return prev ? prev.close : t.open }
      if (m < 660) return t.open
      if (m < 780) return t.low
      if (m < AFTER_CLOSE - 60) return t.high
      return t.close
    }
    const prev = bars.filter(b => b.date < today).at(-1)
    return prev ? prev.close : 0
  }
  private assertUp() {
    if (this.opts.now() < this.faults.unreachableUntil) throw new Error('fake-engine: unreachable')
  }

  settle(): void {
    for (const o of this.orders.values()) {
      if (o.order.status !== 'accepted') continue
      const bar = this.fillBar(o.req.asset, o.submitDay)
      if (!bar) continue
      let price = bar.open
      if (o.req.entry_type === 'limit' && o.req.entry_price > 0) {
        const touched = o.req.side === 'buy' ? bar.low <= o.req.entry_price : bar.high >= o.req.entry_price
        if (!touched) {
          if (nyMinutes(this.opts.now()) >= AFTER_CLOSE || bar.date < this.today()) Object.assign(o.order, { status: 'expired', updated_at: this.opts.now() })
          continue
        }
        price = o.req.side === 'buy' ? Math.min(bar.open, o.req.entry_price) : Math.max(bar.open, o.req.entry_price)
      }
      const pos = this.positions.get(o.req.asset) ?? { qty: 0, cost: 0 }
      const qty = o.req.size_usd <= 0 ? Math.abs(pos.qty) : Math.floor(o.req.size_usd / price)
      // Shorts are not modeled: an exit bigger than the position is a bot bug, so fail loudly.
      if (o.req.side === 'sell' && qty > pos.qty) {
        Object.assign(o.order, { status: 'rejected', updated_at: this.opts.now() })
        throw new Error(`fake-engine: oversize sell ${o.req.asset} qty ${qty} > held ${pos.qty}`)
      }
      if (qty <= 0) { Object.assign(o.order, { status: 'canceled', updated_at: this.opts.now() }); continue }
      const signed = o.req.side === 'buy' ? qty : -qty
      pos.cost += signed * price
      pos.qty += signed
      this.cash -= signed * price
      if (Math.abs(pos.qty) < 1e-9) this.positions.delete(o.req.asset); else this.positions.set(o.req.asset, pos)
      Object.assign(o.order, { status: 'filled', qty, filled_qty: qty, filled_avg_price: price, updated_at: this.opts.now() })
      this.fills.push({ decision_id: o.req.decision_id, asset: o.req.asset, side: o.req.side, qty, price, date: bar.date })
    }
  }

  nav(): number {
    let v = this.cash
    for (const [a, p] of this.positions) v += p.qty * this.mark(a)
    return v
  }
  recordNav(period: NavPeriod): void {
    this.navLog.push({ date: this.today(), period, nav: this.nav(), recorded_at: this.opts.now() })
  }

  async getHealth(): Promise<HealthResponse | null> {
    if (!(await this.pingHealth())) return null
    return { status: 'ok', version: 'fake', alpaca_connected: true, alpaca_mode: 'paper', reconciler_halted: false, halt_reason: null }
  }
  async pingHealth(): Promise<boolean> { return this.opts.now() >= this.faults.unreachableUntil }
  async getRiskState(): Promise<RiskState> { this.assertUp(); return { tripped: [], details: [] } }
  async getSignals(minutes = 30): Promise<Candidate[]> {
    this.assertUp()
    const now = this.opts.now()
    return this.opts.signals.filter(s => s.generated_at <= now && s.generated_at > now - minutes * 60_000)
  }
  async submitDecision(req: DecisionRequest): Promise<SubmitDecisionResult> {
    this.assertUp()
    if (req.side === 'buy' && req.size_usd <= 0) throw new Error(`fake-engine: buy ${req.asset} needs size_usd > 0`)
    const existing = this.orders.get(req.decision_id)
    if (existing) return { client_order_id: existing.order.client_order_id, broker_order_id: existing.order.broker_order_id, status: existing.order.status, approved_size_usd: req.size_usd }
    if (this.faults.submitThrows > 0) { this.faults.submitThrows--; throw new Error('fake-engine: transient submit failure') }
    if (this.faults.submit4xx > 0) { this.faults.submit4xx--; throw new Error('Engine API error 422 on /decisions :: fake rejection') }
    if (req.side === 'buy') {
      // Engine decisions.py:186: entry_price 0 resolves to the live quote, and stop/target must bracket it.
      const px = req.entry_price > 0 ? req.entry_price : this.mark(req.asset)
      if ((req.stop_loss != null && !(req.stop_loss > 0 && req.stop_loss < px)) || (req.take_profit != null && req.take_profit <= px)) {
        throw new Error('Engine API error 422 on /decisions :: invalid_protection_prices')
      }
    }
    const now = this.opts.now()
    const order: EngineOrder = {
      client_order_id: 'coid-' + req.decision_id, broker_order_id: 'bo-' + req.decision_id, decision_id: req.decision_id,
      asset: req.asset, side: req.side, qty: 0, order_type: req.entry_type, limit_price: req.entry_type === 'limit' ? req.entry_price : null,
      status: 'accepted', filled_qty: 0, filled_avg_price: null, source: 'fake', created_at: now, updated_at: now,
    }
    this.orders.set(req.decision_id, { req, order, submitDay: this.today() })
    this.settle()
    return { client_order_id: order.client_order_id, broker_order_id: order.broker_order_id, status: order.status, approved_size_usd: req.size_usd }
  }
  async getDecisionStatus(clientOrderId: string): Promise<DecisionStatus> {
    this.assertUp()
    const o = [...this.orders.values()].find(x => x.order.client_order_id === clientOrderId)
    if (!o) throw new Error('Engine API error 404 on /decisions :: not found')
    return { client_order_id: o.order.client_order_id, broker_order_id: o.order.broker_order_id, status: o.order.status, filled_qty: o.order.filled_qty, filled_avg_price: o.order.filled_avg_price }
  }
  async getOrders(): Promise<EngineOrder[]> { this.assertUp(); return [...this.orders.values()].map(o => o.order) }
  async getAllOrders(): Promise<EngineOrder[]> { return this.getOrders() }
  async getPositions(): Promise<EnginePosition[]> {
    this.assertUp()
    return [...this.positions].map(([asset, p]) => {
      const m = this.mark(asset)
      return { asset, qty: p.qty, avg_entry_price: p.cost / p.qty, market_value: p.qty * m, unrealized_pnl: p.qty * m - p.cost, source: 'fake', updated_at: this.opts.now() }
    })
  }
  async getPrices(asset: string, fromMs: number, toMs: number): Promise<PricePoint[]> {
    this.assertUp()
    return this.visibleBars(asset)
      .map(b => ({ date: b.date, close: b.close, high: b.high, low: b.low, ts_ms: Date.parse(b.date + 'T20:00:00Z') }))
      .filter(p => p.ts_ms >= fromMs && p.ts_ms <= toMs)
  }
  /** Like the real client: the day_open snapshot NAV, null when there is none or the engine is down. */
  async getNav(): Promise<number | null> {
    if (!(await this.pingHealth())) return null
    return (await this.getNavLatest('day_open'))?.nav ?? null
  }
  async getNavLatest(period: NavPeriod = 'day_open'): Promise<NavSnapshot | null> {
    return [...this.navLog].reverse().find(s => s.period === period) ?? null
  }
  /** The fake's book is the broker's book, so a reconcile never finds drift. */
  async getReconcileLast(): Promise<ReconcileResult> {
    this.assertUp()
    return { id: 'fake-reconcile', ran_at: this.opts.now(), drift_detected: false, drift_summary: null, action_taken: 'none' }
  }
  /** No regime model in replay: null is the real client's "regime unavailable" answer, which enrichment handles. */
  async getMarkovRegime(_asset: string): Promise<MarkovRegimePayload | null> { return null }
  /** Replay has no backtest. Empty evidence (no strategies, null Sharpe) keeps the go-live gate blocked, as with a real engine lacking one. */
  async getBacktestReport(): Promise<BacktestGateReport> {
    this.assertUp()
    return { version: 0, computed_at_ms: this.opts.now(), engine_revision: 'fake', days: 0, universe: [], strategies: {} }
  }
  async getMomentumBacktest(): Promise<BacktestResult> {
    this.assertUp()
    const now = this.opts.now()
    return { strategy: 'momentum', method: 'none', start: '', end: '', n_trades: 0, sharpe: null, max_drawdown: null, win_rate: null,
      expectancy: null, total_return: 0, slippage_bps: 0, min_score: 0, sharpe_convention: 'none', assets: [],
      warnings: ['fake-engine: replay has no backtest'], computed_at_ms: now, elapsed_ms: 0 }
  }
  async getNavSnapshots(limit = 30): Promise<NavSnapshot[]> { return this.navLog.slice(-limit) }
}
