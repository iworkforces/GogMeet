/** Time-to-live for fired-event entries (browser/alert) — keeps the suppressed flag
 * around long enough to dedupe rapid delete-and-readd polls but allows eventual re-fire. */
export const FIRED_EVENT_TTL_MS: number = 15 * 60 * 1000;

import type { EventId, MeetUrl } from "../../../domain/entities/brand.js";

export interface ScheduledEventSnapshot {
  title: string;
  meetUrl: MeetUrl | undefined;
  openAtMs: number;
  startMs: number;
  endMs: number;
}

export interface TimersState {
  timers: Map<EventId, ReturnType<typeof setTimeout>>;
  alertTimers: Map<EventId, ReturnType<typeof setTimeout>>;
  titleTimers: Map<EventId, ReturnType<typeof setTimeout>>;
  countdownIntervals: Map<EventId, ReturnType<typeof setInterval>>;
  clearTimers: Map<EventId, ReturnType<typeof setTimeout>>;
  inMeetingIntervals: Map<EventId, ReturnType<typeof setInterval>>;
  inMeetingEndTimers: Map<EventId, ReturnType<typeof setTimeout>>;
  scheduledEventData: Map<EventId, ScheduledEventSnapshot>;
  firedEvents: Map<EventId, number>;
  alertFiredEvents: Map<EventId, number>;
  alertOwners: Map<EventId, object>;
  /** Tracks events whose countdown has been cancelled to prevent clearHandle/cancel races */
  cancelledEvents: Set<EventId>;
}

export function createTimersState(): TimersState {
  return {
    timers: new Map<EventId, ReturnType<typeof setTimeout>>(),
    alertTimers: new Map<EventId, ReturnType<typeof setTimeout>>(),
    titleTimers: new Map<EventId, ReturnType<typeof setTimeout>>(),
    countdownIntervals: new Map<EventId, ReturnType<typeof setInterval>>(),
    clearTimers: new Map<EventId, ReturnType<typeof setTimeout>>(),
    inMeetingIntervals: new Map<EventId, ReturnType<typeof setInterval>>(),
    inMeetingEndTimers: new Map<EventId, ReturnType<typeof setTimeout>>(),
    scheduledEventData: new Map<EventId, ScheduledEventSnapshot>(),
    firedEvents: new Map<EventId, number>(),
    alertFiredEvents: new Map<EventId, number>(),
    alertOwners: new Map<EventId, object>(),
    cancelledEvents: new Set<EventId>(),
  };
}

/** Clear only timer handles and reset timer Maps; does not touch fired/cancelled state. */
export function clearTimerHandles(s: TimersState): void {
  for (const handle of s.timers.values()) clearTimeout(handle);
  s.timers.clear();

  for (const handle of s.alertTimers.values()) clearTimeout(handle);
  s.alertTimers.clear();
  s.alertOwners.clear();

  for (const handle of s.titleTimers.values()) clearTimeout(handle);
  s.titleTimers.clear();

  for (const handle of s.countdownIntervals.values()) clearInterval(handle);
  s.countdownIntervals.clear();

  for (const handle of s.clearTimers.values()) clearTimeout(handle);
  s.clearTimers.clear();

  for (const handle of s.inMeetingIntervals.values()) clearInterval(handle);
  s.inMeetingIntervals.clear();

  for (const handle of s.inMeetingEndTimers.values()) clearTimeout(handle);
  s.inMeetingEndTimers.clear();

  s.scheduledEventData.clear();
}

/** Clear fired/cancelled suppression Maps/Set. Use to fully reset suppression on hard stop. */
export function clearFiredState(s: TimersState): void {
  s.firedEvents.clear();
  s.alertFiredEvents.clear();
  s.cancelledEvents.clear();
}

/** Clear all timer handles AND fired/cancelled state on the given timers slice. */
export function clearAllTimers(s: TimersState): void {
  clearTimerHandles(s);
  clearFiredState(s);
}
