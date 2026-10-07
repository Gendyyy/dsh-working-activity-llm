/**
 * The chip's own host route: `GET /working-activity-llm/summary?sessionId=…`
 * returns the latest accepted semantic summary for one session.
 *
 * This is the liveness half of the chip. The `workingActivity` session
 * projection carries the heuristic line and the phase (and is still the only
 * source for those), but its push is driven by committed session events — no
 * event, no push. A classifier answer lands between events, so the client asks
 * for it directly on a short interval while a turn is live, and stops the
 * moment the phase settles. One small JSON body per second is a fair price for
 * a chip that actually keeps up.
 *
 * Security: the handler applies the same browser-trust fence as the official
 * `/api` gateway and every `/sidebar` route — loopback or a configured trusted
 * authority, no cross-site fetch, same-origin when an `Origin` is present. The
 * route is read-only and exposes only copy derived from the same session the
 * caller already renders; it never returns tool arguments, paths, or model text.
 * @module dsh-working-activity-llm/summary-route
 */

import type { SummaryRegistry, SummarySnapshot } from './summary-registry.js'

/** Route prefix this plugin owns. Nothing else in DSH uses it. */
export const SUMMARY_ROUTE_PREFIX = '/working-activity-llm'

/** Exact path the client polls. */
export const SUMMARY_ROUTE_PATH = `${SUMMARY_ROUTE_PREFIX}/summary`

/** Structural view of the node request facts the handler reads. */
export interface SummaryHttpRequest {
  readonly method?: string
  readonly url?: string
  readonly headers: Record<string, string | string[] | undefined>
}

/** Structural view of the node response face the handler writes to. */
export interface SummaryHttpResponse {
  statusCode: number
  writeHead(status: number, headers?: Record<string, string>): void
  end(body?: string | Uint8Array): void
}

/** The slice of the host `webServer` service this plugin uses. */
export interface SummaryWebServer {
  register(route: {
    kind: 'exact' | 'prefix'
    path: string
    handler: (req: SummaryHttpRequest, res: SummaryHttpResponse) => void | Promise<void>
  }): () => void
}

/** The slice of the host `webRuntime` service the trust fence reads. */
export interface SummaryWebRuntime {
  readonly trustedHosts: readonly string[]
}

/** Construction options for {@link createSummaryRouteHandler}. */
export interface SummaryRouteOptions {
  /** Where accepted summaries live. */
  readonly registry: SummaryRegistry
  /** Deployment's non-loopback trusted authorities. */
  readonly trustedHosts: readonly string[]
  /**
   * Poll interval the client should use, advertised as `x-activity-poll-ms`.
   * The browser bundle cannot read host plugin config, so the route is how the
   * configured cadence actually reaches the chip.
   */
  readonly pollMs?: number
}

/** Header carrying the client's poll cadence. */
export const SUMMARY_POLL_HEADER = 'x-activity-poll-ms'

/** One request header value, when the header is present exactly once. */
function header(headers: Record<string, string | string[] | undefined>, name: string): string | undefined {
  const value = headers[name]
  return typeof value === 'string' ? value : undefined
}

/** Normalized URL of a Host-header authority, or undefined when unparsable. */
function parseAuthority(authority: string): URL | undefined {
  try {
    return new URL(`http://${authority}`)
  } catch {
    return undefined
  }
}

/** Whether a hostname names the local loopback authority. */
function isLoopbackHostname(hostname: string): boolean {
  if (hostname === 'localhost' || hostname === '[::1]') return true
  const parts = hostname.split('.')
  return parts.length === 4 && parts[0] === '127'
    && parts.every(part => /^\d{1,3}$/.test(part) && Number(part) <= 255)
}

/** Canonical authority form: hostname, or hostname:port when a port was written. */
function canonicalAuthority(entry: string, entryUrl: URL): string {
  const port = entryUrl.port !== '' ? entryUrl.port : new URL(`https://${entry}`).port
  return port === '' ? entryUrl.hostname : `${entryUrl.hostname}:${port}`
}

/** Whether the request authority matches a trustedHosts entry (exact or port-less). */
function isTrustedAuthority(hostUrl: URL, trustedHosts: readonly string[]): boolean {
  return trustedHosts.some(entry => {
    const entryUrl = parseAuthority(entry)
    if (entryUrl === undefined) return false
    return canonicalAuthority(entry, entryUrl) === entryUrl.hostname
      ? entryUrl.hostname === hostUrl.hostname
      : entryUrl.host === hostUrl.host
  })
}

/**
 * Decide whether one request may read this plugin's state — the same rules the
 * official `/api` gateway and the community `/sidebar` routes apply, with one
 * deliberate tightening noted below.
 * @param request - node request facts (headers only).
 * @param trustedHosts - non-loopback authorities this deployment serves.
 * @returns true when the Host is ours and the browser markers are same-origin.
 */
export function isTrustedSummaryRequest(
  request: SummaryHttpRequest,
  trustedHosts: readonly string[],
): boolean {
  const host = header(request.headers, 'host')
  if (host === undefined) return false
  const hostUrl = parseAuthority(host)
  if (hostUrl === undefined) return false
  if (!isLoopbackHostname(hostUrl.hostname) && !isTrustedAuthority(hostUrl, trustedHosts)) return false
  // Case-insensitive: header values are case-insensitive tokens by spec, and a
  // browser is free to send `Cross-Site`. The ported community fence compared
  // this exactly, which let a differently-cased value walk through.
  if ((header(request.headers, 'sec-fetch-site') ?? '').toLowerCase() === 'cross-site') return false
  const origin = header(request.headers, 'origin')
  if (origin === undefined) return true
  try {
    const originUrl = new URL(origin)
    // Authority, not just hostname: a same-origin request matches scheme, host
    // AND port. The ported fence compared hostnames alone, so a page served by
    // any other loopback port counted as same-origin. (It still could not READ
    // the reply — no CORS headers are sent — but there is no reason to let it
    // through the fence either.)
    return originUrl.protocol === hostUrl.protocol && originUrl.host === hostUrl.host
  } catch {
    return false
  }
}

/** Response headers shared by every JSON reply (never cached: it is live state). */
const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
} as const
/** Write one JSON reply. */
function sendJson(res: SummaryHttpResponse, status: number, body: unknown, pollMs: number): void {
  res.writeHead(status, { ...JSON_HEADERS, [SUMMARY_POLL_HEADER]: String(pollMs) })
  res.end(JSON.stringify(body))
}

/** The wire shape the client consumes. */
export interface SummaryResponseBody {
  readonly sessionId: string
  readonly line: string
  readonly text: string
  readonly revision: number
  readonly at: number
}

/**
 * Build the route handler for {@link SUMMARY_ROUTE_PATH}.
 * @param options - registry and trusted hosts for the fence.
 * @returns a handler registering under {@link SUMMARY_ROUTE_PREFIX}.
 */
export function createSummaryRouteHandler(
  options: SummaryRouteOptions,
): (req: SummaryHttpRequest, res: SummaryHttpResponse) => void {
  const pollMs = Math.max(250, Math.round(options.pollMs ?? 1000))
  return (req, res) => {
    if (!isTrustedSummaryRequest(req, options.trustedHosts)) {
      sendJson(res, 403, { error: 'untrusted request' }, pollMs)
      return
    }
    if ((req.method ?? 'GET').toUpperCase() !== 'GET') {
      res.writeHead(405, { allow: 'GET', ...JSON_HEADERS, [SUMMARY_POLL_HEADER]: String(pollMs) })
      res.end(JSON.stringify({ error: 'method not allowed' }))
      return
    }
    const url = req.url ?? ''
    const query = url.indexOf('?') < 0 ? '' : url.slice(url.indexOf('?') + 1)
    const sessionId = new URLSearchParams(query).get('sessionId') ?? ''
    if (sessionId === '') {
      sendJson(res, 400, { error: 'sessionId is required' }, pollMs)
      return
    }
    // A session with no accepted summary yet is a normal state (the first
    // classification is still in flight, or the classifier is off), so it is a
    // 204 rather than an error: the client keeps showing the heuristic line.
    const snapshot: SummarySnapshot | undefined = options.registry.get(sessionId)
    if (snapshot === undefined) {
      res.writeHead(204, { 'cache-control': 'no-store', [SUMMARY_POLL_HEADER]: String(pollMs) })
      res.end()
      return
    }
    const body: SummaryResponseBody = {
      sessionId: snapshot.sessionId,
      line: snapshot.line,
      text: snapshot.text,
      revision: snapshot.revision,
      at: snapshot.at,
    }
    sendJson(res, 200, body, pollMs)
  }
}
