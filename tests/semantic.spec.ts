/**
 * Semantic classifier tests: context accumulation, debounce/interval policy,
 * in-flight coalescing, output cleaning and prompt framing.
 *
 * The model call is injected, so every test drives time through the injected
 * clock and asserts on the exact sequence of contexts the classifier handed to
 * `summarize` — that sequence is the proof of the coalescing policy.
 * @module @deepseek-ai/dsh-working-activity/tests/semantic
 */

import { afterEach, describe, expect, it } from 'vitest'
import {
  INTENT_MAX_CHARS,
  SEMANTIC_DEFAULTS,
  SemanticActivityClassifier,
  frameContext,
  renderSummary,
  sanitizeSummary,
  systemPrompt,
  type SemanticClassifierOptions,
  type SemanticContext,
  type SemanticSummary,
} from '../src/semantic.ts'

/** Classifiers built by {@link createHarness}, disposed after every test. */
const live: SemanticActivityClassifier[] = []

afterEach(() => {
  while (live.length > 0) live.pop()?.dispose()
})

/** Deterministic clock: time advances only when told. */
function fixedClock(): { now: () => number; advance: (ms: number) => void } {
  let current = 1_700_000_000_000
  return {
    now: () => current,
    advance: (ms: number) => { current += ms },
  }
}

/** A promise whose settlement the test controls. */
interface Deferred<T> {
  readonly promise: Promise<T>
  readonly resolve: (value: T) => void
  readonly reject: (error: unknown) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/** Drain macrotasks so any armed debounce timer has a chance to run. */
async function settle(times = 6): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await new Promise<void>(resolve => { setTimeout(resolve, 0) })
  }
}

/** Poll until a condition holds; the budget is generous so it cannot flake. */
async function waitFor(predicate: () => boolean, budgetMs = 2_000): Promise<void> {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > budgetMs) throw new Error('waitFor: condition never held')
    await new Promise<void>(resolve => { setTimeout(resolve, 1) })
  }
}

type HarnessOverrides = Omit<Partial<SemanticClassifierOptions>, 'summarize'> & {
  readonly summarize?: SemanticClassifierOptions['summarize']
}

/**
 * Build a classifier whose model calls are recorded and answered on demand.
 *
 * Defaults to zero debounce and zero interval floor so a test decides exactly
 * when the injected clock crosses each threshold.
 */
function createHarness(overrides: HarnessOverrides = {}) {
  const { summarize: summarizeImpl, ...rest } = overrides
  const clock = fixedClock()
  const calls: Array<{ context: SemanticContext; signal: AbortSignal }> = []
  const deferreds: Array<Deferred<string>> = []
  const summaries: SemanticSummary[] = []
  const errors: unknown[] = []
  const skips: Array<{ reason: 'near-duplicate' | 'identical'; text: string }> = []
  const classifier = new SemanticActivityClassifier({
    summarize: (context, signal) => {
      calls.push({ context, signal })
      if (summarizeImpl !== undefined) return summarizeImpl(context, signal)
      const pending = deferred<string>()
      deferreds.push(pending)
      return pending.promise
    },
    now: clock.now,
    debounceMs: 0,
    minIntervalMs: 0,
    onSummary: summary => { summaries.push(summary) },
    onError: error => { errors.push(error) },
    onSkip: (reason, text) => { skips.push({ reason, text }) },
    ...rest,
  })
  live.push(classifier)
  return {
    classifier,
    clock,
    calls,
    deferreds,
    summaries,
    errors,
    skips,
    reply(index: number, text: string): void {
      const pending = deferreds[index]
      if (pending === undefined) throw new Error(`no pending summarize call at index ${index}`)
      pending.resolve(text)
    },
    fail(index: number, error: unknown): void {
      const pending = deferreds[index]
      if (pending === undefined) throw new Error(`no pending summarize call at index ${index}`)
      pending.reject(error)
    },
    settle,
    waitFor,
  }
}

describe('sanitizeSummary', () => {
  it('keeps only the first non-empty line', () => {
    expect(sanitizeSummary('\n\nFix the build.\n- a second line')).toBe('Fix the build')
  })

  it('strips a leading label and a trailing period', () => {
    expect(sanitizeSummary('Summary: Fix the build.')).toBe('Fix the build')
    expect(sanitizeSummary('状态：正在修复构建。')).toBe('正在修复构建')
  })

  it('strips list markers and wrapping quotes, including nested quotes', () => {
    expect(sanitizeSummary('- "Fixing the parser"')).toBe('Fixing the parser')
    expect(sanitizeSummary(`"'Investigating the timeout'"`)).toBe('Investigating the timeout')
    expect(sanitizeSummary('`Reading the config`')).toBe('Reading the config')
  })

  it('collapses internal whitespace', () => {
    expect(sanitizeSummary('Fixing    the\tbuild')).toBe('Fixing the build')
  })

  it('keeps a trailing ellipsis but drops a sentence period', () => {
    expect(sanitizeSummary('Waiting for the build…')).toBe('Waiting for the build…')
    expect(sanitizeSummary('Done。')).toBe('Done')
  })

  it('truncates at a word boundary inside the last third of the cap', () => {
    expect(sanitizeSummary('Investigate the failing Snowflake connection now', 20)).toBe('Investigate the')
  })

  it('truncates at a CJK clause boundary', () => {
    expect(sanitizeSummary('正在调查，数据库连接失败', 6)).toBe('正在调查')
  })

  it('hard-truncates when no boundary is near the cap', () => {
    expect(sanitizeSummary('Supercalifragilisticexpialidocious and more', 10)).toBe('Supercalif')
  })

  it('returns empty copy for empty or whitespace-only input', () => {
    expect(sanitizeSummary('')).toBe('')
    expect(sanitizeSummary('   \n  \n')).toBe('')
  })

  it('honours the default cap', () => {
    const long = `${'a'.repeat(200)} tail`
    expect(sanitizeSummary(long).length).toBeLessThanOrEqual(SEMANTIC_DEFAULTS.maxChars)
  })
})

describe('renderSummary', () => {
  it('prefixes the default icon', () => {
    expect(renderSummary('Debugging the parser')).toBe('✨ Debugging the parser')
  })

  it('prefixes a configured icon', () => {
    expect(renderSummary('Debugging the parser', '› ')).toBe('› Debugging the parser')
    expect(renderSummary('Debugging the parser', '')).toBe('Debugging the parser')
  })
})

describe('systemPrompt', () => {
  it('names the context language and the character cap', () => {
    const zh = systemPrompt({ tools: [], phase: 'idle', lang: 'zh', activity: [], priorUpdates: [], newRequest: false }, 40)
    expect(zh).toContain('必须用中文')
    expect(zh).toContain('不超过 40 个字符')
    const en = systemPrompt({ tools: [], phase: 'idle', lang: 'en', activity: [], priorUpdates: [], newRequest: false }, 55)
    expect(en).toContain('plain-English')
    expect(en).toContain('under 55 characters')
  })

  it('clamps the model-facing budget to the narration target', () => {
    // The prompt budget tops out at NARRATION_TARGET_CHARS (60), so a caller
    // asking for 77 still gets a self-consistent 60-character instruction.
    const en = systemPrompt({ tools: [], phase: 'idle', lang: 'en', activity: [], priorUpdates: [], newRequest: false }, 77)
    expect(en).toContain('under 60 characters')
  })
})

describe('frameContext', () => {
  it('frames prior updates, the new activity and the newest request as prose', () => {
    const framed = frameContext({
      userIntent: 'Fix the failing connection',
      tools: [{ name: 'bash', detail: 'psql -c select 1' }],
      assistantText: 'The connection times out',
      phase: 'tool',
      lang: 'en',
      activity: ["tool: bash psql -c 'select 1'", 'tool: read failed'],
      priorUpdates: ['Investigating the connection'],
      newRequest: true,
    }, 4_000)
    expect(framed).toContain('Prior updates (context only; never copy their phrasing):')
    expect(framed).toContain('- Investigating the connection')
    expect(framed).toContain('New activity since the last accepted update:')
    expect(framed).toContain("- tool: bash psql -c 'select 1'")
    expect(framed).toContain('- tool: read failed')
    expect(framed).toContain("The user's newest request, which this update covers:")
    expect(framed).toContain('Fix the failing connection')
    expect(framed).toContain(
      'Output only the single present-progressive status fragment: no prefix, no label, no explanation.',
    )
  })

  it('renders empty sections as none and omits the newest-request section', () => {
    const framed = frameContext(
      { tools: [], phase: 'idle', lang: 'en', activity: [], priorUpdates: [], newRequest: false },
      4_000,
    )
    expect(framed).toContain('Prior updates (context only; never copy their phrasing):\n- none')
    expect(framed).toContain('New activity since the last accepted update:\n- none')
    expect(framed).not.toContain("The user's newest request")
  })

  it('omits the newest-request section when the flag is set without a request', () => {
    const framed = frameContext(
      { tools: [], phase: 'idle', lang: 'en', activity: ['user: go'], priorUpdates: [], newRequest: true },
      4_000,
    )
    expect(framed).toContain('- user: go')
    expect(framed).not.toContain("The user's newest request")
  })

  it('uses the Chinese closing instruction for a zh context', () => {
    const framed = frameContext(
      { tools: [], phase: 'idle', lang: 'zh', activity: ['tool: bash npm test'], priorUpdates: [], newRequest: false },
      4_000,
    )
    expect(framed).toContain('只输出这一条中文状态片段本身：不要前缀、标签、列表或解释。')
  })

  it('never exceeds maxInputChars', () => {
    const framed = frameContext({
      userIntent: 'x'.repeat(500),
      tools: Array.from({ length: 20 }, (_, i) => ({ name: `tool-${i}`, detail: 'd'.repeat(50) })),
      assistantText: 'y'.repeat(500),
      phase: 'tool',
      lang: 'zh',
      activity: Array.from({ length: 20 }, (_, i) => `tool: tool-${i}`),
      priorUpdates: ['first', 'second'],
      newRequest: true,
    }, 120)
    expect(framed.length).toBeLessThanOrEqual(120)
  })
})

describe('SEMANTIC_DEFAULTS', () => {
  it('pins the shipped tuning values', () => {
    expect(SEMANTIC_DEFAULTS).toEqual({
      debounceMs: 1_500,
      maxWaitMs: 2_500,
      minIntervalMs: 2_500,
      maxInputChars: 2_400,
      prefix: '✨ ',
      maxChars: 72,
      maxTools: 6,
      timeoutMs: 6_000,
    })
  })
})

describe('SemanticActivityClassifier accumulation', () => {
  it('dispatches one call carrying everything noted before the debounce fired', async () => {
    const h = createHarness()
    h.classifier.noteUserIntent('Fix the failing Snowflake connection')
    h.classifier.noteTool({ name: 'bash', detail: 'psql -c select 1' })
    h.classifier.noteTool({ name: 'bash', failed: true })
    h.classifier.noteAssistantText('The connection times out')
    await h.settle()

    expect(h.calls).toHaveLength(1)
    expect(h.calls[0]?.context).toEqual({
      userIntent: 'Fix the failing Snowflake connection',
      tools: [{ name: 'bash', detail: 'psql -c select 1', failed: true }],
      assistantText: 'The connection times out',
      phase: 'idle',
      lang: 'zh',
      activity: [
        'user: Fix the failing Snowflake connection',
        'tool: bash psql -c select 1',
        'tool: bash failed',
      ],
      priorUpdates: [],
      newRequest: true,
    })
  })

  it('updates the newest tool entry on settle instead of appending a duplicate', async () => {
    const h = createHarness()
    h.classifier.noteTool({ name: 'bash', detail: 'npm test' })
    h.classifier.noteTool({ name: 'bash', failed: false })
    await h.settle()
    expect(h.calls[0]?.context.tools).toEqual([{ name: 'bash', detail: 'npm test', failed: false }])
  })

  it('caps the retained tools at maxTools, dropping the oldest', async () => {
    const h = createHarness({ maxTools: 2 })
    h.classifier.noteTool({ name: 'bash' })
    h.classifier.noteTool({ name: 'read' })
    h.classifier.noteTool({ name: 'grep' })
    await h.settle()
    expect(h.calls[0]?.context.tools.map(tool => tool.name)).toEqual(['read', 'grep'])
  })

  it('re-anchors on a new user request: tools and assistant text are dropped', async () => {
    const h = createHarness()
    h.classifier.noteTool({ name: 'bash', detail: 'npm test' })
    h.classifier.noteAssistantText('stale output')
    h.classifier.noteUserIntent('Now fix the parser instead')
    await h.settle()
    expect(h.calls).toHaveLength(1)
    expect(h.calls[0]?.context.userIntent).toBe('Now fix the parser instead')
    expect(h.calls[0]?.context.tools).toEqual([])
    expect(h.calls[0]?.context.assistantText).toBeUndefined()
  })

  it('truncates an over-long user request to INTENT_MAX_CHARS', async () => {
    const h = createHarness()
    h.classifier.noteUserIntent('x'.repeat(INTENT_MAX_CHARS + 500))
    await h.settle()
    expect(h.calls[0]?.context.userIntent).toHaveLength(INTENT_MAX_CHARS)
  })

  it('replaces the provisional stream tail with a settled message', async () => {
    const h = createHarness()
    h.classifier.noteAssistantText('partial res')
    h.classifier.noteAssistantMessage('settled   response')
    await h.settle()
    expect(h.calls[0]?.context.assistantText).toBe('settled response')
  })

  it('does not dispatch for streamed text below one 160-character step', async () => {
    const h = createHarness()
    // 14 characters never cross the activity step, so the delta stays empty.
    h.classifier.noteAssistantText('partial output')
    await h.settle()
    expect(h.calls).toHaveLength(0)
  })

  it('records the retained tail as activity once the stream crosses one step', async () => {
    const h = createHarness()
    h.classifier.noteAssistantText('x'.repeat(160))
    await h.settle()
    expect(h.calls).toHaveLength(1)
    expect(h.calls[0]?.context.activity).toEqual([`assistant: ${'x'.repeat(160)}`])
  })

  it('drops the retained tail on clearProvisionalText without dropping recorded activity', async () => {
    const h = createHarness()
    // Crossing the step records an activity line built from the retained tail.
    h.classifier.noteAssistantText('x'.repeat(160))
    h.classifier.clearProvisionalText()
    h.classifier.noteTool({ name: 'read', detail: 'src/a.ts' })
    await h.settle()

    expect(h.calls).toHaveLength(1)
    expect(h.calls[0]?.context.assistantText).toBeUndefined()
    expect(h.calls[0]?.context.activity).toEqual([
      `assistant: ${'x'.repeat(160)}`,
      'tool: read src/a.ts',
    ])
  })

  it('drops the retained tail on clearAssistantText the same way', async () => {
    const h = createHarness()
    h.classifier.noteAssistantText('x'.repeat(160))
    h.classifier.clearAssistantText()
    h.classifier.noteTool({ name: 'read', detail: 'src/a.ts' })
    await h.settle()

    expect(h.calls).toHaveLength(1)
    expect(h.calls[0]?.context.assistantText).toBeUndefined()
    expect(h.calls[0]?.context.activity).toEqual([
      `assistant: ${'x'.repeat(160)}`,
      'tool: read src/a.ts',
    ])
  })

  it('pins the output language with setLang', async () => {
    const h = createHarness()
    h.classifier.setLang('en')
    h.classifier.noteUserIntent('Fix the build')
    await h.settle()
    expect(h.calls[0]?.context.lang).toBe('en')
  })

  it('ignores empty notes', async () => {
    const h = createHarness()
    h.classifier.noteUserIntent('   ')
    h.classifier.noteAssistantText('')
    h.classifier.noteAssistantMessage('  ')
    await h.settle()
    expect(h.calls).toHaveLength(0)
  })

  it('treats a repeated phase report as a no-op', async () => {
    const h = createHarness()
    h.classifier.notePhase('idle')
    await h.settle()
    expect(h.calls).toHaveLength(0)
  })
})

describe('SemanticActivityClassifier dispatch policy', () => {
  it('does not dispatch until the debounce quiet period elapses', async () => {
    const h = createHarness({ debounceMs: 20 })
    h.classifier.noteUserIntent('Investigate the outage')
    // Synchronous proof that the call is not issued on the note itself.
    expect(h.calls).toHaveLength(0)
    await h.waitFor(() => h.calls.length === 1)
    expect(h.calls).toHaveLength(1)
  })

  it('enforces minIntervalMs between dispatches on the injected clock', async () => {
    const h = createHarness({ minIntervalMs: 5_000 })
    h.classifier.noteUserIntent('Investigate the outage')
    await h.settle()
    expect(h.calls).toHaveLength(1)
    h.reply(0, 'Investigating the outage')
    await h.settle()
    expect(h.summaries).toHaveLength(1)

    // A material change still has to wait out the interval floor.
    h.classifier.noteTool({ name: 'bash', detail: 'pg_isready' })
    await h.settle()
    expect(h.calls).toHaveLength(1)

    // Cross the floor on the injected clock, then re-arm: dispatch is due now.
    h.clock.advance(5_000)
    h.classifier.noteTool({ name: 'read', detail: 'src/db.ts' })
    await h.settle()
    expect(h.calls).toHaveLength(2)
  })

  it('does not dispatch again for sub-step streamed text after an accepted update', async () => {
    const h = createHarness()
    h.classifier.noteUserIntent('Fix the build')
    h.classifier.noteAssistantText('Investigating the failure')
    await h.settle()
    expect(h.calls).toHaveLength(1)
    h.reply(0, 'Debugging the build')
    await h.settle()
    expect(h.summaries).toHaveLength(1)

    // 5 more characters stay far below one 160-character activity step, so the
    // delta is empty and there is nothing new to describe.
    h.classifier.noteAssistantText(' more')
    await h.settle()
    expect(h.calls).toHaveLength(1)

    // A material change still earns a call afterwards.
    h.classifier.noteTool({ name: 'read' })
    await h.settle()
    expect(h.calls).toHaveLength(2)
  })

  it('dispatches again once streamed text crosses the activity step', async () => {
    const h = createHarness()
    h.classifier.noteUserIntent('Fix the build')
    await h.settle()
    expect(h.calls).toHaveLength(1)
    h.reply(0, 'Debugging the build')
    await h.settle()
    h.classifier.noteAssistantText('x'.repeat(400))
    await h.settle()
    expect(h.calls).toHaveLength(2)
  })

  it('does not dispatch on a phase change alone, but does on the next real signal', async () => {
    const h = createHarness()
    h.classifier.noteUserIntent('Fix the build')
    await h.settle()
    expect(h.calls).toHaveLength(1)
    h.reply(0, 'Debugging the build')
    await h.settle()
    expect(h.summaries).toHaveLength(1)

    // A phase change carries no new evidence, so there is nothing to describe.
    h.classifier.notePhase('tool')
    await h.settle()
    expect(h.calls).toHaveLength(1)

    // The phase still reaches the context once real activity lands.
    h.classifier.noteTool({ name: 'read', detail: 'src/a.ts' })
    await h.settle()
    expect(h.calls).toHaveLength(2)
    expect(h.calls[1]?.context.phase).toBe('tool')
  })

  it('consumes activity once so a follow-up call carries only newer lines', async () => {
    const h = createHarness()
    h.classifier.noteUserIntent('Investigate the logs')
    await h.settle()
    expect(h.calls[0]?.context.activity).toEqual(['user: Investigate the logs'])

    h.reply(0, 'Investigating the logs')
    await h.settle()
    h.classifier.noteTool({ name: 'bash', detail: 'grep -r' })
    await h.settle()
    expect(h.calls).toHaveLength(2)
    expect(h.calls[1]?.context.activity).toEqual(['tool: bash grep -r'])
  })

  it('coalesces a burst of in-flight signals into exactly one follow-up call', async () => {
    const h = createHarness()
    h.classifier.noteUserIntent('Investigate the logs')
    await h.settle()
    expect(h.calls).toHaveLength(1)

    h.classifier.noteTool({ name: 'bash', detail: 'grep -r' })
    h.classifier.noteAssistantText('The log shows')
    h.classifier.noteTool({ name: 'read', detail: 'src/a.ts' })
    await h.settle()
    expect(h.calls).toHaveLength(1)

    h.reply(0, 'Investigating the logs')
    await h.settle()
    expect(h.calls).toHaveLength(2)
    expect(h.calls[1]?.context.tools).toEqual([
      { name: 'bash', detail: 'grep -r' },
      { name: 'read', detail: 'src/a.ts' },
    ])
    expect(h.calls[1]?.context.assistantText).toBe('The log shows')

    h.reply(1, 'Reading the source')
    await h.settle()
    await h.settle()
    expect(h.calls).toHaveLength(2)
    // The sanitizer narrates human work, not tool mechanics, so the banned
    // opening verb "Reading" is rewritten to "Reviewing" before display.
    expect(h.summaries.map(summary => summary.text)).toEqual(['Investigating the logs', 'Reviewing the source'])
  })
})

describe('SemanticActivityClassifier cancellation', () => {
  it("notePhase('done') aborts the in-flight call and drops its answer", async () => {
    const h = createHarness()
    // A real activity signal arms the call; the phase report then cancels it.
    h.classifier.noteUserIntent('Investigate the crash')
    await h.settle()
    expect(h.calls).toHaveLength(1)

    h.classifier.notePhase('done')
    expect(h.calls[0]?.signal.aborted).toBe(true)

    h.reply(0, 'Investigating the crash')
    await h.settle()
    expect(h.summaries).toHaveLength(0)
    expect(h.errors).toHaveLength(0)
  })

  it("a turn settling into 'idle' aborts the in-flight call", async () => {
    const h = createHarness()
    // The turn has to be working first: a *transition* out of a live phase into
    // a settled one is what cancels the call.
    h.classifier.notePhase('tool')
    h.classifier.noteUserIntent('Investigate the outage')
    await h.settle()
    expect(h.calls).toHaveLength(1)

    h.classifier.notePhase('idle')
    expect(h.calls[0]?.signal.aborted).toBe(true)

    h.reply(0, 'Investigating the outage')
    await h.settle()
    expect(h.summaries).toHaveLength(0)
  })

  it("a repeated settled phase does not cancel the request's own dispatch", async () => {
    const h = createHarness()
    // The host reports the phase again on the very fold that carries the user's
    // message, and between turns that report is a repeat of `idle`. It must not
    // kill the immediate dispatch the ask just armed, or the chip could not say
    // what the new request is about until the first tool call landed.
    h.classifier.noteUserIntent('Investigate the outage')
    h.classifier.notePhase('idle')
    expect(h.calls).toHaveLength(0)

    await h.waitFor(() => h.calls.length === 1)
    expect(h.calls[0]?.signal.aborted).toBe(false)
    expect(h.calls[0]?.context.phase).toBe('idle')
    expect(h.calls[0]?.context.newRequest).toBe(true)
    expect(h.calls[0]?.context.activity).toEqual(['user: Investigate the outage'])
  })

  it('a settled turn cancels a pending debounce', async () => {
    const h = createHarness({ minIntervalMs: 5_000 })
    h.classifier.noteUserIntent('Investigate the outage')
    await h.settle()
    expect(h.calls).toHaveLength(1)
    h.reply(0, 'Investigating the outage')
    await h.settle()

    // Material change, but the interval floor leaves a timer pending.
    h.classifier.noteTool({ name: 'bash', detail: 'pg_isready' })
    h.classifier.notePhase('done')
    await h.settle()
    expect(h.calls).toHaveLength(1)
  })

  it('dispose cancels a pending debounce and suppresses callbacks', async () => {
    const h = createHarness({ debounceMs: 50 })
    h.classifier.noteUserIntent('Investigate the outage')
    h.classifier.dispose()
    await h.settle()
    expect(h.calls).toHaveLength(0)
  })

  it('dispose aborts an in-flight call and drops both answers and errors', async () => {
    const resolved = createHarness()
    resolved.classifier.noteUserIntent('Investigate the outage')
    await resolved.settle()
    resolved.classifier.dispose()
    expect(resolved.calls[0]?.signal.aborted).toBe(true)
    resolved.reply(0, 'Investigating the outage')
    await resolved.settle()
    expect(resolved.summaries).toHaveLength(0)
    expect(resolved.errors).toHaveLength(0)

    const rejected = createHarness()
    rejected.classifier.noteUserIntent('Investigate the outage')
    await rejected.settle()
    rejected.classifier.dispose()
    rejected.fail(0, new Error('model exploded'))
    await rejected.settle()
    expect(rejected.errors).toHaveLength(0)
  })

  it('aborts the model call at the deadline without reporting an error', async () => {
    let release!: () => void
    const aborted = new Promise<void>(resolve => { release = resolve })
    const h = createHarness({
      timeoutMs: 20,
      summarize: (_context, signal) => new Promise<string>((_resolve, reject) => {
        signal.addEventListener('abort', () => {
          release()
          reject(new Error('deadline'))
        }, { once: true })
      }),
    })
    h.classifier.noteUserIntent('Investigate the outage')
    await aborted
    await h.settle()
    expect(h.calls).toHaveLength(1)
    expect(h.calls[0]?.signal.aborted).toBe(true)
    expect(h.summaries).toHaveLength(0)
    expect(h.errors).toHaveLength(0)
  })
})

describe('SemanticActivityClassifier acceptance', () => {
  it('accepts cleaned text and reports revision, timestamp, source and rendered copy', async () => {
    const h = createHarness()
    h.classifier.noteUserIntent('Fix the build')
    await h.settle()
    h.reply(0, '"Debugging the parser."')
    await h.settle()

    expect(h.summaries).toEqual([
      { text: 'Debugging the parser', at: h.clock.now(), revision: 1, source: 'llm' },
    ])
    expect(h.classifier.current()).toEqual({
      text: 'Debugging the parser',
      at: h.clock.now(),
      revision: 1,
      source: 'llm',
    })
    expect(h.classifier.currentText()).toBe('✨ Debugging the parser')
  })

  it('rewrites a banned tool-narration opening through sanitizeNarration', async () => {
    const h = createHarness()
    h.classifier.noteUserIntent('Fix the build')
    await h.settle()
    // "Reading …" narrates agent mechanics; pi-bar's sanitizer rewrites the
    // banned opening verb to the human-developer equivalent before display.
    h.reply(0, 'Reading the source')
    await h.settle()
    expect(h.summaries[0]?.text).toBe('Reviewing the source')
  })

  it('renders currentText with a configured prefix', async () => {
    const h = createHarness({ prefix: '› ' })
    h.classifier.noteUserIntent('Fix the build')
    await h.settle()
    h.reply(0, 'Debugging the parser')
    await h.settle()
    expect(h.classifier.currentText()).toBe('› Debugging the parser')
  })

  it('has no current summary before one is accepted', () => {
    const h = createHarness()
    expect(h.classifier.current()).toBeUndefined()
    expect(h.classifier.currentText()).toBeUndefined()
  })

  it('keeps the previous summary when a reply cleans to empty', async () => {
    const h = createHarness()
    h.classifier.noteUserIntent('Fix the build')
    await h.settle()
    h.reply(0, 'Debugging the parser.')
    await h.settle()
    expect(h.summaries).toHaveLength(1)

    h.classifier.noteTool({ name: 'bash' })
    await h.settle()
    h.reply(1, '   \n  ')
    await h.settle()
    expect(h.summaries).toHaveLength(1)
    expect(h.classifier.current()?.text).toBe('Debugging the parser')
  })

  it('reports a failed reply but keeps the previous summary', async () => {
    const h = createHarness()
    h.classifier.noteUserIntent('Fix the build')
    await h.settle()
    h.reply(0, 'Debugging the parser')
    await h.settle()

    h.classifier.noteTool({ name: 'bash' })
    await h.settle()
    h.fail(1, new Error('model exploded'))
    await h.settle()
    expect(h.errors).toHaveLength(1)
    expect(h.errors[0]).toBeInstanceOf(Error)
    expect(h.summaries).toHaveLength(1)
    expect(h.calls).toHaveLength(2)
  })

  it('does not re-fire for identical cleaned text but fires a new revision for a different one', async () => {
    const h = createHarness()
    h.classifier.noteUserIntent('Fix the build')
    await h.settle()
    h.reply(0, 'Debugging the parser.')
    await h.settle()
    expect(h.summaries.map(summary => summary.revision)).toEqual([1])

    h.classifier.noteTool({ name: 'bash' })
    await h.settle()
    h.reply(1, '"Debugging the parser"')
    await h.settle()
    expect(h.summaries.map(summary => summary.revision)).toEqual([1])

    h.classifier.noteTool({ name: 'read' })
    await h.settle()
    h.reply(2, 'Debugging the parser cache')
    await h.settle()
    expect(h.summaries.map(summary => summary.revision)).toEqual([1, 2])
    expect(h.summaries[1]?.text).toBe('Debugging the parser cache')
  })
})

describe('SemanticActivityClassifier onSkip', () => {
  it("reports onSkip('identical') instead of repainting identical cleaned text", async () => {
    const h = createHarness()
    h.classifier.noteUserIntent('Fix the build')
    await h.settle()
    h.reply(0, '"Debugging the parser."')
    await h.settle()
    expect(h.summaries).toHaveLength(1)

    h.classifier.noteTool({ name: 'bash' })
    await h.settle()
    h.reply(1, '"Debugging the parser"')
    await h.settle()
    expect(h.summaries).toHaveLength(1)
    expect(h.skips).toEqual([{ reason: 'identical', text: 'Debugging the parser' }])
  })

  it("reports onSkip('near-duplicate') for a cosmetic reword", async () => {
    const h = createHarness()
    h.classifier.noteUserIntent('Fix the build')
    await h.settle()
    h.reply(0, 'Reviewing the parser config')
    await h.settle()
    expect(h.summaries).toHaveLength(1)

    h.classifier.noteTool({ name: 'read', detail: 'src/a.ts' })
    await h.settle()
    h.reply(1, 'reviewing  the parser-config.')
    await h.settle()
    expect(h.summaries).toHaveLength(1)
    expect(h.skips).toEqual([{ reason: 'near-duplicate', text: 'reviewing the parser-config' }])
  })

  it('accepts a near-duplicate when it covers a brand-new user request', async () => {
    const h = createHarness()
    h.classifier.noteUserIntent('Fix the build')
    await h.settle()
    h.reply(0, 'Reviewing the parser config')
    await h.settle()

    // The user changes the ask, so the delta is a genuinely new topic even
    // though the model's phrasing is a cosmetic variant of the last line.
    h.classifier.noteUserIntent('Now review the parser config')
    await h.settle()
    h.reply(1, 'reviewing  the parser-config.')
    await h.settle()
    expect(h.skips).toEqual([])
    expect(h.summaries.map(summary => summary.text)).toEqual([
      'Reviewing the parser config',
      'reviewing the parser-config',
    ])
  })
})
