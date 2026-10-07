// Working-line dock entry: one dim full-width row above the composer card.
//
// Two sources, one row:
//
// - the host-folded `workingActivity` session projection supplies the phase, the
//   heuristic line (`跑个命令 npm test · 12s`) and the turn's tool count, and is
//   what renders before anything else exists;
// - the semantic summary — what the agent is actually trying to accomplish,
//   asked of a small model by the host half — arrives over the host's own route
//   (see ./summary.ts) and REPLACES the line's text while a turn is live.
//
// The heuristic line is never lost: it is the initial paint, the fallback
// whenever no summary has been accepted, and (via the elapsed re-tick) what
// keeps counting seconds while the classifier is still thinking.
//
// Data path: the host folds the `workingActivity` session projection and ships
// the whole value to clients; the session standard kit's `useProjection` reads
// it by key. Nothing is appended to the session log, and no client-runtime
// patch is involved — the old `ConversationSnapshot.activity` transport is dead
// on the current host line.
//
// The 'conversation.input.dock' SlotMap declaration lives in
// @deepseek-ai/dsh-client-ui-conversation/client (contract/slots.ts) and the
// `useProjection` / `sessionId` standard seats in @deepseek-ai/dsh-client-ui-session/client;
// this entry contributes into the slot without owning it.
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only merges, erased at build time and never required by the bundle:
// the ui-conversation SlotMap entry (the dock seat's owner props) and the
// ui-session standard kit (`useProjection`, `sessionId`). ./activity.ts carries
// this package's own projection-key merge, the key constant, and the view type.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import { ACTIVITY_PROJECTION_KEY, type WorkingActivityView } from './activity.ts'
import { refreshElapsedSuffix } from './elapsed.js'
import { summaryFeed } from './summary.ts'
import css from './WorkingLine.module.css'

/** Full props of the dock entry: the input-zone runtime share (session standard kit). */
export type WorkingLineProps = PropsRuntime<'conversation.input.dock'>

/** Tool-count badge copy (no locale seat: the line text itself is host-composed). */
const TOOLS_LABEL = 'tools this turn'

/** Row attribute the ticker flips while a semantic summary is on screen. */
const SEMANTIC_ATTR = 'data-activity-semantic'

/** One ticker tick. The summary feed self-throttles to the host's cadence. */
const TICK_MS = 1000

/** The one live tick attachment (exactly one dock row exists at a time). */
let tickAttachment: { readonly el: HTMLElement; readonly timer: ReturnType<typeof setInterval> } | undefined

/**
 * Re-paint the row's text node once per second, and poll for a semantic summary
 * on the host's cadence.
 *
 * The projection only pushes when a committed event folds (a handful of pushes
 * per turn), so without this the elapsed text would freeze for the length of a
 * tool, and a summary that arrived between events would not appear until the
 * next one. Two jobs, one timer:
 *
 * 1. re-tick the ONE moving segment of the heuristic line locally (only shapes
 *    the host actually renders are ever replaced — see ./elapsed.js);
 * 2. ask the host for the session's current summary and, when there is one,
 *    swap the text node to it.
 *
 * Imperative on purpose, and hook-free: the component is also invoked as a
 * plain function (the bundle gate reads its tree without a renderer), so it may
 * not own React state. A ref callback plus this module-level slot is enough —
 * React detaches a changed inline ref with `null` first, which is where the
 * previous interval dies; a settled value simply never attaches a new one.
 */
function attachActivityTick(
  el: HTMLElement | null,
  activity: WorkingActivityView | undefined,
  sessionId: string | undefined,
): void {
  if (tickAttachment !== undefined && (el === null || tickAttachment.el !== el)) {
    clearInterval(tickAttachment.timer)
    tickAttachment = undefined
  }
  if (el === null || activity === undefined || activity.live !== true) return
  const row = el.parentElement
  const paint = (): void => {
    const summary = summaryFeed.current(sessionId)
    el.textContent = summary !== undefined
      ? summary.line
      : refreshElapsedSuffix(activity.line, activity, Date.now())
    if (row === null) return
    if (summary !== undefined) {
      row.setAttribute(SEMANTIC_ATTR, '1')
      row.title = summary.text
    } else {
      row.removeAttribute(SEMANTIC_ATTR)
      row.removeAttribute('title')
    }
  }
  paint()
  const timer = setInterval(() => {
    // A hidden tab still needs the elapsed seconds to be right the moment it is
    // looked at, but it does not need a request per second.
    if (typeof document !== 'undefined' && document.hidden) {
      paint()
      return
    }
    void summaryFeed.poll(sessionId).then(paint)
  }, TICK_MS)
  tickAttachment = { el, timer }
}

/**
 * Working-line dock entry: reads the session's latest `workingActivity`
 * projection value and renders the row, or nothing when idle/absent.
 */
export function WorkingLine({ useProjection, sessionId }: WorkingLineProps) {
  // `undefined` is the uniform absence signal: the host unit is unmounted, no
  // frame carried the key for this session yet, or no session is current.
  // Rendering nothing (rather than an empty row) keeps the dock from reserving
  // space ahead of the first committed event.
  //
  // The annotation is load-bearing: `useProjection`'s precise engine type lives
  // in the session kit's own dependency (`@deepseek-ai/dsh-api-session-controller`),
  // which this package deliberately does not install (it would drag the whole
  // client peer closure into the dev tree). The key is pinned in ./activity.ts
  // against the merged table; this keeps the render body checked against the
  // host's view type.
  const activity: WorkingActivityView | undefined = useProjection(ACTIVITY_PROJECTION_KEY)
  if (activity === undefined || activity.phase === 'idle' || activity.line === '') return null
  return (
    <div className={css.line} data-activity-phase={activity.phase}>
      <span className={css.marker} aria-hidden="true">
        <svg className={css.spinnerIcon} viewBox="0 0 24 24" focusable="false">
          <g className={css.spinnerSpin}>
            <path className={css.spinnerRay} d="M12 2.5V6" />
            <path className={css.spinnerRay} d="m18.72 5.28-2.65 2.65" />
            <path className={css.spinnerRay} d="M21.5 12H18" />
            <path className={css.spinnerRay} d="m18.72 18.72-2.65-2.65" />
            <path className={css.spinnerRay} d="M12 21.5V18" />
            <path className={css.spinnerRay} d="m5.28 18.72 2.65-2.65" />
            <path className={css.spinnerRay} d="M2.5 12H6" />
            <path className={css.spinnerRay} d="m5.28 5.28 2.65 2.65" />
          </g>
        </svg>
      </span>
      <span
        className={css.text}
        ref={el => attachActivityTick(el, activity, sessionId === undefined ? undefined : String(sessionId))}
      >
        {activity.line}
      </span>
      {activity.toolCount > 0 && (
        <span className={css.tools} title={`${activity.toolCount} ${TOOLS_LABEL}`}>
          {activity.toolCount}
        </span>
      )}
    </div>
  )
}
