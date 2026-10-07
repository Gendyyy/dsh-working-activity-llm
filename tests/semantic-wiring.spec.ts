/**
 * Host-wiring integration for the semantic activity chip: the plugin's REAL
 * `apply(ctx, config)` is driven end-to-end against mocked host services, so
 * only the host boundary is faked.
 *
 * What is real here
 * -----------------
 * - the plugin itself (`../src/index`) and every module it wires: the
 *   classifier policy (`../src/semantic`), the LLM transport
 *   (`../src/llm-summarizer`, including `BlockAssembler` and `deadline`), the
 *   summary registry, and the HTTP route handler;
 * - the cordis `Context` — a genuine `new Context()` from
 *   `@deepseek-ai/cordis`, mounted with `ctx.plugin(...)`, so schema defaults,
 *   `ctx.effect` disposers and `ctx.inject` availability gating are the
 *   host's own, not a re-implementation.
 *
 * What is faked, and why
 * ----------------------
 * Only the host services `apply` reaches for through `ctx.get` / `ctx.inject`
 * are plain objects, because mounting the real DSH runtime (llm adapters, web
 * server, agent loop) would need network, a socket and a model:
 * - `llm`        — `{ stream(options) }`, the exact slice `createLlmSummarizer`
 *                  calls. It records every request and plays a canned chunk
 *                  stream; no provider, no network.
 * - `webServer`  — `{ register(route) }`, capturing the route the plugin
 *                  registers so the test can invoke the REAL handler.
 * - `webRuntime` — `{ trustedHosts: [] }`, the trust fence's input.
 * A fake `Session` supplies the fields the plugin reads: `id`,
 * `requestHeader()`, and a no-op `append` (the last is only touched when
 * `publish: true`, which these tests leave off).
 *
 * Dispatch timing: `semanticDebounceMs: 0` / `semanticMinIntervalMs: 0` make
 * the classifier's own `setTimeout(0)` fire immediately on the real clock, so
 * the tests poll a couple of macrotask turns instead of moving a fake clock.
 *
 * NOTE ON `src/` DRIFT (observed while writing this file): `src/semantic.ts`
 * now aborts the pending dispatch on ANY settled (`idle`/`done`) phase report,
 * even an unchanged one, so a lone `user/message` on an idle tracker dispatches
 * nothing until the turn leaves idle; and `src/llm-summarizer.ts` now passes
 * `sessionId` on purpose (provider routing metadata) with a 512-token budget.
 * Both are asserted here as they actually behave. See the accompanying report.
 * @module @deepseek-ai/dsh-working-activity/tests/semantic-wiring
 */

import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import * as WorkingActivity from '../src/index'
import { SUMMARY_MAX_OUTPUT_TOKENS } from '../src/llm-summarizer'

// ── Fixture constants ────────────────────────────────────────────────────────

const SESSION_ID = 'sess-wiring-1'
const UNKNOWN_SESSION_ID = 'sess-nobody-home'
const TRUSTED_HOST = '127.0.0.1:19387'
const SUMMARY_URL = '/working-activity-llm/summary'
const SUMMARY_PREFIX = '/working-activity-llm'
const USER_TEXT = 'Investigate why the Snowflake connection keeps failing'
const BASH_ARGS = JSON.stringify({ command: "psql -c 'select 1'" })
const BASH_DETAIL = "psql -c 'select 1'"
/** Route the fake session's `requestHeader()` reports. */
const SESSION_ROUTE = { provider: 'p', model: 'm' }

/** Config that makes the debounce/interval floor vacuous without fake timers. */
const FAST = { semantic: true, semanticDebounceMs: 0, semanticMinIntervalMs: 0 } as const

// ── Fake host services ───────────────────────────────────────────────────────

/** One model call script: the chunk stream for a request. */
type StreamScript = (options: GenerateOptions) => AsyncIterable<StreamChunk>

/** The `llm` service slice the classifier uses, recording every request. */
class FakeLlm {
  readonly requests: GenerateOptions[] = []

  constructor(private readonly script: StreamScript) {}

  stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    return this.script(options)
  }
}

/** One captured route registration. */
interface CapturedRoute {
  kind: 'exact' | 'prefix'
  path: string
  handler: (req: FakeRequest, res: FakeResponse) => void | Promise<void>
}

/** The `webServer` service slice: `register` is the only member `apply` uses. */
class FakeWebServer {
  readonly routes: CapturedRoute[] = []

  register(route: CapturedRoute): () => void {
    this.routes.push(route)
    return () => {}
  }
}

interface FakeRequest {
  method?: string
  url?: string
  headers: Record<string, string | string[] | undefined>
}

/** Minimal node-response double: records the status, headers and body. */
class FakeResponse {
  statusCode = 0
  readonly headers: Record<string, string> = {}
  body = ''

  writeHead(status: number, headers: Record<string, string> = {}): void {
    this.statusCode = status
    Object.assign(this.headers, headers)
  }

  end(body?: string | Uint8Array): void {
    if (body === undefined) return
    this.body = typeof body === 'string' ? body : Buffer.from(body).toString('utf8')
  }
}

/** The `Session` slice the plugin reads. */
interface FakeSession {
  readonly id: string
  readonly route: { provider: string; model: string }
  requestHeader(): { config: { provider: string; model: string } } | undefined
  append(): void
}

function fakeSession(id: string = SESSION_ID, route = SESSION_ROUTE): FakeSession {
  return {
    id,
    route,
    requestHeader: () => ({ config: route }),
    append: () => {},
  }
}

// ── Session event fixtures ───────────────────────────────────────────────────

/** A durable `user/message` whose content blocks carry the intent anchor. */
function userMessageEvent(text: string): unknown {
  return {
    type: 'user/message',
    time: Date.now(),
    data: { content: [{ type: 'text', text }] },
  }
}

/** A durable `tool/call` the classifier should cite as evidence of intent. */
function toolCallEvent(callId: string, name: string, args: string): unknown {
  return {
    type: 'tool/call',
    time: Date.now(),
    data: { callId, name, arguments: args },
  }
}

/** Emit one durable session event (the plugin's `session/event` listener). */
function emitSession(ctx: Context, session: unknown, event: unknown): void {
  (ctx as unknown as { emit(name: string, ...args: unknown[]): void }).emit('session/event', session, event)
}

/** Emit the host's session-disposal signal (its own event, not session/event). */
function emitDisposed(ctx: Context, session: unknown): void {
  (ctx as unknown as { emit(name: string, ...args: unknown[]): void }).emit('session/disposed', session)
}

/**
 * The smallest real turn: the user's ask, then the tool it triggered.
 *
 * The tool event is load-bearing for dispatch, not decoration: the tracker is
 * still `idle` after a lone `user/message`, and the current classifier aborts
 * its pending debounce on a settled phase report (see the module note).
 */
function emitTurn(ctx: Context, session: unknown, userText: string = USER_TEXT): void {
  emitSession(ctx, session, userMessageEvent(userText))
  emitSession(ctx, session, toolCallEvent('call-1', 'bash', BASH_ARGS))
}

// ── Chunk fixtures (the raw adapter vocabulary) ──────────────────────────────

/** A complete, successful one-block text response. */
function stopChunks(text: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'usage', usage: { inputTokens: 3, outputTokens: text.length } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

/** A stream that ends in a terminal provider failure chunk. */
function errorChunks(): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: 'Invest' },
    {
      type: 'finish',
      reason: { kind: 'error', failure: { message: 'rate limited', code: 'RATE_LIMIT' } },
    },
  ]
}

function textStream(text: string): StreamScript {
  return async function* () {
    for (const chunk of stopChunks(text)) yield chunk
  }
}

function errorStream(): StreamScript {
  return async function* () {
    for (const chunk of errorChunks()) yield chunk
  }
}

// ── Harness ──────────────────────────────────────────────────────────────────

interface Harness {
  readonly ctx: Context
  readonly llm: FakeLlm | undefined
  readonly webServer: FakeWebServer
  dispose(): Promise<void>
}

interface MountOptions {
  config?: Record<string, unknown>
  llm?: FakeLlm
  /** Set false to mount without the `webServer` service (fail-open path). */
  webServer?: boolean
  webRuntime?: boolean
}

function provideService(ctx: Context, name: string, value: unknown): void {
  (ctx as unknown as { provide(name: string, value: unknown): unknown }).provide(name, value)
}

const mounted: Harness[] = []

/**
 * Build a real cordis context, provide the fake host services, and mount the
 * plugin through it. `ctx.plugin` is awaited so a throwing `apply` fails the
 * test at the mount rather than being swallowed.
 */
async function mount(options: MountOptions = {}): Promise<Harness> {
  const ctx = new Context()
  const webServer = new FakeWebServer()
  if (options.llm !== undefined) provideService(ctx, 'llm', options.llm)
  if (options.webServer !== false) provideService(ctx, 'webServer', webServer)
  if (options.webRuntime !== false) provideService(ctx, 'webRuntime', { trustedHosts: [] })

  const fiber = await (ctx as unknown as {
    plugin(plugin: unknown, config?: unknown): PromiseLike<{ dispose: () => Promise<void> }>
  }).plugin(WorkingActivity, { ...options.config })

  let disposed = false
  const harness: Harness = {
    ctx,
    llm: options.llm,
    webServer,
    async dispose() {
      if (disposed) return
      disposed = true
      await fiber.dispose()
    },
  }
  mounted.push(harness)
  return harness
}

afterEach(async () => {
  while (mounted.length > 0) await mounted.pop()?.dispose()
})

// ── Async helpers ────────────────────────────────────────────────────────────

/** Give the real event loop a few turns (microtasks + the classifier's timer). */
async function settle(ms = 25): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms))
}

/** Poll a predicate on the real clock, yielding a macrotask between checks. */
async function waitFor(predicate: () => boolean, label: string, timeoutMs = 1000): Promise<void> {
  const stopAt = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > stopAt) throw new Error(`timed out waiting for ${label}`)
    await new Promise(resolve => setTimeout(resolve, 0))
  }
}

/** The framed classifier prompt carried by a recorded request. */
function framedText(options: GenerateOptions): string {
  const content = (options.messages[0] as unknown as {
    content?: ReadonlyArray<{ type?: string; text?: string }>
  }).content
  return (content ?? [])
    .filter(block => block.type === 'text')
    .map(block => block.text ?? '')
    .join('')
}

interface SummaryRead {
  status: number
  body: Record<string, unknown>
}

/**
 * The plugin's summary route. Looked up by path, not by index: a semantic mount
 * registers the models directory route beside it.
 */
function summaryRoute(harness: Harness): CapturedRoute | undefined {
  return harness.webServer.routes.find(route => route.kind === 'prefix' && route.path === SUMMARY_PREFIX)
}

/** Call the plugin's registered route handler as a trusted browser would. */
function readSummary(harness: Harness, sessionId: string): SummaryRead {
  const route = summaryRoute(harness)
  if (route === undefined) throw new Error('the plugin registered no summary route')
  const res = new FakeResponse()
  route.handler(
    {
      method: 'GET',
      url: `${SUMMARY_URL}?sessionId=${encodeURIComponent(sessionId)}`,
      headers: { host: TRUSTED_HOST },
    },
    res,
  )
  return {
    status: res.statusCode,
    body: res.body === '' ? {} : JSON.parse(res.body) as Record<string, unknown>,
  }
}

/**
 * The activity lines the framed prose prompt hands the model, oldest first.
 *
 * The prompt is prose now (`Prior updates … / New activity … / closing`), so the
 * test reads the bulleted delta straight out of the "New activity" section
 * instead of parsing JSON.
 */
function framedActivity(options: GenerateOptions): string[] {
  const framed = framedText(options)
  const marker = 'New activity since the last accepted update:'
  const start = framed.indexOf(marker)
  if (start === -1) return []
  return framed
    .slice(start + marker.length)
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.startsWith('- '))
    .map(line => line.slice(2))
    .filter(line => line !== 'none')
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('semantic activity chip — host wiring', () => {
  it('feeds the classifier the real turn activity, on the session route', async () => {
    const llm = new FakeLlm(textStream('Investigating the failing Snowflake connection'))
    const harness = await mount({ config: { ...FAST }, llm })
    const session = fakeSession()

    emitTurn(harness.ctx, session)

    await waitFor(() => llm.requests.length === 1, 'the classifier dispatch')
    const request = llm.requests[0]!

    // Route came from `session.requestHeader()`, not from config.
    expect(request.provider).toBe('p')
    expect(request.model).toBe('m')

    // The user's own words and the tool name/detail reached the framed prompt.
    const framed = framedText(request)
    expect(framed).toContain('New activity since the last accepted update:')
    expect(framed).toContain(USER_TEXT)
    expect(framed).toContain('bash')
    expect(framed).toContain(BASH_DETAIL)
    // The delta is handed over as raw activity lines, oldest first.
    expect(framedActivity(request)).toEqual([
      `user: ${USER_TEXT}`,
      `tool: bash ${BASH_DETAIL}`,
    ])

    // It is the classifier call, not the session's own turn: the request
    // carries the narration system prompt and a one-shot user input.
    expect(request.system).toContain('Write one plain-English progress update for a coding agent.')
    expect(request.maxTokens).toBe(SUMMARY_MAX_OUTPUT_TOKENS)
    expect((request.messages[0] as unknown as { source?: { kind?: string } }).source?.kind)
      .toBe('working-activity-llm')
  })

  it('tags the auxiliary call with the session id (routing metadata, as src currently does)', async () => {
    // The `src/llm-summarizer.ts` contract today: the session id travels with
    // the request because adapters use it as provider routing metadata
    // (`opencode-go` answers 400 `MissingSessionID` without it). The wiring
    // must therefore hand the classifier the session's OWN id — never another
    // session's, and never a fabricated one.
    const llm = new FakeLlm(textStream('Checking the failing connection'))
    const harness = await mount({ config: { ...FAST }, llm })

    emitTurn(harness.ctx, fakeSession('sess-routing-42'))
    await waitFor(() => llm.requests.length === 1, 'the classifier dispatch')

    expect(llm.requests[0]!.sessionId).toBe('sess-routing-42')
  })

  it("dispatches on the user's own ask before the turn leaves idle", async () => {
    // The host reports the phase again on the fold that carries the user's
    // message, and between turns that is a repeat of `idle`. A repeated phase
    // report must not cancel the immediate dispatch the ask just armed: the chip
    // has to be able to say what the new request is about from the first moment
    // the turn shows that it is working.
    const llm = new FakeLlm(textStream('Investigating the failing Snowflake connection'))
    const harness = await mount({ config: { ...FAST }, llm })
    const session = fakeSession()

    emitSession(harness.ctx, session, userMessageEvent(USER_TEXT))
    await waitFor(() => llm.requests.length === 1, "the dispatch for the user's ask")
    expect(framedActivity(llm.requests[0]!)).toEqual([`user: ${USER_TEXT}`])
  })

  it('serves the accepted summary from the registered route, and 204 for an unknown session', async () => {
    const llm = new FakeLlm(textStream('Investigating the failing Snowflake connection'))
    const harness = await mount({ config: { ...FAST }, llm })
    const session = fakeSession()

    emitTurn(harness.ctx, session)
    await waitFor(() => summaryRoute(harness) !== undefined, 'the summary route')
    await waitFor(() => readSummary(harness, SESSION_ID).status === 200, 'the summary to land')

    const route = summaryRoute(harness)!
    expect(route.kind).toBe('prefix')
    expect(route.path).toBe(SUMMARY_PREFIX)

    const { status, body } = readSummary(harness, SESSION_ID)
    expect(status).toBe(200)
    expect(body.sessionId).toBe(SESSION_ID)
    expect(body.line).toBe('✨ Investigating the failing Snowflake connection')
    expect(body.text).toBe('Investigating the failing Snowflake connection')
    expect(body.revision).toBe(1)
    expect(typeof body.at).toBe('number')

    // No accepted summary for a session the registry never heard of.
    expect(readSummary(harness, UNKNOWN_SESSION_ID).status).toBe(204)
  })

  it('registers the models directory route beside the summary route', async () => {
    const harness = await mount({ config: { ...FAST }, llm: new FakeLlm(textStream('pick me')) })

    // The Plugins page reads this route for its model dropdown, so it must be
    // mounted whenever the summary route is: the two are one feature.
    expect(harness.webServer.routes.map(route => `${route.kind} ${route.path}`).sort()).toEqual([
      'exact /working-activity-llm/models',
      'prefix /working-activity-llm',
    ])
  })

  it('refuses an untrusted Host on the registered route', async () => {
    const llm = new FakeLlm(textStream('Investigating the failing Snowflake connection'))
    const harness = await mount({ config: { ...FAST }, llm })
    emitTurn(harness.ctx, fakeSession())
    await waitFor(() => readSummary(harness, SESSION_ID).status === 200, 'the summary to land')

    const res = new FakeResponse()
    summaryRoute(harness)!.handler(
      {
        method: 'GET',
        url: `${SUMMARY_URL}?sessionId=${SESSION_ID}`,
        headers: { host: 'evil.example.com' },
      },
      res,
    )
    expect(res.statusCode).toBe(403)
  })

  it('makes no model call and registers no route when the feature is off', async () => {
    const llm = new FakeLlm(textStream('this must never be requested'))
    const harness = await mount({
      config: { semantic: false, semanticDebounceMs: 0, semanticMinIntervalMs: 0 },
      llm,
    })

    emitTurn(harness.ctx, fakeSession())
    await settle()

    expect(llm.requests).toHaveLength(0)
    expect(harness.webServer.routes).toHaveLength(0)
  })

  it('aborts the in-flight classifier and publishes nothing after session/disposed', async () => {
    let captured: AbortSignal | undefined
    const llm = new FakeLlm(async function* (options) {
      captured = options.signal
      yield { type: 'block-start', index: 0, blockType: 'text' } as StreamChunk
      yield { type: 'text-delta', index: 0, text: 'Invest' } as StreamChunk
      // Park until the transport is cancelled — the classifier's abort has to
      // reach this signal, or the wait below times out.
      await new Promise<void>(resolve => {
        if (options.signal?.aborted === true) {
          resolve()
          return
        }
        options.signal?.addEventListener('abort', () => resolve(), { once: true })
      })
      // A late, otherwise-valid answer must not paint a dead session's chip.
      yield {
        type: 'block-end',
        index: 0,
        block: { type: 'text', text: 'Investigating the failing Snowflake connection' },
      } as StreamChunk
      yield { type: 'finish', reason: { kind: 'stop' } } as StreamChunk
    })
    const harness = await mount({ config: { ...FAST }, llm })
    const session = fakeSession()

    emitTurn(harness.ctx, session)
    await waitFor(() => llm.requests.length === 1, 'the classifier dispatch')
    await waitFor(() => captured !== undefined, 'the stream signal')
    expect(captured?.aborted).toBe(false)

    emitDisposed(harness.ctx, session)
    await waitFor(() => captured?.aborted === true, 'the classifier abort')

    await settle()
    await waitFor(() => summaryRoute(harness) !== undefined, 'the summary route')
    expect(readSummary(harness, SESSION_ID).status).toBe(204)
    // Nothing re-dispatched the dead session.
    expect(llm.requests).toHaveLength(1)
  })

  it('fails open when the model stream throws: no summary, no unhandled rejection', async () => {
    const rejections: unknown[] = []
    const onRejection = (reason: unknown): void => {
      rejections.push(reason)
    }
    process.on('unhandledRejection', onRejection)
    try {
      const llm = new FakeLlm(async function* () {
        throw new Error('provider blew up')
      })
      // A throwing `apply` would reject the mount, so reaching the assertions
      // is itself the "apply does not throw" half of the property.
      const harness = await mount({ config: { ...FAST }, llm })
      const session = fakeSession()

      emitTurn(harness.ctx, session)
      await waitFor(() => llm.requests.length === 1, 'the classifier dispatch')
      await waitFor(() => summaryRoute(harness) !== undefined, 'the summary route')
      await settle()

      expect(rejections).toEqual([])
      expect(readSummary(harness, SESSION_ID).status).toBe(204)
    } finally {
      process.off('unhandledRejection', onRejection)
    }
  })

  it('fails open when the stream ends in a terminal error chunk', async () => {
    const rejections: unknown[] = []
    const onRejection = (reason: unknown): void => {
      rejections.push(reason)
    }
    process.on('unhandledRejection', onRejection)
    try {
      const llm = new FakeLlm(errorStream())
      const harness = await mount({ config: { ...FAST }, llm })
      const session = fakeSession()

      emitTurn(harness.ctx, session)
      await waitFor(() => llm.requests.length === 1, 'the classifier dispatch')
      await waitFor(() => summaryRoute(harness) !== undefined, 'the summary route')
      await settle()

      expect(rejections).toEqual([])
      expect(readSummary(harness, SESSION_ID).status).toBe(204)
    } finally {
      process.off('unhandledRejection', onRejection)
    }
  })

  it('cleans hostile model output end-to-end before the route serves it', async () => {
    // A laboured reply: a leading label, wrapping quotes, a sentence period, a
    // code fence and trailing prose. Only the phrase may survive.
    const hostile = 'Summary: "Investigating why the Snowflake connection is failing."\n```\nmore text'
    const llm = new FakeLlm(textStream(hostile))
    const harness = await mount({ config: { ...FAST }, llm })

    emitTurn(harness.ctx, fakeSession())
    await waitFor(() => readSummary(harness, SESSION_ID).status === 200, 'the cleaned summary')

    const { body } = readSummary(harness, SESSION_ID)
    const line = body.line as string
    expect(line).toBe('✨ Investigating why the Snowflake connection is failing')
    expect(body.text).toBe('Investigating why the Snowflake connection is failing')
    expect(line.startsWith('✨ ')).toBe(true)
    expect(line).not.toContain('"')
    expect(line).not.toContain('Summary')
    expect(line).not.toContain('```')
    expect(line.endsWith('.')).toBe(false)
  })

  it('skips a leading bare code fence instead of discarding the whole reply', async () => {
    // Formerly a gap (pinned here as such): `sanitizeSummary` took the first
    // non-empty line, so a model that opened with a fence line cleaned to '' and
    // the entire reply — including a perfectly good phrase on the next line —
    // was thrown away. It now scans for the first line that survives cleaning
    // WITH content, so the phrase is served.
    const hostile = '```\nSummary: "Investigating why the Snowflake connection is failing."\nmore text'
    const llm = new FakeLlm(textStream(hostile))
    const harness = await mount({ config: { ...FAST }, llm })

    emitTurn(harness.ctx, fakeSession())
    await waitFor(() => readSummary(harness, SESSION_ID).status === 200, 'the cleaned summary')

    const { body } = readSummary(harness, SESSION_ID)
    expect(body.line).toBe('✨ Investigating why the Snowflake connection is failing')
    expect(body.line).not.toContain('```')
    expect(body.line).not.toContain('Summary')
  })

  it('drops a reply whose lines are all structure', async () => {
    // The other side of the same rule: if nothing survives cleaning, no summary
    // is published and the chip keeps the heuristic line.
    const llm = new FakeLlm(textStream('```\n---\n```'))
    const harness = await mount({ config: { ...FAST }, llm })

    emitTurn(harness.ctx, fakeSession())
    await waitFor(() => llm.requests.length === 1, 'the classifier dispatch')
    await settle()

    expect(readSummary(harness, SESSION_ID).status).toBe(204)
  })
})
