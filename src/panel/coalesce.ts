/**
 * Returns a scheduler that coalesces concurrent async invocations.
 *
 * When the scheduler is called:
 * - If nothing is running, it starts the work immediately.
 * - If work is already in-flight, it records a single follow-up request
 *   and returns the in-flight promise so the caller can ``await`` the
 *   current run (additional requests while in-flight are collapsed into
 *   that same follow-up, not queued individually).
 * - When the in-flight work finishes (whether it succeeds or throws),
 *   exactly one follow-up run is started if one was requested.
 *
 * This prevents two concurrent calls to ``work`` from racing with each
 * other, while still guaranteeing that a request arriving after the
 * in-flight run started is honoured.
 */
export function coalesceRuns(work: () => Promise<void>): () => Promise<void> {
  let inFlight: Promise<void> | null = null;
  let followUpPending = false;

  async function schedule(): Promise<void> {
    if (inFlight) {
      followUpPending = true;
      // Wait for the in-flight run to settle so this caller doesn't
      // return while work is still running. Swallow errors — the
      // in-flight caller already surfaces them; we're just waiting
      // for the lock to clear so the follow-up can start.
      await inFlight.catch(() => {});
      return;
    }
    const run = (async (): Promise<void> => {
      try {
        await work();
      } finally {
        inFlight = null;
        if (followUpPending) {
          followUpPending = false;
          await schedule();
        }
      }
    })();
    inFlight = run;
    await run;
  }

  return schedule;
}

/**
 * Returns a pair ``[beginRun, superseded]``.
 *
 * ``beginRun()`` increments an internal monotonic counter and returns
 * a snapshot. ``superseded()`` returns ``true`` if another call to
 * ``beginRun()`` has happened since the snapshot was taken, signalling
 * that the current async branch should abort.
 *
 * Usage:
 * ```ts
 * const makeToken = makeRenderToken();
 * // inside async work:
 * const superseded = makeToken();
 * await something();
 * if (superseded()) return;
 * ```
 */
export function makeRenderToken(): () => () => boolean {
  let counter = 0;
  return (): (() => boolean) => {
    counter += 1;
    const snapshot = counter;
    return (): boolean => counter !== snapshot;
  };
}
