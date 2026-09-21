import type { MeetingEvent } from "../../../domain/entities/meeting-event.js";
import type { EventId } from "../../../domain/entities/brand.js";
import type { AppSettings } from "../../../domain/entities/settings.js";
import { isInQuietHours } from "../../../domain/entities/settings.js";
import { isLateJoinEligible } from "../late-join.js";
import type {
  PlanScheduleOptions,
  ScheduleAction,
  SchedulePlan,
  ScheduleSnapshot,
  ScheduledEventSnapshot,
} from "./schedule-types.js";

/** Get milliseconds before meeting start to open browser, based on settings */
export function getOpenBeforeMs(settings: AppSettings): number {
  return settings.openBeforeMinutes * 60 * 1000;
}

/** Don't schedule events that start more than this far in the future */
export const MAX_SCHEDULE_AHEAD_MS: number = 24 * 60 * 60 * 1000;

/**
 * Pure scheduling decisions for a poll of meeting events.
 * No Electron, no timers, no mutation of scheduler state.
 */
export function planSchedule(
  events: readonly MeetingEvent[],
  settings: AppSettings,
  nowMs: number,
  snapshot: ScheduleSnapshot,
  options: PlanScheduleOptions,
): SchedulePlan {
  const actions: ScheduleAction[] = [];
  const activeIds = new Set<EventId>();
  const graceMs = options.lateJoinGraceMs;

  for (const event of events) {
    if (event.isAllDay) continue;

    const startMs = new Date(event.startDate).getTime();
    const endMs = new Date(event.endDate).getTime();
    const openAtMs = startMs - getOpenBeforeMs(settings);
    const delayMs = openAtMs - nowMs;

    if (
      planInProgressEvent(
        event,
        startMs,
        endMs,
        nowMs,
        settings,
        graceMs,
        snapshot,
        activeIds,
        actions,
      )
    ) {
      continue;
    }

    if (delayMs > MAX_SCHEDULE_AHEAD_MS) continue;

    activeIds.add(event.id);

    const skip = planSkipOrReschedule(event, startMs, endMs, openAtMs, snapshot, actions);
    if (skip) continue;

    planFutureTimers(event, delayMs, openAtMs, startMs, endMs, nowMs, settings, snapshot, actions);
  }

  const previousActiveIds = snapshot.previousActiveIds;
  const activeSetChanged =
    previousActiveIds.size !== activeIds.size ||
    [...activeIds].some((id) => !previousActiveIds.has(id));
  if (activeSetChanged) {
    actions.push({ type: "mark-title-dirty" });
    actions.push({ type: "mark-in-meeting-dirty" });
  }

  actions.push({ type: "prune-absent", retainIds: [...activeIds] });
  actions.push({ type: "resolve-active-in-meeting" });

  return { actions, activeIds };
}

function planInProgressEvent(
  event: MeetingEvent,
  startMs: number,
  endMs: number,
  nowMs: number,
  settings: AppSettings,
  graceMs: number,
  snapshot: ScheduleSnapshot,
  activeIds: Set<EventId>,
  actions: ScheduleAction[],
): boolean {
  if (startMs > nowMs) return false;
  if (endMs <= nowMs) return true;

  const lateJoin =
    settings.autoOpenEnabled &&
    isLateJoinEligible(event, startMs, endMs, nowMs, graceMs, {
      firedEvents: snapshot.firedEvents,
    });
  const hasPendingBrowserOpen = snapshot.pendingBrowserIds.has(event.id);
  const preserveBrowserTimer =
    lateJoin ||
    (hasPendingBrowserOpen &&
      !snapshot.firedEvents.has(event.id) &&
      graceMs > 0 &&
      startMs <= nowMs &&
      nowMs < startMs + graceMs &&
      !!event.meetUrl &&
      !event.isAllDay);

  if (!preserveBrowserTimer) {
    actions.push({ type: "cancel-browser", eventId: event.id });
  }
  actions.push({ type: "cancel-alert", eventId: event.id });
  actions.push({ type: "cancel-title", eventId: event.id });

  // Match post-cancel timer map: only arm if no preserved pending browser timer.
  const stillPendingBrowser = preserveBrowserTimer && snapshot.pendingBrowserIds.has(event.id);
  if (lateJoin && !stillPendingBrowser) {
    const quiet =
      settings.quietHoursEnabled &&
      isInQuietHours(new Date(nowMs), settings.quietHoursStart, settings.quietHoursEnd);
    actions.push({
      type: "arm-browser",
      event,
      delayMs: 0,
      openAtMs: startMs,
      startMs,
      endMs,
      notify: settings.nativeNotifications && !quiet,
      graceMs,
    });
  }

  activeIds.add(event.id);

  if (!snapshot.firedEvents.has(event.id)) {
    actions.push({ type: "clear-alert-fired", eventId: event.id });
  }

  if (!snapshot.inMeetingIds.has(event.id)) {
    actions.push({
      type: "start-in-meeting",
      eventId: event.id,
      title: event.title,
      meetUrl: event.meetUrl,
      openAtMs: startMs,
      startMs,
      endMs,
    });
  } else {
    // Already in-meeting: resync if calendar end (or identity fields) changed.
    const prev = snapshot.scheduledEventData.get(event.id);
    if (prev && prev.endMs !== endMs) {
      actions.push({ type: "clear-in-meeting", eventId: event.id });
      actions.push({
        type: "start-in-meeting",
        eventId: event.id,
        title: event.title,
        meetUrl: event.meetUrl,
        openAtMs: startMs,
        startMs,
        endMs,
      });
    } else if (
      prev &&
      (prev.title !== event.title || prev.meetUrl !== event.meetUrl || prev.startMs !== startMs)
    ) {
      actions.push({
        type: "update-snapshot",
        eventId: event.id,
        snapshot: {
          title: event.title,
          meetUrl: event.meetUrl,
          openAtMs: startMs,
          startMs,
          endMs,
        },
      });
    }
  }

  return true;
}

/**
 * @returns true if the event should be skipped (already handled, no timer re-arm).
 */
function planSkipOrReschedule(
  event: MeetingEvent,
  startMs: number,
  endMs: number,
  openAtMs: number,
  snapshot: ScheduleSnapshot,
  actions: ScheduleAction[],
): boolean {
  if (snapshot.firedEvents.has(event.id)) {
    const prevData = snapshot.scheduledEventData.get(event.id);
    if (prevData && prevData.startMs !== startMs) {
      actions.push({ type: "clear-fired", eventId: event.id });
      actions.push({ type: "clear-alert-fired", eventId: event.id });
    } else {
      return true;
    }
  }

  const prevData = snapshot.scheduledEventData.get(event.id);
  if (!prevData) return false;

  const timeChanged = prevData.startMs !== startMs;
  const titleChanged = prevData.title !== event.title;
  const urlChanged = prevData.meetUrl !== event.meetUrl;
  const openAtChanged = prevData.openAtMs !== openAtMs;

  if (!timeChanged && !titleChanged && !urlChanged && !openAtChanged) return true;

  if (!timeChanged) {
    const snapshotUpdate: ScheduledEventSnapshot = {
      title: event.title,
      meetUrl: event.meetUrl,
      openAtMs,
      startMs,
      endMs,
    };
    actions.push({ type: "update-snapshot", eventId: event.id, snapshot: snapshotUpdate });

    if (urlChanged || openAtChanged) {
      actions.push({ type: "cancel-browser", eventId: event.id });
      actions.push({ type: "cancel-alert", eventId: event.id });
      return false;
    }

    if (snapshot.activeTitleEventId === event.id) {
      actions.push({ type: "update-title-only", eventId: event.id, title: event.title, startMs });
    }
    return true;
  }

  actions.push({ type: "cancel-browser", eventId: event.id });
  actions.push({ type: "cancel-alert", eventId: event.id });
  actions.push({ type: "cancel-title", eventId: event.id });
  actions.push({ type: "clear-in-meeting", eventId: event.id });
  actions.push({ type: "delete-snapshot", eventId: event.id });
  actions.push({ type: "clear-fired", eventId: event.id });
  actions.push({ type: "clear-alert-fired", eventId: event.id });
  return false;
}

function planFutureTimers(
  event: MeetingEvent,
  delayMs: number,
  openAtMs: number,
  startMs: number,
  endMs: number,
  nowMs: number,
  settings: AppSettings,
  snapshot: ScheduleSnapshot,
  actions: ScheduleAction[],
): void {
  const effectiveDelay = Math.max(0, delayMs);
  const quiet =
    settings.quietHoursEnabled &&
    isInQuietHours(new Date(nowMs), settings.quietHoursStart, settings.quietHoursEnd);

  // Snapshot is independent of browser open so title countdown, skip/idempotence,
  // and alert paths work when autoOpenEnabled is false.
  const eventSnapshot: ScheduledEventSnapshot = {
    title: event.title,
    meetUrl: event.meetUrl,
    openAtMs,
    startMs,
    endMs,
  };
  actions.push({ type: "set-snapshot", eventId: event.id, snapshot: eventSnapshot });

  if (settings.windowAlert && !quiet && !snapshot.alertFiredEvents.has(event.id)) {
    actions.push({
      type: "arm-alert",
      event,
      delayMs: effectiveDelay,
      endMs,
      alertLeadMs: settings.alertLeadSeconds * 1000,
      openAtMs,
    });
  }

  if (settings.autoOpenEnabled) {
    actions.push({
      type: "arm-browser",
      event,
      delayMs: effectiveDelay,
      openAtMs,
      startMs,
      endMs,
      notify: settings.nativeNotifications && !quiet,
      graceMs: settings.lateJoinGraceMinutes * 60_000,
    });
  }

  actions.push({
    type: "arm-title",
    eventId: event.id,
    eventTitle: event.title,
    startMs,
    endMs,
    nowMs,
  });
}
