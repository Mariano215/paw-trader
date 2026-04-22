/** Engine REST API types - mirrors Python Pydantic models. */

export interface HealthResponse {
  status: string;
  version: string;
  alpaca_connected: boolean;
  alpaca_mode: "paper" | "live" | string;
  reconciler_halted?: boolean;
  halt_reason?: string | null;
  // Phase 5 Task 2c -- crypto-arm visibility.  Optional because older engine
  // builds predate the field; callers null-coalesce when surfacing on the
  // dashboard and the monitor treats missing as healthy.
  coinbase_connected?: boolean;
}

export interface EnginePosition {
  asset: string;
  qty: number;
  avg_entry_price: number;
  market_value: number;
  unrealized_pnl: number;
  source: string;
  updated_at: number;  // ms
}

export interface EngineOrder {
  client_order_id: string;
  broker_order_id: string | null;
  asset: string;
  side: "buy" | "sell";
  qty: number;
  order_type: "limit" | "market";
  limit_price: number | null;
  status: string;
  filled_qty: number;
  filled_avg_price: number | null;
  source: string;
  created_at: number;  // ms
  updated_at: number;  // ms
}

export interface ReconcileResult {
  id: string;
  ran_at: number;  // ms
  drift_detected: boolean;
  drift_summary: string | null;
  action_taken: string;
}

export interface Candidate {
  id: string;
  strategy: string;
  asset: string;
  side: "buy" | "sell";
  raw_score: number;
  horizon_days: number;
  generated_at: number;  // ms
}

export interface DecisionRequest {
  decision_id: string;
  asset: string;
  side: "buy" | "sell";
  size_usd: number;
  entry_type: string;
  entry_price: number;
  stop_loss?: number;
  take_profit?: number;
  strategy: string;
  confidence: number;
}

export interface DecisionStatus {
  client_order_id: string;
  broker_order_id: string | null;
  status: string;
  filled_qty: number;
  filled_avg_price: number | null;
}

export interface SubmitDecisionResult {
  client_order_id: string;
  broker_order_id: string;
  status: string;
  approved_size_usd: number;
}

export interface RiskState {
  tripped: string[];
  details: Array<{ rule: string; tripped_at: number; reason: string }>;
}

export type NavPeriod = "day_open" | "day_close" | "week_open";

export interface NavSnapshot {
  date: string;            // 'YYYY-MM-DD' in America/New_York
  period: NavPeriod;
  nav: number;
  recorded_at: number;     // ms
}

/**
 * One daily close bar for an asset. Matches the engine's
 * GET /prices/{asset}?from_ms=&to_ms= response shape
 * (src/trader_engine/api/routes/prices.py):
 *   [{"date": "YYYY-MM-DD", "close": float, "ts_ms": int}, ...]
 */
export interface PricePoint {
  date: string;            // 'YYYY-MM-DD'
  close: number;
  ts_ms: number;           // ms
}

// ---------------------------------------------------------------------------
// Signal telemetry -- Phase 8C Analyst Paw
// ---------------------------------------------------------------------------

export interface RegimeBucket {
  ticks: number;
  pct: number;
}

export interface RegimeStrategyStats {
  scored: number;
  fired: number;
  suppressed: number;
}

export interface StrategyTelemetryStat {
  strategy: string;
  total_scored: number;
  fired: number;
  suppressed: number;
  suppression_rate: number;   // 0-1
  fire_rate: number;          // 0-1
  by_regime: Record<string, RegimeStrategyStats>;
}

export interface NearMiss {
  asset: string;
  strategy: string;
  consecutive_near_miss_ticks: number;
  avg_score: number;
  effective_threshold: number;
  avg_gap: number;           // effective_threshold - avg_score
  regime: string | null;
  last_seen_ms: number;
}

export interface SignalTelemetrySummary {
  window_days: number;
  since_ms: number;
  generated_at_ms: number;
  total_ticks: number;
  equity_ticks: number;
  regime_distribution: Record<string, RegimeBucket>;
  strategy_stats: StrategyTelemetryStat[];
  near_misses: NearMiss[];
}
