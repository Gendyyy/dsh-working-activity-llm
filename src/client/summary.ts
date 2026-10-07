/**
 * Browser half of the semantic activity chip: fetch the host's accepted
 * summary for the current session and cache it for the row to paint.
 *
 * Why not `useProjection`: the `workingActivity` projection is the right
 * transport for values derived from the session log, but its publication is
 * gated on a *committed session event* whose recomputed view differs by
 * `Object.is`. A classifier answer lands between events — typically while a
 * long tool is running and nothing else has been committed — so the summary
 * needs a channel with its own cadence. It reads the host route instead and
 * keeps the heuristic line as the fallback it paints until a summary arrives.
 *
 * The module is deliberately hook-free and framework-free: the row's component
 * already runs one imperative ticker (see `WorkingLine.tsx`) and this feed is
 * just the data half of it. Everything here fails open — any error, a 403, a
 * 204, a missing session id, or a body that does not look like a summary leaves
 * the previous value in place, and the chip simply keeps showing the line.
 * @module dsh-working-activity-llm/client/summary
 */

/** Route the host plugin registers; must match `src/summary-route.ts`. */
export const SUMMARY_ROUTE_PATH = '/working-activity-llm/summary'

/** Header the host uses to advertise the configured poll cadence. */
export const SUMMARY_POLL_HEADER = 'x-activity-poll-ms'

/** Default cadence when the host does not advertise one. */
export const DEFAULT_POLL_MS = 1000

/** Ceiling for the failure backoff, so a broken route cannot be hammered at 1 Hz. */
export const MAX_BACKOFF_MS = 30_000

/** One accepted summary as the chip renders it. */
export interface ActivitySummary {
  /** Chip copy with the icon prefix already applied by the host. */
  readonly line: string
  /** Cleaned summary without the prefix (diagnostics/accessibility). */
  readonly text: string
  /** Host-side monotonic revision. */
  readonly revision: number
  /** Epoch ms the host accepted the summary. */
  readonly at: number
}

/** Whether one parsed body is a usable summary. */
function asSummary(value: unknown): ActivitySummary | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const candidate = value as { line?: unknown; text?: unknown; revision?: unknown; at?: unknown }
  if (typeof candidate.line !== 'string' || candidate.line.trim() === '') return undefined
  return {
    line: candidate.line,
    text: typeof candidate.text === 'string' ? candidate.text : candidate.line,
    revision: typeof candidate.revision === 'number' ? candidate.revision : 0,
    at: typeof candidate.at === 'number' ? candidate.at : 0,
  }
}

/**
 * One session's summary feed.
 *
 * Holds the last accepted value per session (so a row that re-renders can paint
 * immediately) and at most one in-flight request at a time (so a slow host
 * cannot queue up requests behind a 1 s ticker).
 */
export class SummaryFeed {
  private readonly cache = new Map<string, ActivitySummary>()
  private inFlight?: { readonly sessionId: string; readonly controller: AbortController }
  /**
   * When the last request was attempted.
   *
   * Starts at negative infinity rather than 0 so the very first poll is always
   * due: with a wall clock this makes no difference, but it removes any
   * dependence on the clock being large (an injected clock starting at 0 would
   * otherwise throttle the first request away).
   */
  private lastPolledAt = Number.NEGATIVE_INFINITY
  private pollMs = DEFAULT_POLL_MS
  /** Set when the route answered 403/404 — it is absent by design; stop asking. */
  private unavailable = false
  /** Consecutive transient failures, driving {@link nextAttemptAt}. */
  private failures = 0
  /** Earliest time the next request may be attempted after a failure. */
  private nextAttemptAt = 0

  constructor(private readonly routePath: string = SUMMARY_ROUTE_PATH) {}

  /** The cadence the host asked for, in ms. */
  get cadenceMs(): number {
    return this.pollMs
  }

  /**
   * The last accepted summary for one session, if any.
   * @param sessionId - session to read.
   */
  current(sessionId: string | undefined): ActivitySummary | undefined {
    return sessionId === undefined ? undefined : this.cache.get(sessionId)
  }

  /**
   * Back off after a transient failure instead of retrying at the tick rate.
   *
   * A route that is unreachable (a renderer origin the host cannot serve, a
   * proxy in the way, a restarting host) would otherwise cost one failed
   * request per second for as long as a turn runs. Doubling to
   * {@link MAX_BACKOFF_MS} keeps the chip honest while making the waste
   * negligible, and any success resets the ladder immediately.
   */
  private backOff(now: number): void {
    this.failures = Math.min(this.failures + 1, 6)
    this.nextAttemptAt = now + Math.min(this.pollMs * 2 ** this.failures, MAX_BACKOFF_MS)
  }

  /**
   * Poll the host when the cadence allows it.
   *
   * Never throws and never rejects: the caller is a paint loop, and a status
   * line must not be able to break a conversation view.
   * @param sessionId - session to poll for.
   * @param now - current epoch ms (injected so the cadence is testable).
   * @returns the freshest known summary, or undefined.
   */
  async poll(sessionId: string | undefined, now: number = Date.now()): Promise<ActivitySummary | undefined> {
    if (sessionId === undefined || this.unavailable) return this.current(sessionId)
    const cached = this.cache.get(sessionId)
    if (this.inFlight !== undefined) return cached
    if (now < this.nextAttemptAt) return cached
    if (now - this.lastPolledAt < this.pollMs) return cached
    this.lastPolledAt = now
    const controller = new AbortController()
    this.inFlight = { sessionId, controller }
    try {
      const response = await fetch(`${this.routePath}?sessionId=${encodeURIComponent(sessionId)}`, {
        method: 'GET',
        headers: { accept: 'application/json' },
        signal: controller.signal,
        credentials: 'same-origin',
      })
      const advertised = Number(response.headers.get(SUMMARY_POLL_HEADER))
      if (Number.isFinite(advertised) && advertised >= 250) this.pollMs = advertised
      // 204 = "no summary yet" and is the normal first few seconds of a turn.
      // It is a successful exchange: reset the failure ladder.
      if (response.status === 204) {
        this.failures = 0
        return this.cache.get(sessionId)
      }
      if (!response.ok) {
        // 403/404 mean the route is not published here at all — no amount of
        // retrying will change that, so stop for this page's lifetime.
        if (response.status === 403 || response.status === 404) this.unavailable = true
        else this.backOff(now)
        return this.cache.get(sessionId)
      }
      const summary = asSummary(await response.json() as unknown)
      if (summary !== undefined) this.cache.set(sessionId, summary)
      this.failures = 0
      return this.cache.get(sessionId)
    } catch {
      // Aborted, offline, or an origin the host does not serve: keep the cache
      // and slow down rather than retrying at the tick rate.
      this.backOff(now)
      return this.cache.get(sessionId)
    } finally {
      if (this.inFlight?.controller === controller) this.inFlight = undefined
    }
  }

  /**
   * Forget one session (its row is gone or the session ended).
   * @param sessionId - session to drop.
   */
  forget(sessionId: string | undefined): void {
    if (sessionId === undefined) return
    this.cache.delete(sessionId)
    if (this.inFlight?.sessionId === sessionId) {
      this.inFlight.controller.abort()
      this.inFlight = undefined
    }
  }
}

/** Process-wide feed: exactly one dock row renders at a time. */
export const summaryFeed = new SummaryFeed()
