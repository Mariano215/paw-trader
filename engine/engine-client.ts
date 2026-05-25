import type {
  HealthResponse,
  EnginePosition,
  AdoptPositionResult,
  EngineOrder,
  ReconcileResult,
  Candidate,
  DecisionRequest,
  DecisionStatus,
  SubmitDecisionResult,
  RiskState,
  NavSnapshot,
  NavPeriod,
  PricePoint,
  SignalTelemetrySummary,
  MarkovRegimePayload,
} from "./types.js";
import { getCredential } from "../credentials.js";
import { logger } from "../logger.js";

export interface EngineClientOptions {
  baseUrl: string;
  token: string;
  timeoutMs?: number;
}

export class EngineClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly timeoutMs: number;

  constructor(opts: EngineClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, "");
    this.token = opts.token;
    this.timeoutMs = opts.timeoutMs ?? 10_000;
  }

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const url = this.baseUrl + path;
    const resp = await fetch(url, {
      ...init,
      headers: {
        "X-Engine-Token": this.token,
        "Content-Type": "application/json",
        ...(init?.headers ?? {}),
      },
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!resp.ok) {
      // Capture response body so 4xx validation errors and 5xx engine errors
      // surface their actual cause in logs. Without this every failure shows
      // up as a bare status code; tracking down a 422 takes a manual curl.
      let body = "";
      try {
        body = await resp.text();
      } catch {
        body = "<unable to read response body>";
      }
      const trimmed = body.length > 800 ? body.slice(0, 800) + "...(truncated)" : body;
      throw new Error(
        "Engine API error " + resp.status + " on " + path + " :: " + trimmed,
      );
    }
    return resp.json() as Promise<T>;
  }

  /**
   * Shared null-on-404-or-network-error fetch helper.  Returns the parsed
   * JSON body on 2xx, null on 404, null on network error / fetch timeout,
   * and throws "Engine API error NNN" on any other non-2xx so real engine
   * outages still surface.  Used by getHealth, getNav and getNavSnapshots
   * (Phase 6 Task 4).  Callers that need an empty-array fallback coerce
   * null to [] at the call site; keeping a single helper means only one
   * error path to reason about.
   */
  private async requestNullable<T>(path: string, init?: RequestInit): Promise<T | null> {
    const url = this.baseUrl + path;
    let resp: Response;
    try {
      resp = await fetch(url, {
        ...init,
        headers: {
          "X-Engine-Token": this.token,
          "Content-Type": "application/json",
          ...(init?.headers ?? {}),
        },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      return null;
    }
    if (resp.status === 404) return null;
    if (!resp.ok) {
      throw new Error("Engine API error " + resp.status + " on " + path);
    }
    return (await resp.json()) as T | null;
  }

  /**
   * Phase 5 Task 2c -- returns the full health body (including
   * coinbase_connected) or null when the engine route 404s / the fetch
   * times out.  Mirrors the getNav pattern: null when the endpoint is
   * genuinely absent (older engine), throws on other non-2xx so real
   * engine issues still bubble up.  The monitor's Coinbase check treats
   * null and thrown errors as "engine issue, not a Coinbase-specific
   * outage" per the Phase 5 handoff.
   *
   * Phase 5 Task 2 Dispatch C -- return type tightened to
   * Promise<HealthResponse | null>.  HealthResponse keeps coinbase_connected
   * optional so an older engine (which omits the field) still type-checks.
   *
   * Phase 6 Task 4 -- fetch plumbing delegated to requestNullable<T>.
   * The body normalization (tri-state coinbase_connected) stays inline.
   */
  async getHealth(): Promise<HealthResponse | null> {
    const body = await this.requestNullable<Partial<HealthResponse>>("/health");
    if (body == null) return null;
    // Preserve the tri-state on coinbase_connected: true/false if the
    // engine reports it, undefined if the engine is pre-2c and doesn't
    // expose the field.  Collapsing undefined to false here would make
    // `evaluateAndRecordCoinbaseHealth` fire a false outage alert the
    // first time this bot talks to an older engine build.
    return {
      status: String(body.status ?? ""),
      version: String(body.version ?? ""),
      alpaca_connected: body.alpaca_connected === true,
      alpaca_mode: String(body.alpaca_mode ?? "unknown"),
      reconciler_halted: body.reconciler_halted === true,
      halt_reason: body.halt_reason ?? null,
      coinbase_connected: typeof body.coinbase_connected === "boolean"
        ? body.coinbase_connected
        : undefined,
    };
  }

  async getPositions(): Promise<EnginePosition[]> {
    return this.request<EnginePosition[]>("/positions");
  }

  /**
   * POST /positions/{asset}/adopt-from-broker
   * Pulls the broker-side position for `asset` into the local engine DB and
   * writes a clean reconcile log row.  Use to clear a reconciler halt caused
   * by "broker shows qty=X but local has no record".
   */
  async adoptBrokerPosition(asset: string): Promise<AdoptPositionResult> {
    return this.request<AdoptPositionResult>(
      `/positions/${encodeURIComponent(asset)}/adopt-from-broker`,
      { method: "POST" },
    );
  }

  async getOrders(): Promise<EngineOrder[]> {
    return this.request<EngineOrder[]>("/orders");
  }

  async getReconcileLast(): Promise<ReconcileResult> {
    return this.request<ReconcileResult>("/reconcile/last");
  }

  /** @deprecated Use haltEngine() which returns status. Kept for Phase 0 compatibility. */
  async haltTrading(reason: string): Promise<void> {
    await this.haltEngine(reason);
  }

  async getSignals(minutes = 30): Promise<Candidate[]> {
    return this.request<Candidate[]>(`/signals/recent?minutes=${minutes}`);
  }

  async submitDecision(decision: DecisionRequest): Promise<SubmitDecisionResult> {
    return this.request<SubmitDecisionResult>("/decisions/submit", {
      method: "POST",
      body: JSON.stringify(decision),
    });
  }

  async getDecisionStatus(clientOrderId: string): Promise<DecisionStatus> {
    return this.request<DecisionStatus>(`/decisions/${clientOrderId}/status`);
  }

  async getRiskState(): Promise<RiskState> {
    return this.request<RiskState>("/risk/state");
  }

  /**
   * POST /risk/halt with the supplied reason.  Throws on any non-2xx so a
   * halt failure is loud (no retries -- if the engine is unreachable when
   * the NAV-drop monitor wants to halt, the operator hears about it).
   *
   * Phase 5 Task 2 Dispatch C -- the NAV-drop monitor uses this directly.
   * The legacy haltTrading() shim (kept for Phase 0 compatibility) still
   * delegates here, so older callers keep working.
   */
  async haltEngine(reason: string): Promise<{ status: string }> {
    return this.request<{ status: string }>("/risk/halt", {
      method: "POST",
      body: JSON.stringify({ reason }),
    });
  }

  async clearCircuitBreaker(rule: string): Promise<{ status: string }> {
    return this.request<{ status: string }>("/risk/clear", {
      method: "POST",
      body: JSON.stringify({ rule }),
    });
  }

  /**
   * GET /nav/snapshots?limit=N.  Returns the snapshot array on 2xx, an
   * empty array on 404 (older engine builds without the route), and an
   * empty array on a network error / fetch timeout.  Any other non-2xx
   * still throws "Engine API error NNN" so a real engine outage is loud.
   *
   * The empty-array-on-failure semantic is intentionally different from
   * getHealth / getNav (which return null).  Callers iterate the result
   * directly; an empty list is more useful than a null guard.  See
   * Phase 5 Task 2 Dispatch C handoff for the rationale.
   *
   * Phase 6 Task 4 -- fetch plumbing delegated to requestNullable<T>.
   * The null -> [] coercion stays here so callers keep the iterable shape.
   */
  async getNavSnapshots(limit = 30): Promise<NavSnapshot[]> {
    const body = await this.requestNullable<NavSnapshot[]>(`/nav/snapshots?limit=${limit}`);
    return Array.isArray(body) ? body : [];
  }

  async getNavLatest(period: NavPeriod = "day_open"): Promise<NavSnapshot | null> {
    return this.request<NavSnapshot | null>(`/nav/latest?period=${period}`);
  }

  /**
   * Phase 5 Task 1 -- return the bare NAV number from the day_open
   * snapshot for dispatcher cap computation. Returns null when the
   * engine has no snapshot yet (first boot) or when the route 404s
   * (older engine builds that predate /nav). Callers treat null as
   * "fall back to DEFAULT_SIZE_USD" so a missing NAV never blocks
   * trading entirely.
   *
   * Phase 6 Task 4 -- fetch plumbing delegated to requestNullable<T>.
   * This tightens the contract to also return null on network error
   * (previously threw).  The dispatcher already catches getNav throws
   * and falls back to DEFAULT_SIZE_USD (see Phase 5 Task 1 handoff),
   * so callers are unaffected.
   */
  async getNav(): Promise<number | null> {
    const body = await this.requestNullable<{ nav?: number }>("/nav/latest?period=day_open");
    if (body == null) return null;
    return typeof body.nav === "number" ? body.nav : null;
  }

  /**
   * Fetch daily closes for `asset` in [fromMs, toMs]. Returns an empty
   * array when the engine has no bars in the window (the engine returns
   * a 404 in that case, which we convert to [] so callers can treat
   * "no data" the same way regardless of cause).
   *
   * Other non-2xx responses still throw the standard
   * "Engine API error NNN" so real engine outages surface clearly.
   *
   * Response shape: PricePoint[]. Confirmed against engine
   * src/trader_engine/api/routes/prices.py.
   */
  async getPrices(asset: string, fromMs: number, toMs: number): Promise<PricePoint[]> {
    const url = this.baseUrl + `/prices/${encodeURIComponent(asset)}?from_ms=${fromMs}&to_ms=${toMs}`;
    const resp = await fetch(url, {
      headers: {
        "X-Engine-Token": this.token,
        "Content-Type": "application/json",
      },
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (resp.status === 404) {
      // Engine signals "no data in this window" with 404. Treat as empty.
      return [];
    }
    if (!resp.ok) {
      throw new Error(
        "Engine API error " + resp.status + " on /prices/" + asset,
      );
    }
    return (await resp.json()) as PricePoint[];
  }

  /**
   * Phase 8C -- fetch pre-aggregated signal telemetry for the Analyst Paw.
   * Calls GET /signals/telemetry?days=N on the engine and returns the
   * summary JSON: regime distribution, per-strategy fire/suppress stats,
   * and consecutive near-miss sequences.
   *
   * Returns null when the engine is unreachable or returns 404 (older
   * engine builds that predate the telemetry route).  The collector
   * treats null as a non-fatal collection error so the paw cycle still
   * runs and the LLM can flag the data gap in its report.
   */
  async getSignalTelemetry(days = 7): Promise<SignalTelemetrySummary | null> {
    return this.requestNullable<SignalTelemetrySummary>(
      `/signals/telemetry?days=${days}`,
    )
  }

  /**
   * GET /signals/markov/{asset} -- Markov-chain regime payload for enrichment.
   * The asset segment is URI-encoded so BTC/USD becomes BTC%2FUSD on the wire
   * while FastAPI's `path` converter decodes it back to BTC/USD server-side.
   *
   * Hard 5 s timeout -- Markov computation is fast but we cannot let a hung
   * engine stall the enrichment pipeline.  Returns null on ANY error (network,
   * 4xx, 5xx, timeout, parse failure) so callers always get a result even when
   * the regime endpoint is unavailable.
   *
   * backtest=false skips the walk-forward backtest (~1.5 s saved per call);
   * the nightly job refreshes walk-forward results independently.
   */
  async getMarkovRegime(asset: string): Promise<MarkovRegimePayload | null> {
    const path = `/signals/markov/${encodeURIComponent(asset)}?backtest=false&window=20&threshold=0.02`;
    const url = this.baseUrl + path;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5_000);
    try {
      const resp = await fetch(url, {
        headers: {
          'X-Engine-Token': this.token,
          'Content-Type': 'application/json',
        },
        signal: controller.signal,
      });
      if (!resp.ok) {
        logger.warn({ asset, status: resp.status }, 'enrichment: markov regime fetch non-2xx');
        return null;
      }
      return (await resp.json()) as MarkovRegimePayload;
    } catch (err) {
      logger.warn({ asset, err }, 'enrichment: markov regime fetch failed');
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
}

let _engineInstance: EngineClient | null = null

export function getEngineClient(): EngineClient {
  if (!_engineInstance) {
    const url = getCredential('trader', 'engine', 'url')
    const token = getCredential('trader', 'engine', 'token')
    if (!url || !token) {
      throw new Error('Trader engine credentials not configured. Run: cred-cli set trader engine url <url>')
    }
    _engineInstance = new EngineClient({ baseUrl: url, token })
  }
  return _engineInstance
}
