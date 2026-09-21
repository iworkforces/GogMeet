import type { EventId } from "../../../domain/entities/brand.js";
import type { SchedulerState } from "./index.js";
import { clearAllTimers, clearTimerHandles } from "./state-timers.js";

/**
 * Clear in-meeting timer state for a specific event id.
 * Used when an in-progress event is rescheduled to a future start, so stale
 * intervals/end timers do not keep mutating tray state or delete the new snapshot.
 * Marks in-meeting state dirty if anything changed so resolvers re-run.
 */
export function clearInMeetingState(s: SchedulerState, eventId: EventId): void {
  let changed = false;
  const interval = s.inMeetingIntervals.get(eventId);
  if (interval !== undefined) {
    clearInterval(interval);
    s.inMeetingIntervals.delete(eventId);
    changed = true;
  }
  const endTimer = s.inMeetingEndTimers.get(eventId);
  if (endTimer !== undefined) {
    clearTimeout(endTimer);
    s.inMeetingEndTimers.delete(eventId);
    changed = true;
  }
  if (s.activeInMeetingEventId === eventId) {
    s.activeInMeetingEventId = null;
    changed = true;
  }
  if (changed) {
    s.inMeetingDirty = true;
  }
}

export function clearSchedulerResources(
  s: SchedulerState,
  options?: { preserveFiredState?: boolean; preserveLastKnownEvents?: boolean },
): void {
  if (s.pollTimeout !== null) {
    clearTimeout(s.pollTimeout);
    s.pollTimeout = null;
  }

  // Pre-meeting countdown intervals own display sleep blockers.
  for (let remaining = s.countdownIntervals.size; remaining > 0; remaining -= 1) {
    s.powerCallbacks?.allowSleep?.();
  }

  if (options?.preserveFiredState === true) {
    clearTimerHandles(s);
  } else {
    clearAllTimers(s);
  }

  if (options?.preserveLastKnownEvents !== true) {
    s.lastKnownEvents = null;
  }
}

/**
 * Cancel and remove entries from all timer Maps/Sets that are NOT in activeIds.
 * This consolidates the per-map cleanup loops from scheduleEvents().
 * @param onCountdownCancelled - optional callback invoked when a countdownInterval is cancelled
 *                                (e.g. to allow the system to resume sleep)
 */
export function cancelStaleEntries(
  s: SchedulerState,
  activeIds: Set<EventId>,
  callbacks?: {
    onBrowserCancel?: (id: EventId, timers: Map<EventId, ReturnType<typeof setTimeout>>) => void;
    onAlertCancel?: (id: EventId, alertTimers: Map<EventId, ReturnType<typeof setTimeout>>) => void;
    onCountdownIntervalCancel?: () => void;
    onPruneCancelledEvents?: (activeIds: Set<EventId>) => void;
  },
): void {
  // Browser timers
  for (const [id, handle] of s.timers) {
    if (!activeIds.has(id)) {
      if (callbacks?.onBrowserCancel) {
        callbacks.onBrowserCancel(id, s.timers);
      } else {
        clearTimeout(handle);
        s.timers.delete(id);
      }
      console.debug("[scheduler] Cancelled timer for removed event");
    }
  }
  // Alert timers
  for (const [id, handle] of s.alertTimers) {
    if (!activeIds.has(id)) {
      if (callbacks?.onAlertCancel) {
        callbacks.onAlertCancel(id, s.alertTimers);
      } else {
        clearTimeout(handle);
        s.alertTimers.delete(id);
      }
      console.debug("[scheduler] Cancelled alert timer for removed event");
    }
  }
  // Title timers
  for (const [id, handle] of s.titleTimers) {
    if (!activeIds.has(id)) {
      clearTimeout(handle);
      s.titleTimers.delete(id);
    }
  }
  // Countdown intervals
  for (const [id, handle] of s.countdownIntervals) {
    if (!activeIds.has(id)) {
      clearInterval(handle);
      callbacks?.onCountdownIntervalCancel?.();
      s.countdownIntervals.delete(id);
    }
  }
  // Clear timers
  for (const [id, handle] of s.clearTimers) {
    if (!activeIds.has(id)) {
      clearTimeout(handle);
      s.clearTimers.delete(id);
    }
  }
  // In-meeting intervals
  for (const [id, handle] of s.inMeetingIntervals) {
    if (!activeIds.has(id)) {
      clearInterval(handle);
      s.inMeetingIntervals.delete(id);
    }
  }
  // In-meeting end timers
  for (const [id, handle] of s.inMeetingEndTimers) {
    if (!activeIds.has(id)) {
      clearTimeout(handle);
      s.inMeetingEndTimers.delete(id);
    }
  }
  // Prune Sets
  const nowMs = Date.now();
  for (const [id, expiresAt] of s.firedEvents) {
    if (!activeIds.has(id) && expiresAt < nowMs) {
      s.firedEvents.delete(id);
    }
  }
  for (const [id, expiresAt] of s.alertFiredEvents) {
    if (!activeIds.has(id) && expiresAt < nowMs) {
      s.alertFiredEvents.delete(id);
    }
  }
  // Prune cancelledEvents Set (delegated to title-countdown owner)
  callbacks?.onPruneCancelledEvents?.(activeIds);
  // Prune event data
  for (const id of s.scheduledEventData.keys()) {
    if (!activeIds.has(id)) {
      s.scheduledEventData.delete(id);
    }
  }
}
