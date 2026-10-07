/**
 * The summary feed's failure policy.
 *
 * The channel is an auxiliary nicety: if it cannot be reached, the chip must
 * quietly keep the heuristic line. What it must NOT do is retry at the tick
 * rate for the length of a turn — a renderer origin the host cannot serve, a
 * restarting host, or a proxy in the way would otherwise cost one failed
 * request per second, forever.
 *
 * Every case drives the feed through its injected clock, so the whole ladder is
 * deterministic and no timers are involved.
 * @module dsh-working-activity-llm/tests/client-summary-feed
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MAX_BACKOFF_MS, SummaryFeed } from '../src/client/summary.ts'

/**
 * A realistic wall-clock base. The feed's cadence is relative, so an arbitrary
 * epoch is fine — and starting at a real time keeps the tests honest about the
 * one thing it does assume: that `now` is a wall clock.
 */
const T0 = 1_700_000_000_000

let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

/** Walk `seconds` of virtual time, polling once per second as the ticker would. */
async function pollFor(feed: SummaryFeed, sessionId: string, seconds: number): Promise<number> {
  for (let second = 0; second <= seconds; second += 1) await feed.poll(sessionId, T0 + second * 1000)
  return fetchMock.mock.calls.length
}

describe('SummaryFeed failure policy', () => {
  it('backs off geometrically instead of retrying every tick', async () => {
    fetchMock.mockRejectedValue(new Error('unreachable'))
    const feed = new SummaryFeed()

    // Twenty ticks: at 1 Hz that would be 21 requests. The ladder must cut it
    // to a handful (1 s, 2 s, 4 s, 8 s, 16 s …).
    const attempts = await pollFor(feed, 'session-backoff', 20)

    expect(attempts).toBeGreaterThan(0)
    expect(attempts).toBeLessThanOrEqual(5)
  })

  it('caps the backoff at the ceiling', async () => {
    fetchMock.mockRejectedValue(new Error('unreachable'))
    const feed = new SummaryFeed()

    // Saturate the ladder (six doublings reach the ceiling), then measure the gap.
    let now = T0
    for (let attempt = 0; attempt < 10; attempt += 1) {
      await feed.poll('session-ceiling', now)
      now += MAX_BACKOFF_MS
    }
    const before = fetchMock.mock.calls.length
    // One millisecond short of the ceiling-sized gap must not fire…
    await feed.poll('session-ceiling', now - MAX_BACKOFF_MS + (MAX_BACKOFF_MS - 1))
    expect(fetchMock.mock.calls.length).toBe(before)
    // …while the full gap must.
    await feed.poll('session-ceiling', now + 1)
    expect(fetchMock.mock.calls.length).toBe(before + 1)
  })

  it('recovers the moment a request succeeds', async () => {
    fetchMock.mockRejectedValue(new Error('unreachable'))
    const feed = new SummaryFeed()
    await pollFor(feed, 'session-recover', 20)

    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      line: '✨ Investigating the failing connection',
      text: 'Investigating the failing connection',
      revision: 1,
      at: 1,
    }), { status: 200, headers: { 'content-type': 'application/json' } }))

    await pollFor(feed, 'session-recover', 60)

    expect(feed.current('session-recover')?.line).toBe('✨ Investigating the failing connection')
  })

  it('stops for good when the route is absent (403/404)', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 404 }))
    const feed = new SummaryFeed()

    await feed.poll('session-absent', T0)
    const afterFirst = fetchMock.mock.calls.length
    for (let offset = 1000; offset <= 600_000; offset += 1000) await feed.poll('session-absent', T0 + offset)

    expect(fetchMock.mock.calls.length).toBe(afterFirst)
  })

  it('keeps retrying a transient server error', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 503 }))
    const feed = new SummaryFeed()

    await feed.poll('session-503', T0)
    await feed.poll('session-503', T0 + 60_000)

    expect(fetchMock.mock.calls.length).toBeGreaterThan(1)
  })

  it('treats 204 as a success, so the ladder resets', async () => {
    fetchMock.mockRejectedValueOnce(new Error('blip'))
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }))
    const feed = new SummaryFeed()

    await feed.poll('session-reset', T0)               // fails, arms a 2 s gap
    await feed.poll('session-reset', T0 + 2000)        // succeeds (204); ladder reset
    const afterReset = fetchMock.mock.calls.length
    await feed.poll('session-reset', T0 + 3000)        // one normal cadence later: due again

    expect(fetchMock.mock.calls.length).toBe(afterReset + 1)
  })

  it('never throws and never rejects when the network is gone', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'))
    const feed = new SummaryFeed()

    await expect(feed.poll('session-safe', T0)).resolves.toBeUndefined()
    expect(feed.current('session-safe')).toBeUndefined()
  })
})
