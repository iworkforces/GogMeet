/**
 * Single-flight calendar refresh coordinator.
 *
 * - One in-flight provider/use-case fetch at a time
 * - At most one latest queued follow-up
 * - Monotonic publicationGeneration; latest completion wins for lastPublication
 * - Waiters on an in-flight cycle all resolve to the final publication of that chain
 * - Lifecycle cancel aborts provider work and rejects waiters once
 */

import type { CalendarPublication } from "../../domain/entities/calendar-publication.js";
import type { CalendarResult } from "../../domain/entities/calendar-result.js";

export class CalendarRefreshCancelledError extends Error {
  constructor(message = "Calendar refresh cancelled") {
    super(message);
    this.name = "CalendarRefreshCancelledError";
  }
}

type FetchFn = (signal: AbortSignal) => Promise<CalendarResult>;

export interface CalendarRefreshCoordinator {
  readonly requestRefresh: () => Promise<CalendarPublication>;
  readonly getLastPublication: () => CalendarPublication | null;
  readonly cancel: () => void;
}

export function createCalendarRefreshCoordinator(fetcher: FetchFn): CalendarRefreshCoordinator {
  let nextPublicationGeneration = 1;
  let lifecycleEpoch = 0;
  let lastPublication: CalendarPublication | null = null;

  /** In-flight chain promise (includes follow-ups). Assigned before any await. */
  let chainInFlight: Promise<CalendarPublication> | null = null;
  /** At most one follow-up requested while a fetch is running. */
  let followUpRequested = false;
  /** AbortController for the currently executing provider call. */
  let activeController: AbortController | null = null;

  function getLastPublication(): CalendarPublication | null {
    return lastPublication;
  }

  /**
   * Run the fetcher, rejecting immediately if the signal aborts even when the
   * underlying provider ignores AbortSignal.
   */
  function fetchWithAbort(signal: AbortSignal): Promise<CalendarResult> {
    return new Promise<CalendarResult>((resolve, reject) => {
      if (signal.aborted) {
        reject(new CalendarRefreshCancelledError());
        return;
      }
      const onAbort = (): void => {
        reject(new CalendarRefreshCancelledError());
      };
      signal.addEventListener("abort", onAbort, { once: true });
      void fetcher(signal).then(
        (result) => {
          signal.removeEventListener("abort", onAbort);
          if (signal.aborted) {
            reject(new CalendarRefreshCancelledError());
            return;
          }
          resolve(result);
        },
        (err: unknown) => {
          signal.removeEventListener("abort", onAbort);
          if (signal.aborted) {
            reject(new CalendarRefreshCancelledError());
            return;
          }
          reject(err);
        },
      );
    });
  }

  /**
   * Request a coordinated refresh. Concurrent callers share one chain and all
   * receive the latest publication produced by that chain.
   */
  async function requestRefresh(): Promise<CalendarPublication> {
    if (chainInFlight !== null) {
      followUpRequested = true;
      return chainInFlight;
    }

    const epochAtStart = lifecycleEpoch;

    // Assign chainInFlight before any await so concurrent callers join this chain
    // (including nested requestRefresh from inside a fetcher).
    let resolveChain!: (publication: CalendarPublication) => void;
    let rejectChain!: (reason: unknown) => void;
    const chainPromise = new Promise<CalendarPublication>((resolve, reject) => {
      resolveChain = resolve;
      rejectChain = reject;
    });
    chainInFlight = chainPromise;

    void (async (): Promise<void> => {
      try {
        let latest: CalendarPublication | null = null;
        while (true) {
          if (lifecycleEpoch !== epochAtStart) {
            throw new CalendarRefreshCancelledError();
          }
          const controller = new AbortController();
          activeController = controller;
          const gen = nextPublicationGeneration++;
          try {
            const result = await fetchWithAbort(controller.signal);
            if (lifecycleEpoch !== epochAtStart || controller.signal.aborted) {
              throw new CalendarRefreshCancelledError();
            }
            latest = { publicationGeneration: gen, result };
            if (!followUpRequested) {
              lastPublication = latest;
              resolveChain(latest);
              return;
            }
            // Superseded by queued follow-up: do not set lastPublication yet.
            followUpRequested = false;
          } catch (err) {
            if (lifecycleEpoch !== epochAtStart || controller.signal.aborted) {
              throw new CalendarRefreshCancelledError();
            }
            // Transient fetch failure: if a follow-up is queued, try the latest batch.
            if (followUpRequested) {
              followUpRequested = false;
              continue;
            }
            throw err;
          } finally {
            if (activeController === controller) {
              activeController = null;
            }
          }
        }
      } catch (err) {
        if (lifecycleEpoch !== epochAtStart) {
          rejectChain(new CalendarRefreshCancelledError());
          return;
        }
        rejectChain(err);
      } finally {
        if (chainInFlight === chainPromise) {
          chainInFlight = null;
          followUpRequested = false;
        }
      }
    })();

    return chainPromise;
  }

  /**
   * Abort in-flight provider work and invalidate the current chain.
   * A subsequent request starts clean under a new lifecycle epoch.
   */
  function cancel(): void {
    lifecycleEpoch += 1;
    followUpRequested = false;
    const controller = activeController;
    activeController = null;
    if (controller !== null && !controller.signal.aborted) {
      controller.abort();
    }
    // Waiters reject via fetchWithAbort abort listener / epoch checks.
    // Clear the join handle so new requests start a fresh chain.
    chainInFlight = null;
  }

  return { requestRefresh, getLastPublication, cancel };
}
