/**
 * The per-session home of accepted semantic summaries — the one place the
 * classifier writes and the HTTP route reads.
 *
 * Why a registry instead of folding the summary into the `workingActivity`
 * session projection: a projection's value is recomputed only when a committed
 * session event folds, and its change feed notifies only when the recomputed
 * value differs by `Object.is` (see `@deepseek-ai/dsh-session-projection`). A
 * classifier answer arrives *between* events — often while one tool has been
 * running for a while with nothing else committed — so an event-driven
 * transport would hold the new chip hostage until the next event, which can be
 * the end of that tool. The route below gives the chip its own cadence without
 * writing anything to the session log.
 *
 * The registry is deliberately tiny and transport-free so it is unit-testable:
 * `src/summary-route.ts` owns HTTP, `src/index.ts` owns classification.
 * @module dsh-working-activity-llm/summary-registry
 */

/** One accepted summary, as served to the client. */
export interface SummarySnapshot {
  /** Session the summary belongs to. */
  readonly sessionId: string
  /** Chip copy with the icon prefix already applied. */
  readonly line: string
  /** Cleaned summary without the prefix. */
  readonly text: string
  /**
   * Monotonic revision for this session. The client compares revisions rather
   * than strings, so a summary that legitimately repeats after a different one
   * still registers as an update.
   */
  readonly revision: number
  /** Epoch ms the summary was accepted. */
  readonly at: number
}

/** Insertion-ordered, session-keyed summary store. */
export class SummaryRegistry {
  private readonly bySession = new Map<string, SummarySnapshot>()

  /**
   * Store one accepted summary.
   * @param snapshot - the summary to publish for its session.
   */
  set(snapshot: SummarySnapshot): void {
    this.bySession.set(snapshot.sessionId, snapshot)
  }

  /**
   * Read one session's current summary.
   * @param sessionId - session to look up.
   * @returns the snapshot, or undefined when no summary was ever accepted.
   */
  get(sessionId: string): SummarySnapshot | undefined {
    return this.bySession.get(sessionId)
  }

  /**
   * Drop one session's summary (called on session disposal, which is also what
   * stops the route from resurrecting a stale chip for a dead session).
   * @param sessionId - session to forget.
   */
  delete(sessionId: string): void {
    this.bySession.delete(sessionId)
  }

  /** Number of sessions currently holding a summary (diagnostics/tests). */
  get size(): number {
    return this.bySession.size
  }
}
