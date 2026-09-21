import type { EventId } from "../../domain/entities/brand.js";
import type { SchedulerRuntime } from "./runtime.js";

/**
 * Determine which event should own the tray title.
 * Policy: earliest startMs among events with an active countdownInterval wins.
 * Updates the tray immediately if ownership changes.
 */
export function resolveActiveTitleEvent(runtime: SchedulerRuntime): void {
  const { state } = runtime;
  // In-meeting events take priority — don't overwrite
  if (state.activeInMeetingEventId && state.inMeetingIntervals.has(state.activeInMeetingEventId)) {
    return;
  }

  // Skip resolution when nothing changed — cached activeTitleEventId is still valid
  if (!state.titleDirty && state.activeTitleEventId !== null) return;

  let bestId: EventId | null = null;
  let bestStartMs = Infinity;

  for (const id of state.countdownIntervals.keys()) {
    const data = state.scheduledEventData.get(id);
    if (data && data.startMs < bestStartMs) {
      bestStartMs = data.startMs;
      bestId = id;
    }
  }

  state.titleDirty = false;
  state.activeTitleEventId = bestId;

  if (bestId) {
    const data = state.scheduledEventData.get(bestId);
    if (data) {
      const remaining = Math.ceil((data.startMs - Date.now()) / 60_000);
      if (remaining > 0) {
        state.onTrayTitleUpdate?.(data.title, remaining);
      }
    }
  } else {
    state.onTrayTitleUpdate?.(null);
  }
}

/**
 * Determine which in-meeting event should own the tray title.
 * Policy: event ending soonest wins.
 */
export function resolveActiveInMeetingEvent(runtime: SchedulerRuntime): void {
  const { state } = runtime;
  // Skip resolution when nothing changed — cached activeInMeetingEventId is still valid
  if (!state.inMeetingDirty && state.activeInMeetingEventId !== null) return;

  let bestId: EventId | null = null;
  let bestEndMs = Infinity;

  for (const id of state.inMeetingIntervals.keys()) {
    const data = state.scheduledEventData.get(id);
    if (data && data.endMs < bestEndMs) {
      bestEndMs = data.endMs;
      bestId = id;
    }
  }

  state.inMeetingDirty = false;
  state.activeInMeetingEventId = bestId;

  if (bestId) {
    const data = state.scheduledEventData.get(bestId);
    if (data) {
      const remaining = Math.ceil((data.endMs - Date.now()) / 60_000);
      if (remaining > 0) {
        state.onTrayTitleUpdate?.(data.title, remaining, true);
      }
    }
  } else {
    // No in-meeting event — fall back to pre-meeting
    resolveActiveTitleEvent(runtime);
  }
}

/**
 * Tear down in-meeting countdown for an event at (or after) end.
 * Captured endMs guards against a stale end timer wiping a rescheduled occurrence.
 */
function finishInMeetingCountdown(
  runtime: SchedulerRuntime,
  eventId: EventId,
  capturedEndMs: number,
  title: string,
): void {
  const { state } = runtime;
  const currentData = state.scheduledEventData.get(eventId);
  // Guard: if the snapshot has been replaced with a newer occurrence (different endMs),
  // this timer is stale — do not touch in-meeting state or the snapshot.
  if (currentData && currentData.endMs !== capturedEndMs) {
    state.inMeetingEndTimers.delete(eventId);
    return;
  }
  const interval = state.inMeetingIntervals.get(eventId);
  if (interval) {
    clearInterval(interval);
  }
  state.inMeetingIntervals.delete(eventId);
  const endTimer = state.inMeetingEndTimers.get(eventId);
  if (endTimer) {
    clearTimeout(endTimer);
  }
  state.inMeetingEndTimers.delete(eventId);
  state.scheduledEventData.delete(eventId);
  if (state.activeInMeetingEventId === eventId) {
    state.activeInMeetingEventId = null;
  }
  state.inMeetingDirty = true;
  resolveActiveInMeetingEvent(runtime);
  console.log(`[scheduler] Meeting ended: "${title}"`);
}

/** Start per-minute countdown showing remaining time until meeting ends */
export function startInMeetingCountdown(
  runtime: SchedulerRuntime,
  eventId: EventId,
  data: { title: string; endMs: number },
): void {
  const { state } = runtime;
  const now = Date.now();
  if (data.endMs <= now) return; // already ended

  const capturedEndMs = data.endMs;

  function tickInMeeting(): void {
    if (eventId !== state.activeInMeetingEventId) return;
    const currentData = state.scheduledEventData.get(eventId);
    if (!currentData) return;
    const remaining = Math.ceil((currentData.endMs - Date.now()) / 60_000);
    if (remaining > 0) {
      state.onTrayTitleUpdate?.(currentData.title, remaining, true);
      return;
    }
    // remaining <= 0: end timeout may have been delayed (sleep); clean up now.
    finishInMeetingCountdown(runtime, eventId, capturedEndMs, currentData.title);
  }

  // Immediate tick + per-minute interval
  const intervalHandle = setInterval(tickInMeeting, 60_000);
  state.inMeetingIntervals.set(eventId, intervalHandle);

  // Resolve ownership, then do first tick
  state.inMeetingDirty = true;
  resolveActiveInMeetingEvent(runtime);

  console.log(`[scheduler] In-meeting countdown started for "${data.title}"`);

  // Set timer to clear at meeting end. Capture endMs so a stale end timer
  // (from a previous occurrence of this id) cannot delete a newer snapshot.
  const endHandle = setTimeout(() => {
    finishInMeetingCountdown(runtime, eventId, capturedEndMs, data.title);
  }, data.endMs - now);

  state.inMeetingEndTimers.set(eventId, endHandle);
}

/**
 * Clear all display-related timers (countdown and in-meeting).
 * Used when clearing tray title after consecutive errors.
 */
export function clearAllDisplayTimers(runtime: SchedulerRuntime): void {
  const { state } = runtime;
  // Only pre-meeting countdown intervals own display sleep blockers.
  for (const handle of state.countdownIntervals.values()) {
    clearInterval(handle);
    state.powerCallbacks?.allowSleep?.();
  }
  state.countdownIntervals.clear();
  for (const handle of state.clearTimers.values()) clearTimeout(handle);
  state.clearTimers.clear();
  for (const handle of state.inMeetingIntervals.values()) clearInterval(handle);
  state.inMeetingIntervals.clear();
  for (const handle of state.inMeetingEndTimers.values()) clearTimeout(handle);
  state.inMeetingEndTimers.clear();
}
