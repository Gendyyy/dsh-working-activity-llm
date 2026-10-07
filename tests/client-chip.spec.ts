/**
 * The dock row's paint loop: the one client-side link between an accepted
 * summary and the pixels.
 *
 * The component is hook-free on purpose (see WorkingLine.tsx), so it can be
 * invoked as a plain function — exactly how the bundle gate reads its tree —
 * and its imperative ticker driven with a fake element. That makes the whole
 * client contract testable without a DOM, a React renderer, or jsdom:
 *
 * - the heuristic line is what the row shows before any summary exists;
 * - an accepted summary REPLACES that text and marks the row;
 * - a settled phase attaches no ticker at all (no polling, no painting);
 * - detaching the ref stops the ticker;
 * - a failing route is invisible: the heuristic line stays and nothing throws.
 *
 * @module dsh-working-activity-llm/tests/client-chip
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WorkingLine } from '../src/client/WorkingLine.tsx'
import { summaryFeed, type ActivitySummary } from '../src/client/summary.ts'

/** A line with no elapsed segment, so its paint is time-independent. */
const HEURISTIC_LINE = 'mulling it over'

/** The projection value a live turn reads as. */
function liveView(overrides: Record<string, unknown> = {}) {
  return {
    phase: 'thinking',
    line: HEURISTIC_LINE,
    live: true,
    toolCount: 0,
    phaseStartedAt: 0,
    turnStartedAt: 0,
    updatedAt: 0,
    lang: 'en',
    ...overrides,
  }
}

/** The row attribute the ticker flips while a summary is on screen. */
const SEMANTIC_ATTR = 'data-activity-semantic'

/** A fake DOM node: only what the ticker touches. */
function fakeElement() {
  const attributes: Record<string, string> = {}
  const row = {
    attributes,
    title: '',
    setAttribute(name: string, value: string) { attributes[name] = value },
    removeAttribute(name: string) { delete attributes[name] },
  }
  const el = { textContent: '', parentElement: row }
  return { el, row }
}

/**
 * Render the dock entry as a plain function and pull its text-node ref out of
 * the returned tree, matching the shape the bundle gate already relies on.
 *
 * `ref` is read from BOTH places it can live: the JSX runtime lifts a reserved
 * `ref` prop onto the element itself (React reconciles from there), while a
 * hand-built element or a future runtime may leave it in `props`.
 */
function renderRow(view: unknown, sessionId: string | undefined) {
  const element = (WorkingLine as unknown as (props: unknown) => { props: { children: unknown[] } })({
    useProjection: () => view,
    sessionId,
  })
  const children = element.props.children as Array<{ ref?: unknown; props?: { ref?: unknown } }>
  const ref = children[1]?.ref ?? children[1]?.props?.ref
  if (typeof ref !== 'function') throw new Error('the row no longer exposes its text-node ref')
  return ref as (el: unknown) => void
}

/** One JSON body shaped like the route's 200 reply. */
function summaryResponse(line: string, text?: string): Response {
  const body: ActivitySummary = { line, text: text ?? line.replace(/^\S+\s/, ''), revision: 1, at: 1 }
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json', 'x-activity-poll-ms': '1000' },
  })
}

let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  vi.useFakeTimers()
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('dock row paint loop', () => {
  it('renders Claude Code spinner glyphs in a forward-and-back sequence', () => {
    const tree = (WorkingLine as unknown as (props: unknown) => { props: { children: unknown[] } })({
      useProjection: () => liveView(),
      sessionId: undefined,
    })
    const marker = tree.props.children[0] as { type: unknown; props: { children: unknown } }
    const spinner = marker.props.children as { type: unknown; props: { children: unknown } }
    const track = spinner.props.children as { props: { children: Array<{ props: { children: string } }> } }

    expect(marker.type).toBe('span')
    expect(spinner.type).toBe('span')
    expect(track.props.children.map(frame => frame.props.children)).toEqual([
      '·', '✢', '✳', '✶', '✻', '✽', '✽', '✻', '✶', '✳', '✢', '·',
    ])
  })

  it('omits the redundant tool-count badge in every phase', () => {
    const render = (view: unknown) =>
      (WorkingLine as unknown as (props: unknown) => { props: { children: unknown[] } })({
        useProjection: () => view,
        sessionId: undefined,
      })

    const active = render(liveView({ toolCount: 3 }))
    const finished = render(liveView({ phase: 'done', live: false, toolCount: 3 }))

    expect(active.props.children).toHaveLength(2)
    expect(finished.props.children).toHaveLength(2)
  })

  it('paints the heuristic line before any summary exists', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }))
    const { el, row } = fakeElement()

    renderRow(liveView(), 'session-heuristic')(el)

    // The first paint is synchronous: the row is never blank while waiting.
    expect(el.textContent).toBe(HEURISTIC_LINE)
    expect(row.attributes[SEMANTIC_ATTR]).toBeUndefined()
  })

  it('replaces the line with the summary and marks the row', async () => {
    fetchMock.mockResolvedValue(summaryResponse('✨ Investigating why the Snowflake connection is failing', 'Investigating why the Snowflake connection is failing'))
    const { el, row } = fakeElement()

    renderRow(liveView(), 'session-summary')(el)
    expect(el.textContent).toBe(HEURISTIC_LINE)

    await vi.advanceTimersByTimeAsync(1000)

    expect(el.textContent).toBe('✨ Investigating why the Snowflake connection is failing')
    expect(row.attributes[SEMANTIC_ATTR]).toBe('1')
    expect(row.title).toBe('Investigating why the Snowflake connection is failing')
  })

  it('keeps the heuristic line when the host has no summary yet', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }))
    const { el, row } = fakeElement()

    renderRow(liveView(), 'session-empty')(el)
    await vi.advanceTimersByTimeAsync(3000)

    expect(el.textContent).toBe(HEURISTIC_LINE)
    expect(row.attributes[SEMANTIC_ATTR]).toBeUndefined()
  })

  it('attaches no ticker for a settled phase', async () => {
    const { el } = fakeElement()

    renderRow(liveView({ live: false, phase: 'done', line: 'done and dusted' }), 'session-settled')(el)
    await vi.advanceTimersByTimeAsync(5000)

    // No polling, and no imperative paint: React owns the settled row.
    expect(fetchMock).not.toHaveBeenCalled()
    expect(el.textContent).toBe('')
  })

  it('stops polling once the row detaches', async () => {
    fetchMock.mockResolvedValue(summaryResponse('✨ Half-done work'))
    const { el } = fakeElement()
    const ref = renderRow(liveView(), 'session-detach')

    ref(el)
    // Ten ticks: comfortably past the shared feed's interval floor, so a live
    // ticker must have polled several times by now.
    await vi.advanceTimersByTimeAsync(10_000)
    const callsWhileAttached = fetchMock.mock.calls.length
    expect(callsWhileAttached).toBeGreaterThan(0)

    ref(null)
    await vi.advanceTimersByTimeAsync(10_000)

    expect(fetchMock.mock.calls.length).toBe(callsWhileAttached)
  })

  it('is invisible when the route fails: no throw, heuristic line intact', async () => {
    fetchMock.mockRejectedValue(new Error('network down'))
    const { el, row } = fakeElement()

    renderRow(liveView(), 'session-failing')(el)
    await vi.advanceTimersByTimeAsync(3000)

    expect(el.textContent).toBe(HEURISTIC_LINE)
    expect(row.attributes[SEMANTIC_ATTR]).toBeUndefined()
  })

  it('ignores a malformed body instead of painting it', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ line: '' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }))
    const { el, row } = fakeElement()

    renderRow(liveView(), 'session-malformed')(el)
    await vi.advanceTimersByTimeAsync(1000)

    expect(el.textContent).toBe(HEURISTIC_LINE)
    expect(row.attributes[SEMANTIC_ATTR]).toBeUndefined()
  })

  it('forgets a session on request without disturbing others', () => {
    summaryFeed.forget('session-gone')
    expect(summaryFeed.current('session-gone')).toBeUndefined()
    expect(summaryFeed.cadenceMs).toBeGreaterThanOrEqual(250)
  })
})
