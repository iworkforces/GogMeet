import type { BrowserWindow } from "electron";
import type { EventId } from "../../domain/entities/brand.js";
import type { CalendarResult } from "../../domain/entities/calendar-result.js";
import type { CalendarPublication } from "../../domain/entities/calendar-publication.js";
import { isPerfTraceEnabled, perfTrace } from "../utils/performance-trace.js";
import { cancelPendingBrowserOpenForState } from "./cancel-pending-browser-open.js";
import { poll, republishUiForDisplayTick as republishUi } from "./poll.js";
import {
  createSchedulerRuntime,
  type SchedulerDependencies,
  type SchedulerRuntime,
} from "./runtime.js";
import { clearSchedulerResources } from "./state/index.js";
import type { PowerCallbacks } from "./state/state-runtime.js";

const FORCE_POLL_COALESCE_MS = 10_000;

export type ForcePollReason = "user" | "auto" | "watch" | "power";

export type ForcePollOptions = {
  readonly reason?: ForcePollReason;
};

export interface SchedulerFacade {
  readonly forcePoll: (options?: ForcePollOptions) => Promise<CalendarPublication | null>;
  readonly start: () => void;
  readonly stop: (options?: { readonly preserveFiredState?: boolean }) => void;
  readonly restart: () => void;
  readonly setWindow: (window: BrowserWindow) => void;
  readonly setTrayTitleCallback: (
    callback: (title: string | null, minsRemaining?: number, inMeeting?: boolean) => void,
  ) => void;
  readonly initPowerCallbacks: (callbacks: PowerCallbacks) => void;
  readonly getLastKnownEvents: () => CalendarResult | null;
  readonly republishUiForDisplayTick: () => void;
  readonly cancelPendingBrowserOpen: (id: EventId) => void;
}

export type { SchedulerDependencies };
export type { PowerCallbacks };

function resetRuntimeState(runtime: SchedulerRuntime, preserveFiredState: boolean): void {
  const previousState = runtime.state;
  const firedEvents = preserveFiredState ? new Map(previousState.firedEvents) : null;
  const alertFiredEvents = preserveFiredState ? new Map(previousState.alertFiredEvents) : null;
  const cancelledEvents = preserveFiredState ? new Set(previousState.cancelledEvents) : null;
  const lastKnownEvents = previousState.lastKnownEvents;
  clearSchedulerResources(previousState, {
    preserveFiredState,
    preserveLastKnownEvents: true,
  });

  const nextState = createSchedulerRuntime(runtime.dependencies).state;
  nextState.win = previousState.win;
  nextState.onTrayTitleUpdate = previousState.onTrayTitleUpdate ?? null;
  nextState.powerCallbacks = previousState.powerCallbacks ?? null;
  nextState.lastKnownEvents = lastKnownEvents;
  if (firedEvents !== null) nextState.firedEvents = firedEvents;
  if (alertFiredEvents !== null) nextState.alertFiredEvents = alertFiredEvents;
  if (cancelledEvents !== null) nextState.cancelledEvents = cancelledEvents;
  runtime.state = nextState;
}

export function createSchedulerFacade(
  dependencies: SchedulerDependencies,
  runtime: SchedulerRuntime = createSchedulerRuntime(dependencies),
): SchedulerFacade {
  async function runGuardedPoll(): Promise<CalendarPublication | null> {
    if (runtime.inFlightPoll !== null) {
      runtime.queuedPollRequested = true;
      return runtime.inFlightPoll;
    }
    if (!runtime.firstPollTraced && runtime.firstPollStartMs === 0) {
      runtime.firstPollStartMs = performance.now();
    }
    const run = (async (): Promise<CalendarPublication | null> => {
      while (true) {
        const generation = runtime.lifecycleGeneration;
        const isCurrentGeneration = (): boolean => runtime.lifecycleGeneration === generation;
        let latest: CalendarPublication | null;
        try {
          latest = await poll(runtime, isCurrentGeneration);
        } finally {
          if (isCurrentGeneration()) {
            runtime.lastPollCompletedAt = Date.now();
            if (!runtime.firstPollTraced && isPerfTraceEnabled()) {
              runtime.firstPollTraced = true;
              const startMs = runtime.firstPollStartMs || performance.now();
              perfTrace({
                operation: "startup-phase",
                phase: "first-poll",
                outcome: "ok",
                startMs,
                durationMs: Math.max(0, performance.now() - startMs),
              });
            }
          }
        }
        if (!runtime.queuedPollRequested) return latest;
        runtime.queuedPollRequested = false;
      }
    })();
    runtime.inFlightPoll = run;
    try {
      return await run;
    } finally {
      runtime.inFlightPoll = null;
    }
  }

  function scheduleNextPoll(epoch: number): void {
    runtime.state.pollTimeout = setTimeout(
      async () => {
        runtime.state.pollTimeout = null;
        await runGuardedPoll();
        if (runtime.started && runtime.state.pollEpoch === epoch) {
          scheduleNextPoll(epoch);
        }
      },
      runtime.state.powerCallbacks?.getPollInterval?.() ?? 2 * 60 * 1000,
    );
  }

  async function forcePoll(options?: ForcePollOptions): Promise<CalendarPublication | null> {
    const reason = options?.reason ?? "auto";
    const now = Date.now();
    if (reason !== "user" && now - runtime.lastPollCompletedAt < FORCE_POLL_COALESCE_MS) {
      if (runtime.pendingForcePollTimer === null) {
        const remainingMs = FORCE_POLL_COALESCE_MS - (now - runtime.lastPollCompletedAt);
        runtime.pendingForcePollTimer = setTimeout(() => {
          runtime.pendingForcePollTimer = null;
          void forcePoll({ reason: "auto" });
        }, remainingMs);
      }
      return runtime.inFlightPoll === null ? null : runGuardedPoll();
    }

    if (runtime.pendingForcePollTimer !== null) {
      clearTimeout(runtime.pendingForcePollTimer);
      runtime.pendingForcePollTimer = null;
    }
    if (runtime.state.pollTimeout !== null) {
      clearTimeout(runtime.state.pollTimeout);
      runtime.state.pollTimeout = null;
    }
    runtime.started = true;
    runtime.state.pollEpoch += 1;
    const epoch = runtime.state.pollEpoch;
    const publication = await runGuardedPoll();
    if (runtime.started && runtime.state.pollEpoch === epoch) scheduleNextPoll(epoch);
    return publication;
  }

  function start(): void {
    if (runtime.started) return;
    runtime.started = true;
    runtime.state.pollEpoch += 1;
    const epoch = runtime.state.pollEpoch;
    void runGuardedPoll().then(() => {
      if (
        runtime.started &&
        runtime.state.pollEpoch === epoch &&
        runtime.state.pollTimeout === null
      ) {
        scheduleNextPoll(epoch);
      }
    });
  }

  function stop(options?: { readonly preserveFiredState?: boolean }): void {
    runtime.started = false;
    runtime.lifecycleGeneration += 1;
    runtime.queuedPollRequested = false;
    dependencies.calendar.cancelActiveCalendarRefresh();
    if (runtime.pendingForcePollTimer !== null) {
      clearTimeout(runtime.pendingForcePollTimer);
      runtime.pendingForcePollTimer = null;
    }
    resetRuntimeState(runtime, options?.preserveFiredState ?? false);
    runtime.state.onTrayTitleUpdate?.(null);
    console.log("[scheduler] Stopped");
  }

  function restart(): void {
    stop({ preserveFiredState: true });
    start();
  }

  return {
    forcePoll,
    start,
    stop,
    restart,
    setWindow: (window) => {
      runtime.state.win = window;
    },
    setTrayTitleCallback: (callback) => {
      runtime.state.onTrayTitleUpdate = callback;
    },
    initPowerCallbacks: (callbacks) => {
      runtime.state.powerCallbacks = callbacks;
    },
    getLastKnownEvents: () => runtime.state.lastKnownEvents,
    republishUiForDisplayTick: () => republishUi(runtime),
    cancelPendingBrowserOpen: (id) => cancelPendingBrowserOpenForState(id, runtime.state),
  };
}
