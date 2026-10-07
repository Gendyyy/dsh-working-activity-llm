/**
 * The model call behind the semantic chip: one short auxiliary completion per
 * classifier dispatch, on the session's own route by default.
 *
 * Modelled directly on the shipped `@deepseek-ai/dsh-session-title-llm`
 * policy (the official "ask a model for one short string" path), and
 * deliberately narrower than it in one respect that matters:
 *
 * **Nothing is appended to the session log.** The title path logs a
 * `session/title-llm-request` event for auditability, which is affordable once
 * per session. This classifier runs every few seconds of work, so logging each
 * request would flood the transcript's log and make replays noisy. The call is
 * therefore pure: context in, text out, no session mutation, nothing the model
 * can see, nothing a replay must reconstruct.
 *
 * Route policy: an explicit `provider`/`model` pair from plugin config wins;
 * otherwise the route the session itself last used is read from the live
 * `request/header` fold (`session.requestHeader()`), so no extra credentials
 * are needed and the classifier runs on whatever model the user already
 * configured. A call with no route available fails loudly rather than guessing.
 * @module dsh-working-activity-llm/llm-summarizer
 */

import { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { FinishReason, LlmRuntime } from '@deepseek-ai/dsh-llm'
import { deadline } from '@deepseek-ai/dsh-timeout'
import { frameContext, systemPrompt, SEMANTIC_DEFAULTS, type SemanticContext } from './semantic.js'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /**
     * An auxiliary classifier call issued by this plugin's activity chip.
     * Declared here so the request carries its real producer instead of
     * impersonating a user turn.
     */
    'working-activity-llm': { kind: 'working-activity-llm' }
  }
}

/** Timeout code stamped onto the classifier's deadline reason. */
export const SUMMARY_TIMEOUT_CODE = 'WORKING_ACTIVITY_SUMMARY_TIMEOUT'

/** One provider/model route. */
export interface SummaryRoute {
  readonly provider: string
  readonly model: string
}

/**
 * The slice of `Session` this call needs: its identity for request routing
 * metadata, and the live request-header fold that supplies the default route.
 *
 * `id` is load-bearing, not decorative. The loop stamps `GenerateOptions.sessionId`
 * on every request it makes, and adapters translate it into provider transport
 * metadata — the pi-ai adapter sends it as `x-opencode-session`, and without it
 * the `opencode-go` route answers `400 MissingSessionID` (measured, not
 * theoretical: omitting it makes every classifier call fail on that provider).
 *
 * The cost of passing it is bounded and known: `@deepseek-ai/dsh-session-checkpoint-policy`
 * listens on `llm/stream` and, when a `sessionId` is present, flushes that
 * session's pending writes before dispatch. That is a durability barrier on a
 * session that is already being flushed continuously — it appends nothing, so
 * the call still leaves no trace in the session log and stays invisible to the
 * replay-based token meter.
 */
export interface SummarySession {
  readonly id: string
  requestHeader(): { readonly config: { readonly provider: string; readonly model: string } } | undefined
}

/** Construction options for {@link createLlmSummarizer}. */
export interface LlmSummarizerOptions {
  /** The host's registered LLM service (`ctx.llm`). */
  readonly llm: Pick<LlmRuntime, 'stream'>
  /** Session the context belongs to. */
  readonly session: SummarySession
  /**
   * Explicit route override; both fields or neither.
   *
   * A function is re-read on every call, which is what lets the settings page
   * change the classifier's model while the plugin keeps running — the route is
   * resolved per summary, not once at construction.
   */
  readonly route?: SummaryRoute | (() => SummaryRoute | undefined)
  /**
   * Output cap for the one-line answer.
   *
   * Measured, not guessed: a reasoning model's hidden thinking is billed against
   * this cap, so a budget sized for "one short phrase" (96) is exhausted before
   * the phrase appears, and the call fails with `max-tokens` having produced no
   * text at all. The cap only bounds a runaway, so it is set generously and the
   * truncation path below salvages whatever text did arrive.
   */
  readonly maxOutputTokens?: number
  /**
   * Explicit reasoning effort for the classifier call.
   *
   * Left unset by default so the adapter's own default applies. Set it (e.g.
   * `'low'`) when the route's default burns the output budget on thinking — a
   * classification task has no use for deep reasoning. An effort the model does
   * not declare is rejected by the adapter before any provider I/O, so this is
   * opt-in rather than a default. A function is re-read on every call so a live
   * settings edit applies to the next summary.
   */
  readonly reasoningEffort?: string | (() => string | undefined)
  /** End-to-end deadline for one call. */
  readonly timeoutMs?: number
  /** Accepted summary length cap, mirrored into the system prompt. */
  readonly maxChars?: number
  /** Framed-context cap, in characters. */
  readonly maxInputChars?: number
}

/** Default output budget: room for a reasoning model to think AND answer. */
export const SUMMARY_MAX_OUTPUT_TOKENS = 512

/**
 * Translate a terminal finish reason into a classifier failure.
 *
 * `max-tokens` is deliberately absent: the caller salvages the text a truncated
 * answer did emit, and only reports a failure when that text is empty.
 */
function finishError(finish: FinishReason): Error | undefined {
  switch (finish.kind) {
    case 'stop':
      return undefined
    case 'error':
    case 'aborted': {
      const error = new Error(finish.failure.message)
      ;(error as { code?: string }).code = finish.failure.code
      return error
    }
    case 'max-tokens':
      return undefined
    case 'tool-calls':
      return new Error('working-activity: summary model unexpectedly requested a tool')
    default:
      return new Error(`working-activity: unsupported finish reason "${String((finish as { kind: string }).kind)}"`)
  }
}

/**
 * Build the classifier's model call for one session.
 *
 * The returned function is safe to abort: the caller's `signal` is fused with
 * the timeout, and the stream is checked before every assembled chunk so a
 * slow adapter cannot deliver a late answer.
 * @param options - service, session, route override and limits.
 * @returns a `summarize(context, signal)` function for {@link SemanticActivityClassifier}.
 */
export function createLlmSummarizer(options: LlmSummarizerOptions): (context: SemanticContext, signal: AbortSignal) => Promise<string> {
  const maxOutputTokens = options.maxOutputTokens ?? SUMMARY_MAX_OUTPUT_TOKENS
  const timeoutMs = options.timeoutMs ?? SEMANTIC_DEFAULTS.timeoutMs
  const maxChars = options.maxChars ?? SEMANTIC_DEFAULTS.maxChars
  const maxInputChars = options.maxInputChars ?? SEMANTIC_DEFAULTS.maxInputChars

  /** Explicit config wins; otherwise the route the session last requested under. */
  const resolveRoute = (): SummaryRoute => {
    const override = typeof options.route === 'function' ? options.route() : options.route
    if (override !== undefined) return override
    const header = options.session.requestHeader()
    if (header === undefined) {
      throw new Error(
        'working-activity: no model route available for the activity summary — '
        + 'the session has not issued a request yet; set `provider` and `model` in the plugin config to pin one',
      )
    }
    return { provider: header.config.provider, model: header.config.model }
  }

  return async function summarize(context: SemanticContext, signal: AbortSignal): Promise<string> {
    const route = resolveRoute()
    const reasoningEffort = typeof options.reasoningEffort === 'function'
      ? options.reasoningEffort()
      : options.reasoningEffort
    const messages = [createUserMessage({
      content: [{ type: 'text', text: frameContext(context, maxInputChars, maxChars) }],
      source: { kind: 'working-activity-llm' },
    })]
    const callDeadline = deadline(signal, timeoutMs, SUMMARY_TIMEOUT_CODE)
    try {
      signal.throwIfAborted()
      const assembler = new BlockAssembler()
      for await (const chunk of options.llm.stream({
        provider: route.provider,
        model: route.model,
        messages,
        system: systemPrompt(context, maxChars),
        maxTokens: maxOutputTokens,
        // Required for provider routing metadata (see SummarySession).
        sessionId: options.session.id as never,
        // No `stop`: the pi-ai adapter rejects `GenerateOptions.stop` outright
        // ("llm-pi-ai does not support GenerateOptions.stop", measured), so the
        // one-line contract is enforced on the reply instead (`sanitizeSummary`)
        // and by keeping the route's reasoning effort low, which is what stops
        // the output budget from being spent before the phrase appears.
        // No `reasoningEffort` either unless the config pins one: an effort the
        // model does not declare is rejected by the adapter, so "no opinion"
        // must not become an assertion.
        // Omitted entirely when unset: an explicit effort the model does not
        // declare is rejected by the adapter, so "no opinion" must not become
        // an assertion.
        ...(reasoningEffort === undefined || reasoningEffort === ''
          ? {}
          : { reasoningEffort: reasoningEffort as never }),
        signal: callDeadline.signal,
      })) {
        signal.throwIfAborted()
        assembler.push(chunk)
      }
      signal.throwIfAborted()
      // Raw join only: cleaning (quotes, labels, length) is `sanitizeSummary`'s
      // job, so the policy stays in one testable place.
      const text = blocksToText(assembler)
      // A truncated answer is still an answer. `max-tokens` means the model ran
      // out of budget — commonly because it spent it thinking — and the phrase
      // it did emit is exactly what the chip needs. Only a truncation that
      // produced nothing is a failure.
      if (assembler.finish.kind === 'max-tokens') {
        if (text.trim() === '') {
          throw new Error(
            'working-activity: summary produced no text before hitting maxOutputTokens — '
            + 'lower the route\'s reasoning effort (`semanticReasoningEffort: low`) or raise `semanticMaxOutputTokens`',
          )
        }
        return text
      }
      const failure = finishError(assembler.finish)
      if (failure !== undefined) throw failure
      return text
    } finally {
      callDeadline[Symbol.dispose]()
    }
  }
}

/** Join the text blocks one assembled stream produced, rejecting tool calls. */
function blocksToText(assembler: BlockAssembler): string {
  const blocks = assembler.blocks()
  if (blocks.some(block => block.type === 'tool-call')) {
    throw new Error('working-activity: summary output must contain text only')
  }
  return blocks
    .filter((block): block is Extract<typeof block, { type: 'text' }> => block.type === 'text')
    .map(block => block.text)
    .join(' ')
}
