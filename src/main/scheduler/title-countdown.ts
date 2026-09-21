import type { EventId } from "../../domain/entities/brand.js";
import { resolveActiveTitleEvent, startInMeetingCountdown } from "./countdown.js";
import type { SchedulerRuntime } from "./runtime.js";

/** How long before meeting start to show the tray title (ms) */
const TITLE_BEFORE_MS: number = 30 * 60 * 1000; // 30 minutes

export { TITLE_BEFORE_MS };

/** Frozen snapshot for title countdown params */
export interface TitleCountdownParams {
  eventId: EventId;
  eventTitle: string;
  startMs: number;
  endMs: number;
  now: number;
}

/** Compute whole minutes remaining until startMs and update tray */
function tickCountdown(runtime: SchedulerRuntime, params: TitleCountdownParams): void {
  const { state } = runtime;
  // Only update tray if this event currently owns the title
  if (params.eventId !== state.activeTitleEventId) return;
  const data = state.scheduledEventData.get(params.eventId);
  if (!data) return;
  const remaining = Math.ceil((data.startMs - Date.now()) / 60_000);
  if (remaining > 0) {
    state.onTrayTitleUpdate?.(data.title, remaining);
  }
}

/** Start per-minute countdown interval and schedule clear at startMs */
function startCountdown(
  runtime: SchedulerRuntime,
  params: TitleCountdownParams,
  countdownIntervals: Map<EventId, ReturnType<typeof setInterval>>,
  clearTimers: Map<EventId, ReturnType<typeof setTimeout>>,
): void {
  const { state } = runtime;
  // Guard: bail if event was deleted between titleTimer fire and now
  if (!state.scheduledEventData.has(params.eventId)) return;

  // Clear any stale cancellation marker from prior scheduling cycles
  state.cancelledEvents.delete(params.eventId);

  state.powerCallbacks?.preventSleep?.();
  tickCountdown(runtime, params);
  const intervalHandle = setInterval(() => {
    tickCountdown(runtime, params);
  }, 60_000);
  countdownIntervals.set(params.eventId, intervalHandle);
  state.titleDirty = true;
  console.log(`[scheduler] Countdown started for "${params.eventTitle}"`);

  // Resolve ownership so tray title reflects earliest-starting meeting
  resolveActiveTitleEvent(runtime);

  const clearHandle = setTimeout(
    () => {
      // If cancel ran first, skip cleanup to avoid double allowSleep / stale Map mutation
      if (state.cancelledEvents.has(params.eventId)) {
        state.cancelledEvents.delete(params.eventId);
        clearTimers.delete(params.eventId);
        return;
      }
      // Clear pre-meeting countdown
      const countdown = countdownIntervals.get(params.eventId);
      if (countdown) {
        clearInterval(countdown);
      }
      countdownIntervals.delete(params.eventId);
      state.titleDirty = true;
      state.powerCallbacks?.allowSleep?.();
      clearTimers.delete(params.eventId);
      if (state.activeTitleEventId === params.eventId) {
        state.activeTitleEventId = null;
      }

      // Start in-meeting countdown
      const data = state.scheduledEventData.get(params.eventId);
      if (data) {
        startInMeetingCountdown(runtime, params.eventId, data);
      } else {
        resolveActiveTitleEvent(runtime);
      }

      console.log(`[scheduler] Meeting started: "${params.eventTitle}"`);
    },
    Math.max(0, params.startMs - Date.now()),
  );
  clearTimers.set(params.eventId, clearHandle);
}

/**
 * Schedule title countdown timers for a meeting event.
 * Manages: title timer, countdown interval, clear timer.
 */
export function scheduleTitleCountdown(
  runtime: SchedulerRuntime,
  params: TitleCountdownParams,
  titleTimers: Map<EventId, ReturnType<typeof setTimeout>>,
  countdownIntervals: Map<EventId, ReturnType<typeof setInterval>>,
  clearTimers: Map<EventId, ReturnType<typeof setTimeout>>,
): void {
  // Cancel any existing title/countdown/clear timers before (re-)scheduling
  cancelTitleCountdown(runtime, params.eventId, titleTimers, countdownIntervals, clearTimers);

  const titleAtMs = params.startMs - TITLE_BEFORE_MS;
  const titleDelayMs = titleAtMs - params.now;

  if (titleDelayMs > 0) {
    // Title starts in the future — schedule the countdown to begin then
    const titleHandle = setTimeout(() => {
      titleTimers.delete(params.eventId);
      startCountdown(runtime, params, countdownIntervals, clearTimers);
    }, titleDelayMs);
    titleTimers.set(params.eventId, titleHandle);
    console.log(
      `[scheduler] Title timer set for "${params.eventTitle}" in ${Math.round(titleDelayMs / 1000)}s`,
    );
  } else if (params.startMs > params.now) {
    // Already inside the 30-min window — start countdown immediately
    startCountdown(runtime, params, countdownIntervals, clearTimers);
  }
}

/**
 * Cancel title countdown timers for a specific event.
 */
export function cancelTitleCountdown(
  runtime: SchedulerRuntime,
  eventId: EventId,
  titleTimers: Map<EventId, ReturnType<typeof setTimeout>>,
  countdownIntervals: Map<EventId, ReturnType<typeof setInterval>>,
  clearTimers: Map<EventId, ReturnType<typeof setTimeout>>,
): void {
  const { state } = runtime;
  const existingTitle = titleTimers.get(eventId);
  if (existingTitle) {
    clearTimeout(existingTitle);
    titleTimers.delete(eventId);
  }
  const existingCountdown = countdownIntervals.get(eventId);
  if (existingCountdown) {
    state.cancelledEvents.add(eventId);
    clearInterval(existingCountdown);
    state.powerCallbacks?.allowSleep?.();
    state.titleDirty = true;
    countdownIntervals.delete(eventId);
  }
  const existingClear = clearTimers.get(eventId);
  if (existingClear) {
    clearTimeout(existingClear);
    clearTimers.delete(eventId);
  }
}

/**
 * Prune entries from state.cancelledEvents whose id is NOT in activeIds.
 * Called from scheduleEvents() via cancelStaleEntries to prevent unbounded
 * growth of the cancelledEvents Set across the app lifetime.
 */
export function pruneCancelledEvents(
  runtime: SchedulerRuntime,
  activeIds: ReadonlySet<EventId>,
): void {
  const { state } = runtime;
  for (const id of state.cancelledEvents) {
    if (!activeIds.has(id)) {
      state.cancelledEvents.delete(id);
    }
  }
}
