/**
 * trader-routes/shared.engine-fetch.test.ts
 *
 * Phase 7 Task 6 -- unit tests for the engineFetch RequestInit overload.
 *
 * Before Phase 7 Task 6, engineFetch was GET-only and the two POST
 * routes (halt + clear-breaker in status.ts) inlined their own fetch()
 * with the X-Engine-Token header hand-copied.  The overload folded that
 * duplication back into one code path, but the behaviour only survives
 * under refactor if we pin it with tests:
 *
 *   - default is GET with no body
 *   - an init.method + init.body are forwarded verbatim to fetch
 *   - init.headers merge on top of the auth + Content-Type defaults
 *   - a non-2xx response throws with the path in the message so the
 *     502 surfaced to the dashboard still names the failing route
 *
 * The tests stub the global fetch so this file stays a pure unit test
 * of the helper -- no HTTP server, no test DB.  That keeps it cheap to
 * run on every `npm test` regardless of whether a live engine is up.
 */

import { describe, it, expect, afterEach, vi } from 'vitest'
import { engineFetch, type EngineConfig } from './shared.js'

const cfg: EngineConfig = { baseUrl: 'http://engine.test', token: 'secret-token' }

afterEach(() => {
  vi.restoreAllMocks()
})

function mockFetchOnce(status: number, body: unknown): ReturnType<typeof vi.spyOn> {
  const resp = new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
  return vi.spyOn(globalThis, 'fetch').mockResolvedValue(resp)
}

describe('engineFetch (Phase 7 Task 6)', () => {
  it('issues a GET by default with the auth header and JSON content type', async () => {
    const spy = mockFetchOnce(200, { ok: true })

    const data = await engineFetch<{ ok: boolean }>(cfg, '/health')

    expect(data).toEqual({ ok: true })
    expect(spy).toHaveBeenCalledTimes(1)
    const [url, init] = spy.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('http://engine.test/health')
    expect(init.method).toBeUndefined() // default GET
    expect(init.body).toBeUndefined()
    const headers = init.headers as Record<string, string>
    expect(headers['X-Engine-Token']).toBe('secret-token')
    expect(headers['Content-Type']).toBe('application/json')
    expect(init.signal).toBeInstanceOf(AbortSignal)
  })

  it('forwards an init.method and init.body verbatim to fetch', async () => {
    const spy = mockFetchOnce(200, { status: 'halted' })

    const data = await engineFetch<{ status: string }>(cfg, '/risk/halt', {
      method: 'POST',
      body: JSON.stringify({ reason: 'manual halt via dashboard' }),
    })

    expect(data).toEqual({ status: 'halted' })
    const [, init] = spy.mock.calls[0] as [string, RequestInit]
    expect(init.method).toBe('POST')
    expect(init.body).toBe('{"reason":"manual halt via dashboard"}')
    const headers = init.headers as Record<string, string>
    expect(headers['X-Engine-Token']).toBe('secret-token')
    expect(headers['Content-Type']).toBe('application/json')
  })

  it('merges caller-supplied headers on top of auth + content-type defaults', async () => {
    const spy = mockFetchOnce(200, {})

    await engineFetch(cfg, '/health', {
      headers: { 'X-Request-Id': 'abc-123', 'Content-Type': 'text/plain' },
    })

    const [, init] = spy.mock.calls[0] as [string, RequestInit]
    const headers = init.headers as Record<string, string>
    expect(headers['X-Engine-Token']).toBe('secret-token') // auth always wins
    expect(headers['X-Request-Id']).toBe('abc-123') // extra header forwarded
    expect(headers['Content-Type']).toBe('text/plain') // caller override honoured
  })

  it('throws with the path in the message on a non-2xx response', async () => {
    mockFetchOnce(502, { error: 'bad gateway' })

    await expect(engineFetch(cfg, '/risk/halt', { method: 'POST' })).rejects.toThrow(
      'Engine API error 502 on /risk/halt',
    )
  })
})
