import { describe, it, expect, vi, beforeEach } from "vitest";
import { EngineClient } from "./engine-client.js";
import type { DecisionRequest } from "./types.js";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

function mockResp(body: unknown, status = 200) {
  return Promise.resolve({
    ok: status < 400,
    status,
    json: () => Promise.resolve(body),
  });
}

describe("EngineClient", () => {
  let client: EngineClient;

  beforeEach(() => {
    mockFetch.mockReset();
    client = new EngineClient({ baseUrl: "http://your-engine-host:8200", token: "tok" });
  });

  it("getHealth returns HealthResponse on 200", async () => {
    mockFetch.mockReturnValueOnce(
      mockResp({ status: "ok", version: "0.1.0", alpaca_connected: true, alpaca_mode: "paper" })
    );
    const health = await client.getHealth();
    expect(health).not.toBeNull();
    expect(health?.status).toBe("ok");
    expect(health?.alpaca_connected).toBe(true);
  });

  it("getHealth throws on 401", async () => {
    mockFetch.mockReturnValueOnce(mockResp({ error: "unauthorized" }, 401));
    await expect(client.getHealth()).rejects.toThrow("Engine API error 401");
  });

  it("getPositions returns typed list", async () => {
    mockFetch.mockReturnValueOnce(
      mockResp([
        {
          asset: "AAPL", qty: 3, avg_entry_price: 180,
          market_value: 541.5, unrealized_pnl: 7.5,
          source: "alpaca", updated_at: Date.now(),
        },
      ])
    );
    const positions = await client.getPositions();
    expect(positions).toHaveLength(1);
    expect(positions[0].asset).toBe("AAPL");
  });

  it("sends X-Engine-Token header on every request", async () => {
    mockFetch.mockReturnValueOnce(
      mockResp({ status: "ok", version: "0.1.0", alpaca_connected: true, alpaca_mode: "paper" })
    );
    // Need a client with a specific token to assert it's forwarded correctly
    const tokenClient = new EngineClient({ baseUrl: "http://your-engine-host:8200", token: "mytoken123" });
    await tokenClient.getHealth();
    const [, options] = mockFetch.mock.calls[0];
    expect((options as RequestInit).headers).toMatchObject({ "X-Engine-Token": "mytoken123" });
  });

  it("haltTrading POSTs to /risk/halt", async () => {
    mockFetch.mockReturnValueOnce(mockResp({}, 200));
    await client.haltTrading("test halt");
    const [url, options] = mockFetch.mock.calls[0];
    expect(url).toContain("/risk/halt");
    expect((options as RequestInit).method).toBe("POST");
  });

  it("getSignals returns candidate array", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => [{ id: "sig1", strategy: "momentum", asset: "AAPL", side: "buy", raw_score: 0.72, horizon_days: 20, generated_at: Date.now() }],
    });
    const result = await client.getSignals(30);
    expect(result).toHaveLength(1);
    expect(result[0].asset).toBe("AAPL");
  });

  it("submitDecision returns client_order_id", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ client_order_id: "coid-123", broker_order_id: "boid", status: "placed", approved_size_usd: 100 }),
    });
    const decision: DecisionRequest = {
      decision_id: "did-1", asset: "AAPL", side: "buy", size_usd: 100,
      entry_type: "limit", entry_price: 185, strategy: "momentum", confidence: 0.78,
    };
    const result = await client.submitDecision(decision);
    expect(result.client_order_id).toBe("coid-123");
    expect(result.status).toBe("placed");
  });

  it("getRiskState returns tripped array", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ tripped: ["daily_loss"], details: [] }),
    });
    const state = await client.getRiskState();
    expect(state.tripped).toContain("daily_loss");
  });

  it("haltEngine posts to /risk/halt", async () => {
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ status: "halted" }) });
    await client.haltEngine("test reason");
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("/risk/halt"),
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("getNavSnapshots defaults to limit=30 and returns typed list", async () => {
    mockFetch.mockReturnValueOnce(
      mockResp([
        { date: "2026-04-13", period: "day_open", nav: 100000, recorded_at: Date.now() },
        { date: "2026-04-13", period: "week_open", nav: 100000, recorded_at: Date.now() },
      ]),
    );
    const snapshots = await client.getNavSnapshots();
    expect(snapshots).toHaveLength(2);
    expect(snapshots[0].period).toBe("day_open");
    const [url] = mockFetch.mock.calls[0];
    expect(url).toContain("/nav/snapshots?limit=30");
  });

  it("getNavSnapshots honors explicit limit", async () => {
    mockFetch.mockReturnValueOnce(mockResp([]));
    await client.getNavSnapshots(50);
    const [url] = mockFetch.mock.calls[0];
    expect(url).toContain("/nav/snapshots?limit=50");
  });

  it("getNavLatest defaults to day_open", async () => {
    mockFetch.mockReturnValueOnce(
      mockResp({ date: "2026-04-13", period: "day_open", nav: 100000, recorded_at: 1700000000000 }),
    );
    const snap = await client.getNavLatest();
    expect(snap).not.toBeNull();
    expect(snap?.period).toBe("day_open");
    const [url] = mockFetch.mock.calls[0];
    expect(url).toContain("/nav/latest?period=day_open");
  });

  it("getNavLatest accepts week_open", async () => {
    mockFetch.mockReturnValueOnce(
      mockResp({ date: "2026-04-13", period: "week_open", nav: 100000, recorded_at: 1700000000000 }),
    );
    const snap = await client.getNavLatest("week_open");
    expect(snap?.period).toBe("week_open");
    const [url] = mockFetch.mock.calls[0];
    expect(url).toContain("/nav/latest?period=week_open");
  });

  it("getNavLatest returns null when engine has no snapshot", async () => {
    mockFetch.mockReturnValueOnce(mockResp(null));
    const snap = await client.getNavLatest("day_close");
    expect(snap).toBeNull();
  });

  it("getNavSnapshots throws on 401", async () => {
    mockFetch.mockReturnValueOnce(mockResp({ error: "unauthorized" }, 401));
    await expect(client.getNavSnapshots()).rejects.toThrow("Engine API error 401");
  });

  // Phase 4 Task B -- /prices endpoint
  it("getPrices builds URL with asset + from_ms + to_ms and forwards auth", async () => {
    mockFetch.mockReturnValueOnce(
      mockResp([
        { date: "2026-03-01", close: 180.5, ts_ms: 1740787200000 },
        { date: "2026-03-02", close: 181.0, ts_ms: 1740873600000 },
      ]),
    );
    const prices = await client.getPrices("AAPL", 1740787200000, 1745000000000);
    expect(prices).toHaveLength(2);
    expect(prices[0].close).toBe(180.5);
    expect(prices[1].ts_ms).toBe(1740873600000);

    const [url, options] = mockFetch.mock.calls[0];
    expect(url).toContain("/prices/AAPL");
    expect(url).toContain("from_ms=1740787200000");
    expect(url).toContain("to_ms=1745000000000");
    expect((options as RequestInit).headers).toMatchObject({ "X-Engine-Token": "tok" });
  });

  it("getPrices returns [] when engine responds 404 (no data in window)", async () => {
    mockFetch.mockReturnValueOnce(mockResp({ detail: "no data" }, 404));
    const prices = await client.getPrices("AAPL", 1, 2);
    expect(prices).toEqual([]);
  });

  it("getPrices throws on non-404 error responses", async () => {
    mockFetch.mockReturnValueOnce(mockResp({ detail: "server died" }, 500));
    await expect(client.getPrices("AAPL", 1, 2)).rejects.toThrow("Engine API error 500");
  });

  it("getPrices URL-encodes slash-bearing crypto symbols like BTC/USD", async () => {
    mockFetch.mockReturnValueOnce(mockResp([]));
    // Engine 404s for empty windows; with our 404 -> [] coercion this
    // still resolves cleanly. The URL shape is what we're validating.
    mockFetch.mockReturnValueOnce(mockResp({ detail: "no data" }, 404));
    await client.getPrices("BTC/USD", 1, 2);
    const [url] = mockFetch.mock.calls[mockFetch.mock.calls.length - 1];
    // encodeURIComponent turns '/' into '%2F'.
    expect(url).toContain("/prices/BTC%2FUSD");
  });

  // Phase 5 Task 1 -- getNav returns a bare number (or null) for the
  // dispatcher's cap computation. It hits the same /nav/latest route
  // getNavLatest uses but extracts just the nav field so callers do
  // not have to care about snapshot envelope shape.
  it("getNav returns parsed number from /nav/latest?period=day_open", async () => {
    mockFetch.mockReturnValueOnce(
      mockResp({ date: '2026-04-19', period: 'day_open', nav: 10234.56, recorded_at: 1_745_000_000_000 }),
    );
    const navClient = new EngineClient({ baseUrl: 'http://localhost:8200', token: 'test-token' });
    await expect(navClient.getNav()).resolves.toBe(10234.56);
    const [url, options] = mockFetch.mock.calls[0];
    expect(url).toContain('/nav/latest?period=day_open');
    expect((options as RequestInit).headers).toMatchObject({ 'X-Engine-Token': 'test-token' });
  });

  it("getNav returns null when no snapshot exists yet", async () => {
    mockFetch.mockReturnValueOnce(mockResp(null));
    const navClient = new EngineClient({ baseUrl: 'http://localhost:8200', token: 'test-token' });
    await expect(navClient.getNav()).resolves.toBeNull();
  });

  it("getNav returns null on 404", async () => {
    mockFetch.mockReturnValueOnce(mockResp({ detail: 'not found' }, 404));
    const navClient = new EngineClient({ baseUrl: 'http://localhost:8200', token: 'test-token' });
    await expect(navClient.getNav()).resolves.toBeNull();
  });

  // Phase 6 Task 4 -- requestNullable<T> refactor.  getNav now shares the
  // null-on-404-or-network-error plumbing with getHealth + getNavSnapshots.
  // The behaviour change (previously getNav threw on a fetch failure) is
  // safe: the dispatcher already catches getNav throws and falls back to
  // DEFAULT_SIZE_USD (see Phase 5 Task 1 handoff), so callers keep working.
  it("getNav returns null on network error / fetch timeout", async () => {
    mockFetch.mockImplementationOnce(() => Promise.reject(new Error('ECONNREFUSED')));
    const navClient = new EngineClient({ baseUrl: 'http://localhost:8200', token: 'test-token' });
    await expect(navClient.getNav()).resolves.toBeNull();
  });

  it("getNav throws on 500 (real engine outage surfaces)", async () => {
    mockFetch.mockReturnValueOnce(mockResp({ detail: 'boom' }, 500));
    const navClient = new EngineClient({ baseUrl: 'http://localhost:8200', token: 'test-token' });
    await expect(navClient.getNav()).rejects.toThrow('Engine API error 500');
  });

  // Phase 5 Task 2c -- getHealth returns the full health body (not just a
  // status string). The monitor's Coinbase check needs coinbase_connected
  // and the dashboard's /status proxy needs the full shape including
  // reconciler_halted + halt_reason. Mirror the getNav null-on-404 pattern
  // so an older engine that 404s on /health never throws.
  it("getHealth returns parsed body on 2xx", async () => {
    mockFetch.mockReturnValueOnce(
      mockResp({
        status: 'ok',
        version: '0.1.0',
        alpaca_connected: true,
        alpaca_mode: 'paper',
        reconciler_halted: false,
        halt_reason: null,
        coinbase_connected: true,
      }),
    );
    const healthClient = new EngineClient({ baseUrl: 'http://localhost:8200', token: 'test-token' });
    const body = await healthClient.getHealth();
    expect(body).not.toBeNull();
    expect(body?.coinbase_connected).toBe(true);
    expect(body?.reconciler_halted).toBe(false);
    expect(body?.alpaca_mode).toBe('paper');
    const [url, options] = mockFetch.mock.calls[0];
    expect(url).toContain('/health');
    expect((options as RequestInit).headers).toMatchObject({ 'X-Engine-Token': 'test-token' });
  });

  it("getHealth returns null on 404", async () => {
    mockFetch.mockReturnValueOnce(mockResp({ detail: 'not found' }, 404));
    const healthClient = new EngineClient({ baseUrl: 'http://localhost:8200', token: 'test-token' });
    await expect(healthClient.getHealth()).resolves.toBeNull();
  });

  it("getHealth throws on 500", async () => {
    mockFetch.mockReturnValueOnce(mockResp({ detail: 'boom' }, 500));
    const healthClient = new EngineClient({ baseUrl: 'http://localhost:8200', token: 'test-token' });
    await expect(healthClient.getHealth()).rejects.toThrow('Engine API error 500');
  });

  // Phase 6 Task 4 -- shared requestNullable<T> helper.  The network-error
  // path was already exercised through getNavSnapshots; this pin makes the
  // getHealth contribution to the shared path explicit.
  it("getHealth returns null on network error / fetch timeout", async () => {
    mockFetch.mockImplementationOnce(() => Promise.reject(new Error('ECONNREFUSED')));
    const healthClient = new EngineClient({ baseUrl: 'http://localhost:8200', token: 'test-token' });
    await expect(healthClient.getHealth()).resolves.toBeNull();
  });

  // Phase 5 Task 2 Dispatch C -- NAV-drop halt monitor.
  //
  // getNavSnapshots returns an array on 2xx, [] on 404 / network error,
  // throws on other non-2xx.  The empty-array-on-failure variant is
  // deliberate: callers iterate the result and an empty list is more
  // useful than null-guarding every site.  Mirrors the parallel handling
  // already in getPrices (which is also empty-on-404).
  it("getNavSnapshots returns the array on 2xx (3 entries)", async () => {
    mockFetch.mockReturnValueOnce(
      mockResp([
        { date: '2026-04-19', period: 'day_open', nav: 10000, recorded_at: 1_000 },
        { date: '2026-04-18', period: 'day_open', nav: 9800,  recorded_at: 2_000 },
        { date: '2026-04-17', period: 'day_open', nav: 9700,  recorded_at: 3_000 },
      ]),
    );
    const c = new EngineClient({ baseUrl: 'http://localhost:8200', token: 't' });
    const snaps = await c.getNavSnapshots(10);
    expect(snaps).toHaveLength(3);
    expect(snaps[0].nav).toBe(10000);
    expect(snaps[2].date).toBe('2026-04-17');
  });

  it("getNavSnapshots returns [] on 404 (older engine without the route)", async () => {
    mockFetch.mockReturnValueOnce(mockResp({ detail: 'not found' }, 404));
    const c = new EngineClient({ baseUrl: 'http://localhost:8200', token: 't' });
    await expect(c.getNavSnapshots(10)).resolves.toEqual([]);
  });

  it("getNavSnapshots returns [] on network error / fetch timeout", async () => {
    mockFetch.mockImplementationOnce(() => Promise.reject(new Error('ECONNREFUSED')));
    const c = new EngineClient({ baseUrl: 'http://localhost:8200', token: 't' });
    await expect(c.getNavSnapshots(10)).resolves.toEqual([]);
  });

  it("getNavSnapshots throws on 500 (real engine outage surfaces)", async () => {
    mockFetch.mockReturnValueOnce(mockResp({ detail: 'boom' }, 500));
    const c = new EngineClient({ baseUrl: 'http://localhost:8200', token: 't' });
    await expect(c.getNavSnapshots(10)).rejects.toThrow('Engine API error 500');
  });

  it("getNavSnapshots forwards the limit query param verbatim", async () => {
    mockFetch.mockReturnValueOnce(mockResp([]));
    const c = new EngineClient({ baseUrl: 'http://localhost:8200', token: 't' });
    await c.getNavSnapshots(25);
    const [url] = mockFetch.mock.calls[0];
    expect(url).toContain('?limit=25');
  });

  // haltEngine: POST /risk/halt with {reason}, throws on non-2xx.  No
  // retries -- a halt failure must be loud.  The NAV-drop monitor calls
  // this directly when it fires.
  it("haltEngine POSTs /risk/halt with reason in JSON body", async () => {
    mockFetch.mockReturnValueOnce(mockResp({ status: 'halted' }, 200));
    const c = new EngineClient({ baseUrl: 'http://localhost:8200', token: 'tok-halt' });
    await c.haltEngine('NAV drop 6.0%');
    const [url, options] = mockFetch.mock.calls[0];
    expect(url).toContain('/risk/halt');
    expect((options as RequestInit).method).toBe('POST');
    expect((options as RequestInit).headers).toMatchObject({ 'X-Engine-Token': 'tok-halt' });
    const body = JSON.parse((options as RequestInit).body as string);
    expect(body).toEqual({ reason: 'NAV drop 6.0%' });
  });

  it("haltEngine throws on non-2xx (no silent failure)", async () => {
    mockFetch.mockReturnValueOnce(mockResp({ detail: 'engine down' }, 503));
    const c = new EngineClient({ baseUrl: 'http://localhost:8200', token: 'tok' });
    await expect(c.haltEngine('boom')).rejects.toThrow('Engine API error 503');
  });
});
