import type { CalendarPublication } from "../../domain/entities/calendar-publication.js";
import type { CalendarPort } from "../application/ports/calendar-port.js";
import type { ForcePollOptions } from "../scheduler/facade.js";

export interface CalendarWatcherDependencies {
  readonly getCalendarPort: () => Promise<CalendarPort>;
  readonly forcePoll: (options?: ForcePollOptions) => Promise<CalendarPublication | null>;
}

export interface CalendarWatcher {
  readonly start: () => void;
  readonly stop: () => void;
  readonly revive: () => void;
}

export function createCalendarWatcher(dependencies: CalendarWatcherDependencies): CalendarWatcher {
  let started = false;
  let watchPort: CalendarPort | null = null;
  let pendingPort: Promise<CalendarPort> | null = null;
  let lifecycleGeneration = 0;

  const start = (): void => {
    if (started) return;

    started = true;
    const generation = ++lifecycleGeneration;
    const portPromise = dependencies.getCalendarPort();
    pendingPort = portPromise;

    void portPromise
      .then((port) => {
        if (!started || lifecycleGeneration !== generation) return;

        watchPort = port;
        pendingPort = null;
        if (port.startWatch) {
          port.startWatch(() => {
            if (started && lifecycleGeneration === generation) {
              void dependencies.forcePoll({ reason: "watch" }).catch((err: unknown) => {
                console.warn("[calendar-watcher] watch poll failed:", err);
              });
            }
          });
          console.log("[calendar-watcher] Watch started");
        } else {
          console.log("[calendar-watcher] No watch (poll-only)");
        }
      })
      .catch((err: unknown) => {
        if (started && lifecycleGeneration === generation) {
          pendingPort = null;
          console.warn("[calendar-watcher] Failed to start watch:", err);
        }
      });
  };

  const stop = (): void => {
    if (!started && watchPort === null) return;

    started = false;
    ++lifecycleGeneration;
    pendingPort = null;
    try {
      watchPort?.stopWatch?.();
    } catch (err) {
      console.warn("[calendar-watcher] stopWatch failed:", err);
    }
    watchPort = null;
    console.log("[calendar-watcher] Stopped");
  };

  const revive = (): void => {
    if (!started) return;

    if (watchPort?.reviveWatch) {
      try {
        watchPort.reviveWatch();
      } catch (err) {
        console.warn("[calendar-watcher] revive failed:", err);
      }
      return;
    }

    const portPromise = pendingPort;
    if (portPromise === null) return;

    const generation = lifecycleGeneration;
    void portPromise
      .then((port) => {
        if (started && lifecycleGeneration === generation) {
          port.reviveWatch?.();
        }
      })
      .catch((err: unknown) => {
        if (started && lifecycleGeneration === generation) {
          console.warn("[calendar-watcher] revive failed:", err);
        }
      });
  };

  return { start, stop, revive };
}
