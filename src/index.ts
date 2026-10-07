/**
 * working-activity — a live "working line" for DeepSeek Harness agents.
 *
 * Folds the durable session stream (turn/step/tool/stream events) plus
 * `agent/status` into a playful real-time status line, then publishes it two
 * ways, both optional:
 *
 * - TUI: registers the `${activity}` prompt slot on `ctx.tuiPrompt` when the
 *   TUI is composed; add `${activity}` to `theme.leftPrompt` to see it.
 * - Session log: appends log-only `activity/status` events (never surface
 *   events) for Web and other UI consumers; replay ignores them.
 *
 * The state machine itself lives in `./status.ts` (pure, clock-injected); this
 * module only wires events, the render tick, and the two sinks.
 * @module @deepseek-ai/dsh-working-activity
 */

import { appendFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Session } from '@deepseek-ai/dsh-session'
// Type-only: resolves the agent/status cordis event declaration.
import type { Agent } from '@deepseek-ai/dsh-agent'
// Type-only: resolves the `ctx.settings` service declaration. Never a runtime
// import — the service arrives through `ctx.inject(['settings'])`.
import type {} from '@deepseek-ai/dsh-settings'
import { ActivityTracker, detailFor } from './status.js'
import type { TrackerConfig } from './status.js'
// Type-only: the LLM service face the classifier calls (never a runtime import
// of the package — the service arrives through `ctx.get('llm')`).
import type { LlmRuntime } from '@deepseek-ai/dsh-llm'
import { feedStreamFrame } from './compat/assistant-stream.js'
import { toActivityEvents } from './compat/session-events.js'
import { createActivityProjection, ACTIVITY_PROJECTION_KEY } from './projection.js'
import { registerActivityEventType } from './registration.js'
import { langNow, setLangOverride, t } from './lang.js'
import { DEFAULT_PRESET } from './frames.js'
import { featureOn, type FeatureFlag } from './config.js'
import { SemanticActivityClassifier, renderSummary, SEMANTIC_DEFAULTS } from './semantic.js'
import { createLlmSummarizer, SUMMARY_MAX_OUTPUT_TOKENS, type SummaryRoute } from './llm-summarizer.js'
import { SummaryRegistry } from './summary-registry.js'
import { createSummaryRouteHandler, SUMMARY_ROUTE_PREFIX } from './summary-route.js'
import type { SummaryWebRuntime, SummaryWebServer } from './summary-route.js'
import { createModelsRouteHandler, MODELS_ROUTE_PATH } from './models-route.js'
import type { ModelsLlmService } from './models-route.js'
import type { ActivityEvent } from './activity-event.js'
import type { ActivityState } from './status.js'
import type { ActivityStatusEvent } from './events.js'
// Re-export the event type + SessionEventMap merge: the package root must carry
// the declare-module side effect for consumers resolving the built d.ts.
export type * from './events.js'
export type { SemanticContext, SemanticSummary, SemanticToolNote } from './semantic.js'

export const name = 'working-activity'

/**
 * Settings namespace this plugin's live config is served under. The host derives
 * one settings form per active entry and names it after the entry id, so this is
 * the id the bundle patch mounts (`cordis.patch.yml`) and the id the client page
 * binds through `configForms`.
 */
export const SETTINGS_NAMESPACE = name

/**
 * Configurable knobs; every key has a sane default.
 *
 * The four keys marked live (see the schema for `semanticProvider`) are read
 * through {@link liveString}: the host hands `apply` a cosmokit ref for those,
 * not the plain string this type describes.
 */
export type Config = {
  /** Playful copy pool; false renders plain functional labels. */
  phrases?: boolean
  /** Append `activity/status` session events for UI consumers. Default OFF:
   *  dsh-session's append() cannot mark events ignorable, and the resume
   *  read path refuses logs containing unknown non-ignorable types — every
   *  appended snapshot makes the whole session unresumable. Re-enable only
   *  for a log-replaying consumer on a harness that supports ignorable
   *  appends. The live status line (prompt slot / session events) is
   *  unaffected by this flag. */
  publish?: boolean
  /** Status render tick interval in ms. */
  tickMs?: number
  /** Minimum interval in ms between published events while the line is stable. */
  publishIntervalMs?: number
  /** Maximum displayed detail length (paths/commands/patterns). */
  detailLimit?: number
  /** Exact tool-name → action-copy pools (case-insensitive match). */
  customActions?: Record<string, string[]>
  /** UI language: `auto` follows `DSH_TUI_LANG` → `~/.dsh-tui/lang.json` →
   *  OS locale → zh; `zh`/`en` pin the copy directly. */
  lang?: 'auto' | 'zh' | 'en'
  /** Default frame preset name (informational for UI consumers; the TUI
   *  resolves the persisted `frames` choice itself). */
  frames?: string
  /** lively: full flourish (default) / minimal: functional labels only. */
  mode?: 'lively' | 'minimal'
  /** Per-feature switches; explicit values override `mode` defaults. */
  features?: Record<string, boolean>
  /** Extra thinking phrases appended to the base pool. */
  customPhrases?: string[]
  /** Show an estimated tokens/s prefix while streaming. */
  showTokPerSec?: boolean
  /** Work reminder after this many turn-hours (0 = off). */
  workRemindAt?: number
  /**
   * Append a JSON trace of every distinct rendered line (phase, copy-pool
   * inputs, slot) to the debug log — the only way to answer "why did it say
   * THAT" after the fact, since the line is derived, not stored. Default OFF.
   */
  debugLog?: boolean
  /**
   * Ask a model what the agent is actually trying to accomplish, and show that
   * sentence in the chip instead of the tool-name line while a turn is live.
   *
   * The heuristic line is never lost: it is what the chip shows until the first
   * summary lands, and what it falls back to whenever the model is slow,
   * unreachable, or silent. Default ON — it is the point of this fork — but it
   * costs one auxiliary model call every `semanticMinIntervalMs` of real work,
   * so `semantic: false` returns the plugin to the purely local behaviour.
   */
  semantic?: boolean
  /**
   * Route override for the classifier; supply together with
   * {@link Config.semanticModel}.
   *
   * Omitted (the default) reuses the route the session itself last requested
   * under. Together with the three fields below this is a **live** setting: the
   * schema marks it volatile, which is what puts it on the Plugins page and
   * makes an accepted edit reach the next call without a restart. A running host
   * therefore hands `apply` a cosmokit `Volatile` ref for this key rather than a
   * string, which is why every read goes through {@link liveString}. `null`
   * counts as unset.
   */
  semanticProvider?: string
  /** Model override for the classifier; supply together with {@link Config.semanticProvider}. */
  semanticModel?: string
  /**
   * Explicit reasoning effort for the classifier call (e.g. `low`).
   *
   * Empty (the default) leaves the adapter's own default in place. Set it when
   * the route's default spends the output budget on thinking: a classification
   * task gains nothing from deep reasoning, and an exhausted budget yields no
   * text at all. An effort the model does not declare is rejected by the
   * adapter, so this stays opt-in.
   */
  semanticReasoningEffort?: string
  /** Output budget for one classifier call. Must leave room for a reasoning model's thinking. */
  semanticMaxOutputTokens?: number
  /** Quiet period after the last activity signal before a classifier call is dispatched. */
  semanticDebounceMs?: number
  /** Hard floor between two classifier calls, however busy the turn is. */
  semanticMaxWaitMs?: number
  semanticMinIntervalMs?: number
  /** End-to-end deadline for one classifier call. */
  semanticTimeoutMs?: number
  /** Maximum accepted summary length, in characters. */
  semanticMaxChars?: number
  /** Maximum framed classifier input, in characters. */
  semanticMaxInputChars?: number
  /**
   * Icon prefixed to the summary in the chip; live, like the route above.
   *
   * The built-in default is `'✨ '`. An empty string renders a bare summary and
   * is a value the user chose, not a missing one, so it is kept as-is.
   */
  semanticIcon?: string | null
  /** Client poll interval for the summary while a turn is live, in ms. */
  summaryPollMs?: number
}

// Explicit annotation: the inferred z.dict output references cosmokit's
// Dict through a pnpm-virtual path, which is not portable in declaration
// emit (TS2883) when the dependency graph shifts. The global `Schemastery`
// interface comes from schemastery's own d.ts (declare global).
export const Config: Schemastery<Config> = z.object({
  phrases: z.boolean().default(true),
  publish: z.boolean().default(false),
  tickMs: z.number().step(50).min(100).max(5000).default(500),
  publishIntervalMs: z.number().step(500).min(500).max(30_000).default(2000),
  detailLimit: z.number().step(1).min(8).max(120).default(40),
  customActions: z.dict(z.array(z.string())).default({}),
  lang: z.union(['auto', 'zh', 'en']).default('auto'),
  frames: z.string().default(DEFAULT_PRESET),
  mode: z.union(['lively', 'minimal']).default('lively'),
  features: z.dict(z.boolean()).default({}),
  customPhrases: z.array(z.string()).default([]),
  showTokPerSec: z.boolean().default(false),
  workRemindAt: z.number().min(0).max(24).default(0),
  debugLog: z.boolean().default(false),
  semantic: z.boolean().default(true),
  // The four fields the DSH Plugins page edits live. The `volatile` metadata is
  // what puts a field in the host settings form at all (the settings service
  // derives one form per active Loader entry from the fields marked volatile)
  // and what makes an accepted write land in the running fiber instead of
  // requiring a restart.
  //
  // Marked with `.extra('volatile', true)` rather than through the public
  // `.volatile()`, which is literally this same call
  // (`Schema.prototype.volatile = function () { ...; return this.extra('volatile', true) }`).
  // The only difference is a type-level mode marker that would force `Config` to
  // describe a cosmokit ref where a profile patch still carries a plain string;
  // runtime resolution keys off `meta.volatile`, so the two forms are equivalent.
  //
  // Cadence and budget stay plain: they describe the classifier the plugin built
  // at mount, and there is no page control for them.
  semanticProvider: z.string().default('').extra('volatile', true),
  semanticModel: z.string().default('').extra('volatile', true),
  semanticReasoningEffort: z.string().default('').extra('volatile', true),
  semanticMaxOutputTokens: z.number().step(64).min(64).max(8192).default(SUMMARY_MAX_OUTPUT_TOKENS),
  semanticDebounceMs: z.number().step(50).min(0).max(10_000).default(SEMANTIC_DEFAULTS.debounceMs),
  semanticMaxWaitMs: z.number().step(50).min(0).max(60_000).default(SEMANTIC_DEFAULTS.maxWaitMs),
  semanticMinIntervalMs: z.number().step(100).min(0).max(300_000).default(SEMANTIC_DEFAULTS.minIntervalMs),
  semanticTimeoutMs: z.number().step(100).min(1000).max(120_000).default(SEMANTIC_DEFAULTS.timeoutMs),
  semanticMaxChars: z.number().step(1).min(8).max(200).default(SEMANTIC_DEFAULTS.maxChars),
  semanticMaxInputChars: z.number().step(100).min(400).max(40_000).default(SEMANTIC_DEFAULTS.maxInputChars),
  semanticIcon: z.string().default(SEMANTIC_DEFAULTS.prefix).extra('volatile', true),
  // `step` in schemastery validates `(value - min) % step`, so the minimum and
  // the step have to agree with the default: 200 + n*100 includes 1000.
  summaryPollMs: z.number().step(100).min(200).max(10_000).default(1000),
})

/** Structural view of the TUI prompt service; the real type lives in dsh-tui. */
interface TuiPromptLike {
  register(name: string, initialValue?: string): {
    set(value: string | undefined): void
    dispose(): void
  }
}

/** Resolved plugin configuration after schema defaults. */
interface ResolvedConfig {
  phrases: boolean
  publish: boolean
  tickMs: number
  publishIntervalMs: number
  detailLimit: number
  customActions: Record<string, string[]>
  lang: 'auto' | 'zh' | 'en'
  frames: string
  mode: 'lively' | 'minimal'
  features: Record<string, boolean>
  customPhrases: string[]
  showTokPerSec: boolean
  workRemindAt: number
  debugLog: boolean
  semantic: boolean
  semanticMaxOutputTokens: number
  semanticDebounceMs: number
  semanticMaxWaitMs: number
  semanticMinIntervalMs: number
  semanticTimeoutMs: number
  semanticMaxChars: number
  semanticMaxInputChars: number
  summaryPollMs: number
}

/**
 * Extract the plain text of one `user/message` payload.
 *
 * Structurally typed (rather than imported) so a host payload drift degrades to
 * "no intent anchor" instead of a throw inside an event handler. Only text
 * blocks contribute; attachments, images and unknown block types are ignored
 * because they are not something a one-line summary can be inferred from.
 * @param data - the event's data payload.
 * @returns the joined text, or undefined when the message carries none.
 */
function userMessageText(data: unknown): string | undefined {
  const content = (data as { content?: unknown } | null | undefined)?.content
  if (!Array.isArray(content)) return undefined
  const parts: string[] = []
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue
    const candidate = block as { type?: unknown; text?: unknown }
    if (candidate.type === 'text' && typeof candidate.text === 'string') parts.push(candidate.text)
  }
  const text = parts.join('\n').trim()
  return text === '' ? undefined : text
}

/**
 * Read one live (volatile) config field.
 *
 * A volatile schema field arrives as a cosmokit `Volatile` ref rather than a
 * value, so the current one lives behind `get()`; a plain value is passed
 * through so the same accessor works for programmatic composition and tests.
 * Only a non-string falls back — an empty string is a value the user chose,
 * which matters for `semanticIcon`, where `''` means "no icon".
 * @param value - Raw config field (volatile ref or plain value).
 * @param fallback - Value to use when the field carries no string.
 * @returns The current string value.
 */
function liveString(value: unknown, fallback: string): string {
  const current = value !== null && typeof value === 'object' && 'get' in value
    ? (value as { get(): unknown }).get()
    : value
  return typeof current === 'string' ? current : fallback
}

/**
 * Wire the working-activity plugin.
 * @param ctx - Cordis context (agent loop + session services composed).
 * @param config - Validated plugin config (schema defaults applied).
 */
export function apply(ctx: Context, config: Config = {}): void {
  // Register the event type BEFORE anything can publish or validate: the
  // strict read paths (resume seed validation, persistence load) refuse
  // logs with unknown non-ignorable types. Registration is unconditional —
  // it also protects READING logs written by an earlier publish:true era
  // in processes where publishing itself is off. See registration.ts.
  registerActivityEventType()
  const resolved: ResolvedConfig = {
    // `mode: minimal` renders functional labels only (pi extension parity).
    phrases: config.phrases ?? config.mode !== 'minimal',
    publish: config.publish ?? false,
    tickMs: config.tickMs ?? 500,
    publishIntervalMs: config.publishIntervalMs ?? 2000,
    detailLimit: config.detailLimit ?? 40,
    lang: config.lang ?? 'auto',
    customActions: config.customActions ?? {},
    frames: config.frames ?? DEFAULT_PRESET,
    mode: config.mode ?? 'lively',
    features: config.features ?? {},
    customPhrases: config.customPhrases ?? [],
    showTokPerSec: config.showTokPerSec ?? false,
    workRemindAt: config.workRemindAt ?? 0,
    debugLog: config.debugLog ?? false,
    semantic: config.semantic ?? true,
    semanticMaxOutputTokens: config.semanticMaxOutputTokens ?? SUMMARY_MAX_OUTPUT_TOKENS,
    semanticDebounceMs: config.semanticDebounceMs ?? SEMANTIC_DEFAULTS.debounceMs,
    semanticMaxWaitMs: config.semanticMaxWaitMs ?? SEMANTIC_DEFAULTS.maxWaitMs,
    semanticMinIntervalMs: config.semanticMinIntervalMs ?? SEMANTIC_DEFAULTS.minIntervalMs,
    semanticTimeoutMs: config.semanticTimeoutMs ?? SEMANTIC_DEFAULTS.timeoutMs,
    semanticMaxChars: config.semanticMaxChars ?? SEMANTIC_DEFAULTS.maxChars,
    semanticMaxInputChars: config.semanticMaxInputChars ?? SEMANTIC_DEFAULTS.maxInputChars,
    summaryPollMs: config.summaryPollMs ?? 1000,
  }
  /**
   * The four live (volatile) settings, read at the moment of use.
   *
   * A volatile schema field arrives as a cosmokit `Volatile` ref instead of a
   * value: `get()` re-reads whatever the Plugins page last saved, so
   * snapshotting one into {@link resolved} would silently ignore every later
   * edit.
   */
  const live = {
    provider: (): string => liveString(config.semanticProvider, ''),
    model: (): string => liveString(config.semanticModel, ''),
    reasoningEffort: (): string => liveString(config.semanticReasoningEffort, ''),
    // Not `??`: an empty icon is a deliberate choice (no emoji in front of the
    // chip), and only a missing value may fall back to the built-in default.
    icon: (): string => liveString(config.semanticIcon, SEMANTIC_DEFAULTS.prefix),
  }
  // Trace target for {@link traceLine}: `~/.dsh-tui` mirrors where the UI keeps
  // this plugin's config file; the env var redirects it (tests, bug reports).
  const debugLogPath = resolved.debugLog
    ? process.env.DSH_WORKING_ACTIVITY_DEBUG_LOG
      ?? join(homedir(), '.dsh-tui', 'working-activity-debug.log')
    : undefined
  // A pinned plugin-level language beats the env/file chain; releasing it on
  // dispose restores `auto` for any other composition in the process.
  setLangOverride(resolved.lang)
  ctx.effect(() => () => setLangOverride('auto'), 'working-activity lang override')
  /**
   * One session's live activity state.
   *
   * Every session owns its tracker, its pending wake-up and its publish
   * throttle. A single shared "active session" made the line of a session that
   * stopped emitting events freeze entirely (only the last session to emit was
   * ever redrawn), and made two concurrent sessions — a background session and
   * the one on screen, say — consume each other's throttle state.
   */
  interface SessionRuntime {
    readonly session: Session
    readonly tracker: ActivityTracker
    timer?: NodeJS.Timeout
    lastPublishedLine?: string
    lastPublishedPhase?: string
    lastPublishAt: number
    /** Last line written to the debug trace (dedupe; see {@link traceLine}). */
    lastLoggedLine?: string
    /** LLM activity classifier for this session; absent when the feature cannot run. */
    readonly semantic?: SemanticActivityClassifier
    /** Tool name per in-flight call id, so a settle can flag the note it belongs to. */
    readonly callNames: Map<string, string>
  }

  const runtimes = new Map<Session, SessionRuntime>()
  /**
   * The session whose line currently owns the single TUI prompt slot. The slot
   * is one global seat with no notion of a foreground session, so the
   * most-recently-active session keeps it; the per-session event log above is
   * unaffected by this choice.
   */
  let slotSession: Session | undefined

  // Optional TUI seam: no TUI composed -> no slot, no error. The register()
  // call is itself effect-owned, so fiber disposal unregisters the slot.
  const prompt = ctx.get('tuiPrompt', false) as TuiPromptLike | undefined
  const promptHandle = prompt?.register('activity', undefined)

  /** Tracker knobs shared by the live runtimes and the Web projection. */
  // Feature flags resolve ONCE here (an explicit `features` entry beats the
  // mode default) so every consumer applies the same gates. `features.phrases`
  // folds into the master switch — the schema's `phrases` default must not
  // mask a user's explicit `features: { phrases: false }`.
  const fileLike = { features: resolved.features, mode: resolved.mode }
  const on = (name: FeatureFlag): boolean => featureOn(fileLike, name)
  const trackerConfig: TrackerConfig = {
    phrases: resolved.phrases && on('phrases'),
    detailLimit: resolved.detailLimit,
    showIdle: false,
    features: {
      rareEggs: on('rareEggs'),
      weekend: on('weekend'),
      holidays: on('holidays'),
      nightPhrases: on('nightPhrases'),
      combo: on('combo'),
      failPhrases: on('failPhrases'),
      modelQuips: on('modelQuips'),
      continuePhrases: on('continuePhrases'),
    },
    customPhrases: resolved.customPhrases,
    showTokPerSec: resolved.showTokPerSec,
    workRemindAt: resolved.workRemindAt,
  }

  // Web transport: a client-visible session projection. Registered only when the
  // host provides the registry (the TUI-only composition does not), and only
  // after it is mounted, hence `inject`. One definition serves both host
  // contract shapes — see src/projection.ts for why that is a dual-spelling
  // object rather than a version probe.
  //
  // The live narration overlay is keyed by the projection's own state object:
  // `stateOf` is the only way back from a session to the state a read will see,
  // and it exists on the current line but not on the rc.6-era registry — there
  // the overlay stays empty and settled-message narration carries the line.
  const liveNarration = new WeakMap<object, { narration?: string; lastChunkAt?: number; firstTokenAt?: number }>()
  /** The registry, once injected: `stateOf` is how the overlay finds its state. */
  let projectionService: { stateOf?: (session: Session, key: string) => unknown } | undefined

  /**
   * Publish the tracker's live-only facts for the projected value to overlay.
   *
   * The narration AND the first-token instant: deltas never fold on the
   * current host line, so without the latter the projected line stays in the
   * waiting pool for the whole generation while the model is already writing.
   */
  const noteLiveOverlay = (session: Session, tracker: ActivityTracker): void => {
    const state = projectionService?.stateOf?.(session, ACTIVITY_PROJECTION_KEY)
    if (state === null || typeof state !== 'object') return
    const overlay = tracker.liveState()
    if (overlay.narration === undefined && overlay.firstTokenAt === undefined) return
    liveNarration.set(state, overlay)
  }

  ctx.inject(['sessionProjections'] as never, ((projectionCtx: Context) => {
    const registry = (projectionCtx as unknown as {
      sessionProjections?: {
        register(definition: unknown): () => void
        /** Present on the current line; the rc.6-era registry has no state read. */
        stateOf?: (session: Session, key: string) => unknown
      }
    }).sessionProjections
    if (registry === undefined) return
    projectionService = registry
    registry.register(createActivityProjection({
      trackerConfig,
      customActions: resolved.customActions,
      lang: langNow,
      live: state => (state !== null && typeof state === 'object' ? liveNarration.get(state) : undefined),
    }))
  }) as never)

  // ── The semantic activity chip ────────────────────────────────────────────
  //
  // Architecture: agent events → small/fast classifier model → activity chip.
  // The heuristic tracker above keeps rendering *what is running*; this block
  // adds *what the agent is trying to accomplish*, asked of a model, and ships
  // it to the browser on a channel of its own.
  //
  // Every piece below is optional and fails open: no `llm` service, no
  // `webServer`, or a classifier error simply leaves the chip showing the
  // heuristic line — which is exactly what the plugin did before this fork.
  const summaryRegistry = new SummaryRegistry()
  /**
   * Explicit classifier route, read per call; absent means "reuse the session's
   * own route".
   *
   * Read live rather than captured: both halves come from the settings page, so
   * a change there has to reach the next call, and a half-configured pair (only
   * one field filled in) must keep behaving like no override at all.
   */
  const readSemanticRoute = (): SummaryRoute | undefined => {
    const provider = live.provider()
    const model = live.model()
    return provider !== '' && model !== '' ? { provider, model } : undefined
  }
  /** The host LLM service, when this composition mounts one and the feature is on. */
  const llm = resolved.semantic
    ? ctx.get('llm', false) as (Pick<LlmRuntime, 'stream'> & ModelsLlmService) | undefined
    : undefined

  // The chip's own route, because a session projection cannot express a value
  // that changes between committed events (see src/summary-registry.ts).
  // Injected rather than declared: a TUI-only composition has no web server and
  // must stay unaffected.
  ctx.inject(['webServer', 'webRuntime'] as never, ((routeCtx: Context) => {
    if (!resolved.semantic) return
    const webServer = (routeCtx as unknown as { webServer?: SummaryWebServer }).webServer
    const webRuntime = (routeCtx as unknown as { webRuntime?: SummaryWebRuntime }).webRuntime
    if (webServer === undefined || webRuntime === undefined) return
    webServer.register({
      kind: 'prefix',
      path: SUMMARY_ROUTE_PREFIX,
      handler: createSummaryRouteHandler({
        registry: summaryRegistry,
        trustedHosts: webRuntime.trustedHosts,
        pollMs: resolved.summaryPollMs,
      }),
    })
    // The settings page's dropdown data. Served from the host because the model
    // directory is a host-only face of the LLM service; the page pre-selects the
    // deployment's own default route when one is configured.
    webServer.register({
      kind: 'exact',
      path: MODELS_ROUTE_PATH,
      handler: createModelsRouteHandler({
        llm,
        trustedHosts: webRuntime.trustedHosts,
        defaultSelection: () => {
          const service = ctx.get('agentDefaultModel', false) as
            | { currentSelection?: () => { provider: string; model: string; reasoningEffort?: string } }
            | undefined
          return service?.currentSelection?.()
        },
        // An empty dropdown looks identical to a page that never fetched it, so
        // the directory records what it actually found.
        onBuild: providers => {
          if (debugLogPath === undefined) return
          const entry = {
            at: Date.now(),
            semantic: 'models',
            providers: providers.map(provider => ({
              id: provider.id,
              models: provider.models.length,
              ...(provider.error === undefined ? {} : { error: provider.error }),
            })),
          }
          void appendFile(debugLogPath, `${JSON.stringify(entry)}\n`, 'utf8').catch(() => {})
        },
      }),
    })
  }) as never)

  // The Plugins page edits this plugin's live settings through the host settings
  // service. Two things must line up for that page to exist: the entry's Config
  // carries volatile fields (`semanticProvider` and friends) and this plugin
  // declares that it ships its own page, so the service does not offer a
  // generated form instead. The injected child keeps the dependency optional —
  // a TUI-only composition has no settings service and no settings page.
  //
  // The trace is the only way to see from a log whether the page can appear:
  // the service derives forms from ACTIVE, include-parented entries only, and an
  // entry it skips yields no form and no error anywhere in the process.
  ctx.inject(['settings'], (settingsCtx: Context) => {
    settingsCtx.effect(() => {
      const dispose = settingsCtx.settings.configure({ auto: false }, ctx.fiber)
      // Read the served namespaces once the fiber graph has settled. At mount the
      // plugin's own entry is still LOADING, so `settings.describe()` necessarily
      // omits it — a mount-time read would show the page as missing when it is not.
      const timer = debugLogPath === undefined
        ? undefined
        : setTimeout(() => {
          const forms = settingsCtx.settings.describe()
          void appendFile(
            debugLogPath,
            `${JSON.stringify({
              at: Date.now(),
              semantic: 'settings',
              entry: (ctx.fiber as unknown as { entry?: { id?: string } }).entry?.id,
              writable: settingsCtx.settings.writable,
              namespaces: forms.map(form => form.ns),
              // `auto: false` here is what proves the presentation registered
              // below reached this plugin's own entry rather than another fiber.
              autoGenerate: forms.find(form => form.ns === SETTINGS_NAMESPACE)?.autoGenerate ?? null,
            })}\n`,
            'utf8',
          ).catch(() => {})
        }, 1_500)
      return () => {
        if (timer !== undefined) clearTimeout(timer)
        dispose()
      }
    }, 'working-activity settings presentation')
  })

  /**
   * Extract the salient argument fragment for one tool call: the same
   * display-oriented picker the line uses, with a raw fallback so the model
   * still sees *something* for a tool whose argument keys it does not know.
   */
  const semanticToolDetail = (name: string, rawArguments: string): string => {
    const parsed = ((): Readonly<Record<string, unknown>> | undefined => {
      if (rawArguments.trim().length === 0) return undefined
      try {
        const value: unknown = JSON.parse(rawArguments)
        return value !== null && typeof value === 'object' && !Array.isArray(value)
          ? value as Readonly<Record<string, unknown>>
          : undefined
      } catch {
        return undefined
      }
    })()
    const known = detailFor(name, parsed, resolved.detailLimit)
    if (known !== '') return known
    const raw = rawArguments.replace(/\s+/g, ' ').trim()
    return raw.length > resolved.detailLimit * 2 ? raw.slice(0, resolved.detailLimit * 2) : raw
  }

  /** Build one session's classifier, or undefined when the feature cannot run. */
  const createSemantic = (session: Session): SemanticActivityClassifier | undefined => {
    if (llm === undefined) return undefined
    const sessionId = String((session as unknown as { id: unknown }).id ?? '')
    const classifier = new SemanticActivityClassifier({
      summarize: createLlmSummarizer({
        llm,
        // The session id must travel with the call: adapters use it as provider
        // routing metadata (`opencode-go` rejects a request without it).
        session: { id: sessionId, requestHeader: () => session.requestHeader() },
        route: () => readSemanticRoute(),
        reasoningEffort: () => live.reasoningEffort(),
        maxOutputTokens: resolved.semanticMaxOutputTokens,
        timeoutMs: resolved.semanticTimeoutMs,
        maxChars: resolved.semanticMaxChars,
        maxInputChars: resolved.semanticMaxInputChars,
      }),
      debounceMs: resolved.semanticDebounceMs,
      maxWaitMs: resolved.semanticMaxWaitMs,
      minIntervalMs: resolved.semanticMinIntervalMs,
      timeoutMs: resolved.semanticTimeoutMs,
      maxChars: resolved.semanticMaxChars,
      maxInputChars: resolved.semanticMaxInputChars,
      prefix: () => live.icon(),
      onSummary: summary => {
        const line = renderSummary(summary.text, live.icon())
        summaryRegistry.set({
          sessionId,
          line,
          text: summary.text,
          revision: summary.revision,
          at: summary.at,
        })
        // The chip is derived and transient, so the debug log is the only place
        // "why did it say THAT" (or "why did it never say anything") can be
        // answered after the fact. Same opt-in switch as the line's trace.
        // `line` is recorded alongside the raw `text` so the trace shows exactly
        // what reached the chip, icon included: `semanticIcon` is a display
        // choice the text alone cannot account for.
        if (debugLogPath !== undefined) {
          void appendFile(
            debugLogPath,
            `${JSON.stringify({ at: summary.at, session: sessionId, semantic: 'summary', revision: summary.revision, text: summary.text, line })}\n`,
            'utf8',
          ).catch(() => {})
        }
      },
      onError: error => {
        // A failed classifier is not a plugin failure: the chip keeps the
        // heuristic line. Only the opt-in debug log records the reason.
        if (debugLogPath !== undefined) {
          void appendFile(
            debugLogPath,
            `${JSON.stringify({ at: Date.now(), session: sessionId, semantic: 'error', error: String((error as Error)?.message ?? error) })}\n`,
            'utf8',
          ).catch(() => {})
        }
      },
      onSkip: (reason, text) => {
        // A withheld answer must be distinguishable from no answer at all:
        // "the chip did not change" is the symptom whose cause this records.
        if (debugLogPath !== undefined) {
          void appendFile(
            debugLogPath,
            `${JSON.stringify({ at: Date.now(), session: sessionId, semantic: 'skip', reason, text })}\n`,
            'utf8',
          ).catch(() => {})
        }
      },
    })
    classifier.setLang(langNow())
    return classifier
  }

  /**
   * Translate one settled piece of turn activity into classifier signals.
   *
   * Only intent-bearing events are forwarded: a tool starting or settling, the
   * model's own words, and a turn boundary. Elapsed-time ticks and phase
   * churn are deliberately absent — they would add cost without adding
   * information about the goal.
   */
  const feedSemantic = (runtime: SessionRuntime, events: readonly ActivityEvent[]): void => {
    const semantic = runtime.semantic
    if (semantic === undefined) return
    for (const event of events) {
      switch (event.kind) {
        case 'tool-start': {
          runtime.callNames.set(event.callId, event.name)
          // Bounded: a pathological turn cannot grow this map without limit.
          if (runtime.callNames.size > 64) {
            const oldest = runtime.callNames.keys().next().value
            if (oldest !== undefined) runtime.callNames.delete(oldest)
          }
          const detail = semanticToolDetail(event.name, event.arguments)
          semantic.noteTool({ name: event.name, ...(detail === '' ? {} : { detail }) }, event.at)
          break
        }
        case 'tool-end': {
          const name = runtime.callNames.get(event.callId)
          runtime.callNames.delete(event.callId)
          if (name !== undefined) semantic.noteTool({ name, failed: event.failed }, event.at)
          break
        }
        case 'stream-delta':
          semantic.noteAssistantText(event.text, event.at)
          break
        case 'stream-reset':
          semantic.clearProvisionalText()
          break
        case 'assistant-settled':
          if (event.text !== undefined) semantic.noteAssistantMessage(event.text, event.at)
          break
        case 'turn-start':
          semantic.clearAssistantText()
          break
        default:
          break
      }
    }
  }

  const runtimeFor = (session: Session): SessionRuntime => {
    let runtime = runtimes.get(session)
    if (runtime === undefined) {
      const semantic = createSemantic(session)
      runtime = {
        session,
        tracker: new ActivityTracker(trackerConfig, Date.now, resolved.customActions),
        lastPublishAt: 0,
        callNames: new Map(),
        ...(semantic === undefined ? {} : { semantic }),
      }
      runtimes.set(session, runtime)
    }
    return runtime
  }

  /** Stop one runtime's pending wake-up. */
  const stopTimer = (runtime: SessionRuntime): void => {
    if (runtime.timer === undefined) return
    clearTimeout(runtime.timer)
    runtime.timer = undefined
  }

  /**
   * Arm the next redraw, if this line has one coming.
   *
   * The tracker knows when its own line can next change (`nextWakeAt`), so an
   * idle or settled line arms nothing at all — the idle CPU of a permanent
   * 500 ms interval is what issue #14 reported. Live phases are additionally
   * capped at the configured tick so a wrong estimate can only make the line
   * fresher, never staler.
   */
  const armTimer = (runtime: SessionRuntime): void => {
    stopTimer(runtime)
    const nowMs = Date.now()
    const wakeAt = runtime.tracker.nextWakeAt(nowMs)
    if (wakeAt === undefined) return
    const phase = runtime.tracker.render(nowMs).phase
    const live = phase !== 'idle' && phase !== 'done'
    const delayMs = Math.max(0, live ? Math.min(wakeAt - nowMs, resolved.tickMs) : wakeAt - nowMs)
    runtime.timer = setTimeout(() => {
      runtime.timer = undefined
      publish(runtime, runtime.tracker.render())
      armTimer(runtime)
    }, delayMs)
    // A status line must never be the reason a process stays alive.
    runtime.timer.unref()
  }

  /**
   * Feed one runtime and republish. Callers snapshot the tracker state at event
   * time and hand it here, so a burst of fast events (e.g. a synchronous tool
   * call+result) cannot lose an intermediate phase; the append itself runs
   * inside a microtask because the session's appending guard is still set while
   * session/event callbacks run.
   */
  const feed = (runtime: SessionRuntime, state: ActivityState): void => {
    slotSession = runtime.session
    // The classifier follows the same phase the line renders, so its wording
    // stays tense-correct and a settled turn cancels any in-flight call.
    runtime.semantic?.notePhase(state.phase)
    publish(runtime, state)
    // A pending wake-up will refresh the line soon enough; re-arming on every
    // streamed token would churn timers at the token rate.
    if (runtime.timer === undefined) armTimer(runtime)
  }

  /**
   * Append one JSON line per distinct rendered line to the debug log (opt-in:
   * {@link Config.debugLog}). The trace carries the derivation inputs — phase,
   * copy pool, slot — because the line itself is derived, so this file is the
   * only place "why did it say THAT" can be answered from.
   */
  const traceLine = (logPath: string, runtime: SessionRuntime, state: ActivityState): void => {
    if (state.line === runtime.lastLoggedLine) return
    runtime.lastLoggedLine = state.line
    const at = Date.now()
    const entry = {
      at,
      session: String((runtime.session as unknown as { id: unknown }).id ?? ''),
      line: state.line,
      ...runtime.tracker.describe(at),
    }
    void appendFile(logPath, `${JSON.stringify(entry)}\n`, 'utf8').catch(() => {
      // A debug log that cannot be written (permissions, disk full) must
      // never break the line itself.
    })
  }

  /** Publish one rendered snapshot: TUI slot update + throttled session event. */
  const publish = (runtime: SessionRuntime, state: ActivityState): void => {
    queueMicrotask(() => {
      const line = state.phase === 'idle' ? undefined : state.line
      if (runtime.session === slotSession) promptHandle?.set(line)
      if (debugLogPath !== undefined) traceLine(debugLogPath, runtime, state)
      if (!resolved.publish) return
      const nowMs = Date.now()
      const lineChanged = state.line !== runtime.lastPublishedLine
      const phaseChanged = state.phase !== runtime.lastPublishedPhase
      // Live phases republish on a throttle so elapsed times stay current;
      // settled phases (idle/done) publish only when the line itself changes.
      const liveThrottle = state.phase !== 'idle' && state.phase !== 'done'
        && nowMs - runtime.lastPublishAt >= resolved.publishIntervalMs
      if (!lineChanged && !phaseChanged && !liveThrottle) return
      // Optional fields must be omitted (not undefined): session append rejects
      // data JSON would discard, and `activity/status` is a lossless-JSON event.
      const payload: ActivityStatusEvent = {
        phase: state.phase,
        line: state.line,
        toolCount: state.toolCount,
        turnElapsedMs: state.turnElapsedMs,
        phaseStartedAt: state.phaseStartedAt,
        ...(state.label === undefined ? {} : { label: state.label }),
        ...(state.detail === undefined ? {} : { detail: state.detail }),
        ...(state.phrase === undefined ? {} : { phrase: state.phrase }),
      }
      try {
        runtime.session.append('activity/status', payload)
        runtime.lastPublishedLine = state.line
        runtime.lastPublishedPhase = state.phase
        runtime.lastPublishAt = nowMs
      } catch {
        // Session closed or the append guard still held: drop this snapshot;
        // the next wake retries the same line.
      }
    })
  }

  ctx.on('session/event', (session, event) => {
    const runtime = runtimeFor(session)
    runtime.tracker.onSessionEvent(event)
    // The classifier reads the same normalized vocabulary the tracker folds, so
    // host-shape knowledge stays in src/compat/* and never reaches the prompt.
    feedSemantic(runtime, toActivityEvents(event))
    // The user's own request is the strongest intent anchor, and it is not part
    // of the activity vocabulary (which describes the agent, not the ask).
    if ((event.type as string) === 'user/message') {
      const intent = userMessageText(event.data)
      if (intent !== undefined) runtime.semantic?.noteUserIntent(intent, event.time)
    }
    // Re-key the live overlay onto the fold's new state object: `apply`
    // returns a fresh cell per fold, so without this the overlay would stay on
    // the previous cell and a read right after a durable event (a tool
    // starting, say) would lose the freshest `⏵` line until the next frame.
    noteLiveOverlay(session, runtime.tracker)
    feed(runtime, runtime.tracker.render())
  })

  // Live model output. On the current host line the durable `assistant/chunk`
  // event this plugin used to fold is gone — streamed deltas arrive as
  // transient `agent/assistant-stream` frames instead — so the realtime half of
  // the line (first-token promotion, `⏵` narration, tok/s) rides on these
  // frames. Subscribed through a cast because the declared dev baseline
  // (`@deepseek-ai/dsh-agent@0.1.0-rc.6`) predates the event; on that corridor
  // the subscription simply never fires and the durable path above still runs.
  // The cursor that orders frames lives with the emitting agent, so a replaced
  // agent (whose revision restarts at 1) is never mistaken for a stale one.
  ctx.on('agent/assistant-stream' as never, (({ agent, frame }: { agent: Agent; frame: unknown }) => {
    const runtime = runtimeFor(agent.session)
    // One mapping, two consumers: the frame cursor advances inside
    // feedStreamFrame, so the classifier must take its return value rather than
    // mapping the same frame a second time (which would yield nothing).
    feedSemantic(runtime, feedStreamFrame(runtime.tracker, agent, frame))
    // Hand the live facts to the projected value as well: a projection folds
    // committed events only, so without this overlay the line a client reads
    // would never carry the model's own `⏵` words — nor learn that the first
    // token already arrived (frames never fold; see src/projection.ts).
    noteLiveOverlay(agent.session, runtime.tracker)
    feed(runtime, runtime.tracker.render())
  }) as never)

  ctx.on('session/disposed', (session) => {
    const runtime = runtimes.get(session)
    if (runtime !== undefined) {
      stopTimer(runtime)
      runtime.semantic?.dispose()
      summaryRegistry.delete(String((session as unknown as { id: unknown }).id ?? ''))
    }
    runtimes.delete(session)
    if (slotSession === session) slotSession = undefined
  })

  ctx.on('agent/status', ({ agent, status }) => {
    const runtime = runtimeFor(agent.session)
    runtime.tracker.onAgentStatus(status)
    feed(runtime, runtime.tracker.render())
  })

  // No interval: each session's next redraw is armed from its own tracker
  // (`nextWakeAt`), so idle and settled lines hold no timer at all. The effect
  // disposer stops every pending wake-up (and every in-flight classifier call)
  // when this fiber unloads.
  ctx.effect(() => () => {
    for (const runtime of runtimes.values()) {
      stopTimer(runtime)
      runtime.semantic?.dispose()
    }
  }, 'working-activity session timers')
}
