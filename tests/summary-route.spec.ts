/**
 * Summary route tests: the JSON replies the chip polls, and the browser-trust
 * fence guarding them (the same rules the official `/api` gateway and the
 * community `/sidebar` routes apply).
 * @module @deepseek-ai/dsh-working-activity/tests/summary-route
 */

import { describe, expect, it } from 'vitest'
import { SummaryRegistry, type SummarySnapshot } from '../src/summary-registry.ts'
import {
  SUMMARY_POLL_HEADER,
  SUMMARY_ROUTE_PATH,
  SUMMARY_ROUTE_PREFIX,
  createSummaryRouteHandler,
  isTrustedSummaryRequest,
  type SummaryHttpRequest,
  type SummaryHttpResponse,
} from '../src/summary-route.ts'

/** One recorded reply. */
interface Recorded {
  status: number
  headers: Record<string, string>
  body: string | undefined
}

/** Minimal `{ writeHead, end }` response that records what the handler wrote. */
function fakeResponse(): { res: SummaryHttpResponse; recorded: Recorded } {
  const recorded: Recorded = { status: 0, headers: {}, body: undefined }
  const res: SummaryHttpResponse = {
    statusCode: 200,
    writeHead(status, headers) {
      recorded.status = status
      recorded.headers = headers ?? {}
    },
    end(body) {
      recorded.body = body === undefined
        ? undefined
        : typeof body === 'string' ? body : new TextDecoder().decode(body)
    },
  }
  return { res, recorded }
}

/** A trusted loopback GET for one session. */
function request(overrides: Partial<SummaryHttpRequest> = {}): SummaryHttpRequest {
  return {
    method: 'GET',
    url: '/working-activity-llm/summary?sessionId=s1',
    headers: { host: '127.0.0.1:19387' },
    ...overrides,
  }
}

const SNAPSHOT: SummarySnapshot = {
  sessionId: 's1',
  line: '✨ Debugging the parser',
  text: 'Debugging the parser',
  revision: 3,
  at: 1_700_000_000_000,
}

/** Registry holding {@link SNAPSHOT} for `s1`. */
function registryWithSnapshot(): SummaryRegistry {
  const registry = new SummaryRegistry()
  registry.set(SNAPSHOT)
  return registry
}

describe('summary route constants', () => {
  it('pins the path, prefix and poll header', () => {
    expect(SUMMARY_ROUTE_PREFIX).toBe('/working-activity-llm')
    expect(SUMMARY_ROUTE_PATH).toBe('/working-activity-llm/summary')
    expect(SUMMARY_POLL_HEADER).toBe('x-activity-poll-ms')
  })
})

describe('createSummaryRouteHandler', () => {
  it('serves a stored summary as no-store JSON with the poll cadence', () => {
    const handler = createSummaryRouteHandler({
      registry: registryWithSnapshot(),
      trustedHosts: [],
      pollMs: 750,
    })
    const { res, recorded } = fakeResponse()
    handler(request(), res)

    expect(recorded.status).toBe(200)
    expect(recorded.headers['content-type']).toBe('application/json; charset=utf-8')
    expect(recorded.headers['cache-control']).toBe('no-store')
    expect(recorded.headers['x-activity-poll-ms']).toBe('750')
    const body = JSON.parse(recorded.body ?? '{}') as Record<string, unknown>
    expect(body).toEqual({
      sessionId: 's1',
      line: '✨ Debugging the parser',
      text: 'Debugging the parser',
      revision: 3,
      at: 1_700_000_000_000,
    })
    expect(Object.keys(body).sort()).toEqual(['at', 'line', 'revision', 'sessionId', 'text'])
  })

  it('returns 204 with no body for a session with no accepted summary', () => {
    const handler = createSummaryRouteHandler({ registry: new SummaryRegistry(), trustedHosts: [] })
    const { res, recorded } = fakeResponse()
    handler(request(), res)

    expect(recorded.status).toBe(204)
    expect(recorded.body).toBeUndefined()
    expect(recorded.headers['cache-control']).toBe('no-store')
    expect(recorded.headers['x-activity-poll-ms']).toBe('1000')
  })

  it('returns 400 when sessionId is missing or empty', () => {
    const handler = createSummaryRouteHandler({ registry: registryWithSnapshot(), trustedHosts: [] })

    for (const url of ['/working-activity-llm/summary', '/working-activity-llm/summary?sessionId=']) {
      const { res, recorded } = fakeResponse()
      handler(request({ url }), res)
      expect(recorded.status).toBe(400)
      expect(JSON.parse(recorded.body ?? '{}')).toEqual({ error: 'sessionId is required' })
    }
  })

  it('returns 405 with an allow header for a non-GET method', () => {
    const handler = createSummaryRouteHandler({ registry: registryWithSnapshot(), trustedHosts: [] })
    const { res, recorded } = fakeResponse()
    handler(request({ method: 'POST' }), res)

    expect(recorded.status).toBe(405)
    expect(recorded.headers.allow).toBe('GET')
    expect(recorded.headers['cache-control']).toBe('no-store')
    expect(JSON.parse(recorded.body ?? '{}')).toEqual({ error: 'method not allowed' })
  })

  it('treats a missing method as GET', () => {
    const handler = createSummaryRouteHandler({ registry: registryWithSnapshot(), trustedHosts: [] })
    const { res, recorded } = fakeResponse()
    handler(request({ method: undefined }), res)
    expect(recorded.status).toBe(200)
  })

  it('returns 403 for an untrusted request', () => {
    const handler = createSummaryRouteHandler({ registry: registryWithSnapshot(), trustedHosts: [] })
    const { res, recorded } = fakeResponse()
    handler(request({ headers: { host: 'evil.example.com' } }), res)

    expect(recorded.status).toBe(403)
    expect(JSON.parse(recorded.body ?? '{}')).toEqual({ error: 'untrusted request' })
  })

  it('clamps the advertised poll interval to at least 250 ms', () => {
    const registry = registryWithSnapshot()
    const low = fakeResponse()
    createSummaryRouteHandler({ registry, trustedHosts: [], pollMs: 100 })(request(), low.res)
    expect(low.recorded.headers['x-activity-poll-ms']).toBe('250')

    const high = fakeResponse()
    createSummaryRouteHandler({ registry, trustedHosts: [], pollMs: 2_500.4 })(request(), high.res)
    expect(high.recorded.headers['x-activity-poll-ms']).toBe('2500')
  })
})

describe('isTrustedSummaryRequest', () => {
  it('rejects a request with no Host header', () => {
    expect(isTrustedSummaryRequest({ headers: {} }, [])).toBe(false)
    expect(isTrustedSummaryRequest({ headers: { origin: 'http://127.0.0.1:19387' } }, [])).toBe(false)
  })

  it('rejects an untrusted non-loopback host', () => {
    expect(isTrustedSummaryRequest({ headers: { host: 'evil.example.com' } }, [])).toBe(false)
    expect(isTrustedSummaryRequest({ headers: { host: 'evil.example.com:19387' } }, [])).toBe(false)
  })

  it('rejects an unparsable host', () => {
    expect(isTrustedSummaryRequest({ headers: { host: 'not a host' } }, [])).toBe(false)
    expect(isTrustedSummaryRequest({ headers: { host: '' } }, [])).toBe(false)
  })

  it('rejects a cross-site fetch', () => {
    expect(isTrustedSummaryRequest({
      headers: { host: '127.0.0.1:19387', 'sec-fetch-site': 'cross-site' },
    }, [])).toBe(false)
  })

  it('rejects a cross-origin Origin', () => {
    expect(isTrustedSummaryRequest({
      headers: { host: '127.0.0.1:19387', origin: 'http://evil.example.com' },
    }, [])).toBe(false)
    expect(isTrustedSummaryRequest({
      headers: { host: '127.0.0.1:19387', origin: 'null' },
    }, [])).toBe(false)
  })

  it('accepts loopback authorities', () => {
    expect(isTrustedSummaryRequest({ headers: { host: '127.0.0.1:19387' } }, [])).toBe(true)
    expect(isTrustedSummaryRequest({ headers: { host: 'localhost:8080' } }, [])).toBe(true)
    expect(isTrustedSummaryRequest({ headers: { host: '[::1]:1' } }, [])).toBe(true)
    expect(isTrustedSummaryRequest({ headers: { host: '127.0.0.2:5173' } }, [])).toBe(true)
  })

  it('accepts a configured trusted authority (exact or port-less)', () => {
    expect(isTrustedSummaryRequest(
      { headers: { host: 'dsh.example.com:8443' } },
      ['dsh.example.com:8443'],
    )).toBe(true)
    // A port-less entry matches any port on that hostname.
    expect(isTrustedSummaryRequest(
      { headers: { host: 'dsh.example.com:8443' } },
      ['dsh.example.com'],
    )).toBe(true)
    // A contrary entry does not match a bare hostname.
    expect(isTrustedSummaryRequest(
      { headers: { host: 'dsh.example.com' } },
      ['dsh.example.com:8443'],
    )).toBe(false)
  })

  it('accepts a loopback request with no Origin', () => {
    expect(isTrustedSummaryRequest({ headers: { host: '127.0.0.1:19387', 'sec-fetch-site': 'same-origin' } }, [])).toBe(true)
  })

  it('accepts an Origin that is the same authority as the Host', () => {
    expect(isTrustedSummaryRequest({
      headers: { host: 'localhost:8080', origin: 'http://localhost:8080' },
    }, [])).toBe(true)
    expect(isTrustedSummaryRequest({
      headers: { host: '127.0.0.1:19387', origin: 'http://127.0.0.1:19387' },
    }, [])).toBe(true)
  })

  it('rejects an Origin on the same host but a different port or scheme', () => {
    // Stricter than the ported community fence, deliberately: that one compared
    // hostnames only, so any other loopback server's page counted as
    // same-origin. Same-origin means the full authority — scheme, host, port.
    expect(isTrustedSummaryRequest({
      headers: { host: '127.0.0.1:19387', origin: 'http://127.0.0.1:51999' },
    }, [])).toBe(false)
    expect(isTrustedSummaryRequest({
      headers: { host: '127.0.0.1:19387', origin: 'https://127.0.0.1:19387' },
    }, [])).toBe(false)
  })

  it('rejects a cross-site marker whatever its casing', () => {
    expect(isTrustedSummaryRequest({
      headers: { host: '127.0.0.1:19387', 'sec-fetch-site': 'cross-site' },
    }, [])).toBe(false)
    // Header values are case-insensitive tokens by spec; a browser may send any casing.
    expect(isTrustedSummaryRequest({
      headers: { host: '127.0.0.1:19387', 'sec-fetch-site': 'Cross-Site' },
    }, [])).toBe(false)
  })
})
