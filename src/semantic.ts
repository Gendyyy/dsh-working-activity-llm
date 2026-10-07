/**
 * The semantic activity classifier — "what is the agent actually trying to
 * accomplish", asked of a small/fast model instead of inferred from tool names.
 *
 * The heuristic line this package already renders answers *what is running*
 * (`跑个命令 npm test · 12s`). It cannot answer *why*: `bash` running `psql` is
 * the same line whether the agent is debugging a Snowflake connection, seeding
 * a fixture, or checking a migration. This module owns the second question and
 * nothing else:
 *
 * - a **delta** of raw turn activity (the events since the last accepted
 *   update) plus the previously accepted lines as context, so each call
 *   summarizes what is new rather than re-summarizing the same window — the
 *   cause of the "same sentence, slightly reworded" churn the first version
 *   produced;
 * - a pi-bar-shaped cadence: a quiet-period debounce with a burst cap, so a
 *   turn that streams without pause still gets an update, plus a floor between
 *   calls so a busy turn cannot cost more than one fast call per few seconds;
 * - one in-flight call at a time, aborted on turn end and re-run once it
 *   settles when newer activity arrived while it was thinking;
 * - the narration vocabulary from pi-bar (`./narration.ts`): human-developer
 *   phrasing, allowed/banned first words, path/version/markdown stripping, and
 *   near-duplicate suppression so the chip stops flashing cosmetic variants.
 *
 * Everything here is pure and clock-injected: the model call is an injected
 * `summarize` function, so the whole policy is unit-testable without a
 * provider. The transport (which provider/model, streaming, timeouts) lives in
 * `./llm-summarizer.ts`.
 * @module dsh-working-activity-llm/semantic
 */

import {
  isNearDuplicateNarration,
  narrationSystemPrompt,
  narrationUserPrompt,
  sanitizeNarration,
  type NarrationPromptInput,
} from './narration.js'
import type { ActivityPhase } from './status.js'

/** One tool call the classifier may cite as evidence of intent. */
export interface SemanticToolNote {
  /** Durable tool name (`bash`, `read`, `grep`, …). */
  readonly name: string
  /** Salient argument fragment (command, path, pattern), already truncated. */
  readonly detail?: string
  /** Whether the call settled in failure. */
  readonly failed?: boolean
}

/** Everything the classifier knows about the turn when it builds a prompt. */
export interface SemanticContext {
  /** The user's most recent request, truncated for framing. */
  readonly userIntent?: string
  /** Recent tool calls, oldest first. */
  readonly tools: readonly SemanticToolNote[]
  /** Tail of the model's own output this turn, when it has written any. */
  readonly assistantText?: string
  /** Phase the heuristic line is in, so the model can word it as ongoing. */
  readonly phase: ActivityPhase
  /** Language tag the summary should be written in. */
  readonly lang: 'zh' | 'en'
  /**
   * Raw activity lines since the last accepted update, oldest first. This is
   * the model's actual evidence: what happened that the current chip line does
   * not yet account for.
   */
  readonly activity: readonly string[]
  /** Previously accepted chip lines, oldest first. Context only, never copied. */
  readonly priorUpdates: readonly string[]
  /** True when this update covers a brand-new user request. */
  readonly newRequest: boolean
}

/** One accepted semantic summary. */
export interface SemanticSummary {
  /** Cleaned, single-line copy — safe to render verbatim in the chip. */
  readonly text: string
  /** Epoch ms the summary was accepted. */
  readonly at: number
  /**
   * Monotonic per-session revision. Consumers (the polled route, the chip's
   * own state) compare revisions rather than strings so a summary that happens
   * to repeat is still an update.
   */
  readonly revision: number
  /** Always `llm`: the heuristic line is not a summary and never claims to be. */
  readonly source: 'llm'
}

/** Tuning knobs; every one of them is also plugin configuration. */
export interface SemanticClassifierOptions {
  /** Injected model call: exact context in, one short phrase out. */
  readonly summarize: (context: SemanticContext, signal: AbortSignal) => Promise<string>
  /** Injected clock (tests pin it). */
  readonly now?: () => number
  /** Quiet period after the last signal before a call is dispatched. */
  readonly debounceMs?: number
  /**
   * Ceiling on how long the quiet period may keep being pushed back by a
   * continuously streaming turn (pi-bar's burst cap).
   */
  readonly maxWaitMs?: number
  /** Floor between two dispatched calls, however busy the turn is. */
  readonly minIntervalMs?: number
  /** Hard cap on the framed context handed to the model, in characters. */
  readonly maxInputChars?: number
  /** Accepted-summary callback (fired only when the text actually changed). */
  readonly onSummary: (summary: SemanticSummary) => void
  /** Failure callback; the chip silently keeps the heuristic line. */
  readonly onError?: (error: unknown) => void
  /**
   * Callback for answers that were deliberately not shown. Silence here would
   * look exactly like "the model never answered", which is the bug this whole
   * module exists to avoid.
   */
  readonly onSkip?: (reason: 'near-duplicate' | 'identical', text: string) => void
  /**
   * Icon prefix rendered in front of the summary (the built-in default is
   * `'✨ '`). A function is re-read on every render, which is how a live
   * settings edit changes the chip's icon without remounting the plugin.
   */
  readonly prefix?: string | (() => string)
  /** Maximum accepted summary length, in characters. */
  readonly maxChars?: number
  /** Tool notes retained in the context window. */
  readonly maxTools?: number
  /** Model-call deadline. */
  readonly timeoutMs?: number
}

/**
 * Defaults tuned to pi-bar's live-progress cadence: a quiet period short enough
 * to feel immediate, a burst cap so a turn that never stops streaming still
 * updates, and a floor so a busy turn costs about one fast call every few
 * seconds.
 */
export const SEMANTIC_DEFAULTS = {
  debounceMs: 1_500,
  maxWaitMs: 2_500,
  minIntervalMs: 2_500,
  maxInputChars: 2_400,
  prefix: '✨ ',
  maxChars: 72,
  maxTools: 6,
  timeoutMs: 6_000,
} as const

/** Leading noise a small model likes to add despite instructions. */
const LEADING_NOISE = /^(?:[-*>•\d.)\s]+|(?:summary|status|activity|活动|状态|摘要)\s*[:：]\s*)+/i

/** Wrapping quotes/backticks a model adds around a self-contained phrase. */
const WRAPPING_QUOTES = /^["'`“”‘’「」『』]+|["'`“”‘’「」『』]+$/g

/** A trailing full stop (the chip is a fragment, not a sentence). */
const TRAILING_PERIOD = /[.。]+$/u

/** Raw activity lines retained per session (a long turn must not grow forever). */
const MAX_RETAINED_ACTIVITIES = 128

/** Previously accepted lines handed back as "context only" (pi-bar keeps 8). */
const MAX_PRIOR_UPDATES = 8

/** One raw activity line's ceiling. */
const ACTIVITY_LINE_MAX_CHARS = 300

/**
 * How much the streamed text tail must grow before it counts as new activity.
 * Recording a line per token would make every delta a reason to call the model.
 */
const ASSISTANT_ACTIVITY_STEP = 160

/**
 * Clean one already-trimmed line into chip copy, or `''` when nothing survives.
 *
 * Conservative by design: it removes structure the chip cannot render (a
 * leading label, wrapping quotes, list markers) and a trailing sentence period,
 * and nothing else.
 */
function cleanLine(line: string): string {
  let text = line.replace(/\s+/g, ' ').trim()
  text = text.replace(LEADING_NOISE, '')
  // Quotes are stripped repeatedly: models nest them (`"'…'"`).
  for (let i = 0; i < 3; i += 1) {
    const next = text.replace(WRAPPING_QUOTES, '').trim()
    if (next === text) break
    text = next
  }
  // A dangling ellipsis is meaningful in the chip; a sentence period is not.
  return text.replace(TRAILING_PERIOD, '').trim()
}

/**
 * Clean one model reply into chip copy.
 *
 * Scans the reply's lines and keeps the first one that survives {@link cleanLine}
 * *with content*. That last condition matters: a model that opens with a code
 * fence (` ``` `) produces a first line that cleans to nothing, and "take the
 * first non-empty line" would then reject the whole reply — throwing away a
 * perfectly good phrase on the next line.
 * @param raw - the model's raw text.
 * @param maxChars - hard length cap; longer replies are truncated at a word boundary.
 * @returns single-line copy without a leading label, wrapping quotes, or a trailing period.
 */
export function sanitizeSummary(raw: string, maxChars: number = SEMANTIC_DEFAULTS.maxChars): string {
  let text = ''
  for (const line of raw.split(/\r?\n/)) {
    const cleaned = cleanLine(line.trim())
    if (cleaned === '') continue
    text = cleaned
    break
  }
  if (text.length > maxChars) {
    const clipped = text.slice(0, maxChars)
    const boundary = Math.max(clipped.lastIndexOf(' '), clipped.lastIndexOf('，'), clipped.lastIndexOf('、'))
    // Keep a word or clause boundary when there is one in the last third.
    text = (boundary > maxChars * 0.6 ? clipped.slice(0, boundary) : clipped).trim()
  }
  return text
}

/** Render the accepted summary exactly as the chip shows it. */
export function renderSummary(text: string, prefix: string = SEMANTIC_DEFAULTS.prefix): string {
  return `${prefix}${text}`
}

/**
 * Map one turn context onto the narration prompt vocabulary.
 *
 * Tense follows the heuristic phase: work in flight reads as present
 * progressive ("Investigating the timeout"), a settled turn as past ("Fixed the
 * timeout"). The chip itself is hidden once the turn is idle, so `past` exists
 * for the transport's reuse and for callers that render elsewhere.
 */
export function narrationInputFor(context: SemanticContext, maxChars: number = SEMANTIC_DEFAULTS.maxChars): NarrationPromptInput {
  return {
    tense: context.phase === 'done' ? 'past' : 'progressive',
    maxChars,
    lang: context.lang,
    ...(context.newRequest && context.userIntent !== undefined ? { newRequest: context.userIntent } : {}),
    priorUpdates: context.priorUpdates,
    activity: context.activity,
  }
}

/** The narration system message for one context. */
export function systemPrompt(context: SemanticContext, maxChars: number = SEMANTIC_DEFAULTS.maxChars): string {
  return narrationSystemPrompt(narrationInputFor(context, maxChars))
}

/**
 * Frame the context for the model: prior updates as context, the new activity
 * as the evidence, and the closing instruction.
 *
 * The cap is enforced on the whole framed message (a byte-identical promise to
 * the model) rather than on individual fields.
 */
export function frameContext(context: SemanticContext, maxInputChars: number, maxChars: number = SEMANTIC_DEFAULTS.maxChars): string {
  const framed = narrationUserPrompt(narrationInputFor(context, maxChars))
  return framed.length <= maxInputChars ? framed : framed.slice(0, maxInputChars)
}

/** One raw activity line, in the order the turn produced it. */
interface ActivityFact {
  /** Monotonic index across the session, so "consumed" is a number compare. */
  readonly index: number
  /** One line of evidence (`tool: bash psql -c 'select 1'`). */
  readonly text: string
}

/** Format one tool call as raw activity. */
function formatToolActivity(note: SemanticToolNote): string {
  const detail = note.detail === undefined || note.detail === '' ? '' : ` ${note.detail}`
  const outcome = note.failed === true ? ' (failed)' : ''
  return `tool: ${note.name}${detail}${outcome}`
}

/**
 * The per-session classifier: accumulates turn activity, decides when to ask,
 * and owns the single in-flight call.
 *
 * Nothing here is timer-driven from the outside — `notify()` is called from the
 * plugin's event handlers, and the class arms its own debounce timer. Every
 * timer is unref'd so a status line is never the reason a process stays alive.
 */
export class SemanticActivityClassifier {
  private readonly summarize: SemanticClassifierOptions['summarize']
  private readonly now: () => number
  private readonly debounceMs: number
  private readonly maxWaitMs: number
  private readonly minIntervalMs: number
  private readonly maxInputChars: number
  private readonly onSummary: (summary: SemanticSummary) => void
  private readonly onError: (error: unknown) => void
  private readonly onSkip: (reason: 'near-duplicate' | 'identical', text: string) => void
  private readonly prefix: () => string
  private readonly maxChars: number
  private readonly maxTools: number
  private readonly timeoutMs: number

  /** User's latest request (the strongest intent signal), capped at {@link INTENT_MAX_CHARS}. */
  private userIntent?: string
  /** Rolling tool notes, oldest first, capped at {@link SemanticClassifierOptions.maxTools}. */
  private tools: SemanticToolNote[] = []
  /** Tail of the model's own output, capped at {@link TEXT_TAIL_MAX_CHARS}. */
  private assistantText?: string
  /** Characters of model output received this turn (the tail itself is capped). */
  private assistantChars = 0
  /** `assistantChars` when the tail last became an activity line. */
  private assistantActivityChars = 0
  /** Phase last reported by the caller. */
  private phase: ActivityPhase = 'idle'
  /** Language the summary must be written in. */
  private lang: 'zh' | 'en' = 'zh'

  /** Raw activity, oldest first, trimmed to {@link MAX_RETAINED_ACTIVITIES}. */
  private activities: ActivityFact[] = []
  /** Next activity index; starts at 1 so `0` means "nothing accepted yet". */
  private nextActivityIndex = 1
  /** Highest activity index the last accepted update accounted for. */
  private acceptedThrough = 0
  /** Accepted lines, oldest first, capped at {@link MAX_PRIOR_UPDATES}. */
  private priorUpdates: string[] = []
  /** A brand-new user request is pending: it jumps the queue (pi-bar's `immediate`). */
  private immediate = false

  private timer?: ReturnType<typeof setTimeout>
  /** When the last call was dispatched (0 = never), for the interval floor. */
  private lastDispatchAt = 0
  /** Start of the current signal burst, for {@link SemanticClassifierOptions.maxWaitMs}. */
  private burstStartedAt?: number
  /** Fingerprint of the pending activity the last dispatch used. */
  private lastFingerprint?: string
  /** The in-flight call, if any. */
  private inFlight?: { controller: AbortController }
  /** A signal arrived while a call was in flight; re-run when it settles. */
  private dirty = false
  /** Accept/reject state for callbacks after disposal. */
  private disposed = false
  /** Monotonic accepted-summary counter. */
  private revision = 0
  /** Last accepted text, so an identical rephrasing is not a chip update. */
  private lastText?: string
  /** Epoch ms of the last accepted summary. */
  private lastAcceptedAt?: number

  constructor(options: SemanticClassifierOptions) {
    this.summarize = options.summarize
    this.now = options.now ?? Date.now
    this.debounceMs = Math.max(0, options.debounceMs ?? SEMANTIC_DEFAULTS.debounceMs)
    this.maxWaitMs = Math.max(this.debounceMs, options.maxWaitMs ?? SEMANTIC_DEFAULTS.maxWaitMs)
    this.minIntervalMs = Math.max(0, options.minIntervalMs ?? SEMANTIC_DEFAULTS.minIntervalMs)
    this.maxInputChars = Math.max(200, options.maxInputChars ?? SEMANTIC_DEFAULTS.maxInputChars)
    this.onSummary = options.onSummary
    this.onError = options.onError ?? (() => {})
    this.onSkip = options.onSkip ?? (() => {})
    const prefix = options.prefix
    this.prefix = typeof prefix === 'function' ? prefix : () => prefix ?? SEMANTIC_DEFAULTS.prefix
    this.maxChars = Math.max(8, options.maxChars ?? SEMANTIC_DEFAULTS.maxChars)
    this.maxTools = Math.max(1, options.maxTools ?? SEMANTIC_DEFAULTS.maxTools)
    this.timeoutMs = Math.max(1, options.timeoutMs ?? SEMANTIC_DEFAULTS.timeoutMs)
  }

  /** Drop provisional stream text whose attempt was abandoned or partially settled. */
  clearProvisionalText(): void {
    // The activity already recorded stands: it describes work that happened.
    this.assistantText = undefined
    this.assistantChars = 0
    this.assistantActivityChars = 0
  }

  /** Record the user's latest request (the intent anchor). */
  noteUserIntent(text: string, at: number = this.now()): void {
    const trimmed = text.replace(/\s+/g, ' ').trim()
    if (trimmed === '') return
    this.userIntent = trimmed.length > INTENT_MAX_CHARS ? trimmed.slice(0, INTENT_MAX_CHARS) : trimmed
    // A new request re-anchors the context: the previous turn's tools describe
    // work that is no longer being done.
    this.tools = []
    this.assistantText = undefined
    this.assistantChars = 0
    this.assistantActivityChars = 0
    // The newest request is always worth an update, and it is worth it now:
    // waiting out the burst it starts is what made the chip lag a whole task
    // behind. A near-duplicate of the previous line is still accepted here,
    // because the topic genuinely changed.
    this.immediate = true
    this.pushActivity(`user: ${trimmed}`, at)
  }

  /** Record one tool call (start or settle). */
  noteTool(note: SemanticToolNote, at: number = this.now()): void {
    const previous = this.tools[this.tools.length - 1]
    // A settle for the newest call updates that entry instead of appending a
    // duplicate: start+end is one piece of evidence, not two.
    const isSettle =
      previous !== undefined && previous.name === note.name && note.failed !== undefined && previous.failed === undefined
    if (isSettle) {
      this.tools[this.tools.length - 1] = { ...previous, failed: note.failed }
    } else {
      this.tools.push(note)
      if (this.tools.length > this.maxTools) this.tools = this.tools.slice(-this.maxTools)
    }
    // A successful settle adds no information (the start already described the
    // call); a failure does.
    if (!isSettle) this.pushActivity(formatToolActivity(note), at)
    else if (note.failed === true) this.pushActivity(`tool: ${note.name} failed`, at)
  }

  /** Record a delta of the model's own output (narration or reasoning). */
  noteAssistantText(text: string, at: number = this.now()): void {
    if (text === '') return
    const merged = `${this.assistantText ?? ''}${text}`
    this.assistantText = merged.length > TEXT_TAIL_MAX_CHARS ? merged.slice(-TEXT_TAIL_MAX_CHARS) : merged
    // Growth is measured in characters RECEIVED, not in the retained tail's
    // length: the tail is capped, so measuring it would stop yielding deltas as
    // soon as a long answer filled the cap.
    this.assistantChars += text.length
    if (this.assistantChars - this.assistantActivityChars < ASSISTANT_ACTIVITY_STEP) return
    this.assistantActivityChars = this.assistantChars
    this.pushActivity(`assistant: ${this.assistantText}`, at)
  }

  /**
   * Replace the retained model output with one settled message.
   *
   * A settled message is authoritative over the provisional deltas that
   * preceded it (a partial settlement can commit less text than it streamed),
   * so this REPLACES the tail instead of appending to it.
   */
  noteAssistantMessage(text: string, at: number = this.now()): void {
    const trimmed = text.replace(/\s+/g, ' ').trim()
    if (trimmed === '') return
    this.assistantText = trimmed.length > TEXT_TAIL_MAX_CHARS ? trimmed.slice(-TEXT_TAIL_MAX_CHARS) : trimmed
    // The settled message is the model's own summary of the step, so it is
    // worth recording whole rather than waiting for the next growth step.
    this.assistantChars = trimmed.length
    this.assistantActivityChars = this.assistantChars
    this.pushActivity(`assistant: ${this.assistantText}`, at)
  }

  /** Drop the retained model output at a turn boundary. */
  clearAssistantText(): void {
    this.assistantText = undefined
    this.assistantChars = 0
    this.assistantActivityChars = 0
  }

  /**
   * Track the heuristic phase so the wording stays tense-correct.
   *
   * Only a phase *transition* into a settled phase cancels work. A repeated
   * report of the phase we are already in is noise, and treating it as a settle
   * is a real bug: the plugin re-keys the phase on every fold, and between turns
   * the tracker reports `idle` again immediately after a new `user/message`. If a
   * repeated `idle` aborted, it would cancel the immediate dispatch that the
   * user's own request just armed — the chip would never show what the new
   * request is about until the first tool call landed, which is exactly the
   * staleness the pi-bar cadence exists to remove.
   */
  notePhase(phase: ActivityPhase, _at: number = this.now()): void {
    const previous = this.phase
    this.phase = phase
    if (phase === previous) return
    // `done`/`idle` end the turn: an answer that arrives now would describe work
    // that is over, and the chip is hidden while settled anyway.
    if (phase === 'idle' || phase === 'done') {
      this.abort()
    }
  }

  /** Pin the output language. */
  setLang(lang: 'zh' | 'en'): void {
    this.lang = lang
  }

  /** The currently accepted chip copy (icon included), when there is one. */
  currentText(): string | undefined {
    return this.lastText === undefined ? undefined : renderSummary(this.lastText, this.prefix())
  }

  /** The latest accepted summary, when there is one. */
  current(): SemanticSummary | undefined {
    if (this.lastText === undefined) return undefined
    return { text: this.lastText, at: this.lastAcceptedAt ?? 0, revision: this.revision, source: 'llm' }
  }

  /** Append one raw activity line and arm the debounce. */
  private pushActivity(text: string, at: number): void {
    if (this.disposed) return
    const trimmed = text.replace(/\s+/g, ' ').trim()
    if (trimmed === '') return
    this.activities.push({
      index: this.nextActivityIndex,
      text: trimmed.length > ACTIVITY_LINE_MAX_CHARS ? trimmed.slice(0, ACTIVITY_LINE_MAX_CHARS) : trimmed,
    })
    this.nextActivityIndex += 1
    if (this.activities.length > MAX_RETAINED_ACTIVITIES) {
      this.activities = this.activities.slice(-MAX_RETAINED_ACTIVITIES)
    }
    this.notify(at)
  }

  /** Activity the current chip line does not yet account for. */
  private pendingActivities(): ActivityFact[] {
    return this.activities.filter(activity => activity.index > this.acceptedThrough)
  }

  /** Arm (or re-arm) the debounce timer after a context change. */
  private notify(at: number): void {
    if (this.disposed) return
    this.dirty = true
    if (this.inFlight !== undefined) return
    this.arm(at)
  }

  /**
   * Arm the dispatch timer: a quiet period, capped so a turn that streams
   * without pause still updates, and floored by the minimum interval.
   */
  private arm(at: number): void {
    if (this.timer !== undefined) clearTimeout(this.timer)
    if (this.immediate) {
      // pi-bar's `immediate` priority: a brand-new user request paints the new
      // task at once instead of waiting out the burst the request itself began.
      this.timer = setTimeout(() => {
        this.timer = undefined
        void this.run()
      }, 0)
      this.timer.unref?.()
      return
    }
    if (this.burstStartedAt === undefined) this.burstStartedAt = at
    const quietUntil = at + this.debounceMs
    const cappedUntil = Math.min(quietUntil, this.burstStartedAt + this.maxWaitMs)
    const flooredUntil = Math.max(cappedUntil, this.lastDispatchAt + this.minIntervalMs)
    const delay = Math.max(0, flooredUntil - this.now())
    this.timer = setTimeout(() => {
      this.timer = undefined
      void this.run()
    }, delay)
    // A status line must never keep a process alive on its own.
    this.timer.unref?.()
  }

  /**
   * Fingerprint the *decision inputs*: the pending activity and the intent
   * anchor. Activity indices only move forward and are only consumed when an
   * answer is accepted, so this changes exactly when there is something new to
   * describe — no coarse text-length buckets, which is what let a long tool run
   * look like "nothing changed" for a minute at a time.
   */
  private fingerprint(pending: readonly ActivityFact[]): string {
    const newest = pending[pending.length - 1]
    return `${this.acceptedThrough}\u0000${newest?.index ?? 0}\u0000${pending.length}\u0000${this.userIntent ?? ''}\u0000${this.phase}\u0000${this.immediate ? 'now' : 'next'}`
  }

  /**
   * Dispatch one call if there is new activity worth one.
   *
   * An empty delta is skipped outright: re-asking with the same evidence is
   * exactly how the chip ends up saying the same thing in slightly different
   * words.
   */
  private async run(): Promise<void> {
    if (this.disposed || this.inFlight !== undefined) return
    const pending = this.pendingActivities()
    if (pending.length === 0) {
      this.dirty = false
      this.immediate = false
      return
    }
    const fingerprint = this.fingerprint(pending)
    if (!this.dirty || fingerprint === this.lastFingerprint) {
      this.dirty = false
      return
    }
    this.dirty = false
    this.lastFingerprint = fingerprint
    this.lastDispatchAt = this.now()
    this.burstStartedAt = undefined
    const isNewRequest = this.immediate
    this.immediate = false
    const throughIndex = pending[pending.length - 1]?.index ?? this.acceptedThrough
    const controller = new AbortController()
    this.inFlight = { controller }
    const deadline = setTimeout(() => controller.abort(), this.timeoutMs)
    deadline.unref?.()
    // The context is snapshotted before the await: the answer must describe the
    // activity this call was dispatched for, not whatever arrived meanwhile
    // (that belongs to the next call).
    const context: SemanticContext = {
      ...(this.userIntent === undefined ? {} : { userIntent: this.userIntent }),
      tools: this.tools,
      ...(this.assistantText === undefined || this.assistantText === '' ? {} : { assistantText: this.assistantText }),
      phase: this.phase,
      lang: this.lang,
      activity: pending.map(activity => activity.text),
      priorUpdates: this.priorUpdates,
      newRequest: isNewRequest,
    }
    try {
      const raw = await this.summarize(context, controller.signal)
      if (this.disposed || controller.signal.aborted) return
      // pi-bar's cleanup chain first (paths, versions, markdown, success
      // suffixes), then this module's conservative pass (labels, quotes,
      // trailing period) and the length cap.
      const text = sanitizeSummary(sanitizeNarration(raw, this.maxChars), this.maxChars)
      // Empty output keeps the previous summary (or the heuristic line) and
      // leaves the activity unconsumed, so the next call still accounts for it.
      if (text === '') return
      // Consumed either way: the answer accounted for this activity, even when
      // the chip does not repaint.
      this.acceptedThrough = Math.max(this.acceptedThrough, throughIndex)
      this.priorUpdates = [...this.priorUpdates, text].slice(-MAX_PRIOR_UPDATES)
      if (text === this.lastText) {
        this.onSkip('identical', text)
        return
      }
      // A cosmetic variant of the line already on screen is not an update: it
      // flashes the chip without telling the user anything. The new request
      // case is exempt, because its topic genuinely changed.
      if (!isNewRequest && this.lastText !== undefined && isNearDuplicateNarration(text, this.lastText)) {
        this.onSkip('near-duplicate', text)
        return
      }
      this.lastText = text
      this.lastAcceptedAt = this.now()
      this.revision += 1
      this.onSummary({ text, at: this.lastAcceptedAt, revision: this.revision, source: 'llm' })
    } catch (error) {
      if (!this.disposed && !controller.signal.aborted) this.onError(error)
    } finally {
      clearTimeout(deadline)
      if (this.inFlight?.controller === controller) this.inFlight = undefined
      // Context that arrived mid-flight earns exactly one more call, and only
      // one: `dirty` is cleared by the next `run()` whichever way it goes.
      if (this.dirty && !this.disposed) this.arm(this.now())
    }
  }

  /** Cancel the in-flight call and any pending debounce. */
  private abort(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
    this.dirty = false
    this.immediate = false
    this.burstStartedAt = undefined
    this.inFlight?.controller.abort()
  }

  /** Release the classifier: no timers, no callbacks, no in-flight request. */
  dispose(): void {
    this.disposed = true
    this.abort()
  }
}

/** Cap on the user request kept for framing (a huge paste must not dominate). */
export const INTENT_MAX_CHARS = 1200

/** Cap on the retained tail of the model's own output. */
export const TEXT_TAIL_MAX_CHARS = 800
