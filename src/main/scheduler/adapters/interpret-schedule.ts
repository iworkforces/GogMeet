import type { EventId } from "../../../domain/entities/brand.js";
import { scheduleAlertTimer, cancelAlertTimer } from "../alert-timer.js";
import { scheduleBrowserTimer, cancelBrowserTimer } from "../browser-timer.js";
import {
  scheduleTitleCountdown,
  cancelTitleCountdown,
  pruneCancelledEvents,
} from "../title-countdown.js";
import { cancelStaleEntries, clearInMeetingState } from "../state/index.js";
import { resolveActiveInMeetingEvent, startInMeetingCountdown } from "../countdown.js";
import type { ScheduleAction, SchedulePlan } from "../core/schedule-types.js";
import type { SchedulerRuntime } from "../runtime.js";

export interface InterpretOptions {
  /** When true, timer callbacks no-op (poll epoch / generation abort). */
  shouldAbort: () => boolean;
}

/**
 * Apply a pure SchedulePlan by mutating scheduler state and arming timers.
 */
export function interpretSchedulePlan(
  runtime: SchedulerRuntime,
  plan: SchedulePlan,
  options: InterpretOptions,
): void {
  const { shouldAbort } = options;

  for (const action of plan.actions) {
    applyAction(runtime, action, shouldAbort);
  }
}

function applyAction(
  runtime: SchedulerRuntime,
  action: ScheduleAction,
  shouldAbort: () => boolean,
): void {
  const s = runtime.state;

  switch (action.type) {
    case "arm-browser":
      scheduleBrowserTimer(
        runtime,
        action.event,
        action.delayMs,
        action.openAtMs,
        action.startMs,
        action.endMs,
        action.graceMs,
        { nativeNotifications: action.notify },
      );
      break;

    case "arm-alert":
      scheduleAlertTimer(
        runtime,
        action.event,
        action.delayMs,
        action.endMs,
        shouldAbort,
        action.alertLeadMs,
        action.openAtMs,
      );
      break;

    case "arm-title":
      scheduleTitleCountdown(
        runtime,
        {
          eventId: action.eventId,
          eventTitle: action.eventTitle,
          startMs: action.startMs,
          endMs: action.endMs,
          now: action.nowMs,
        },
        s.titleTimers,
        s.countdownIntervals,
        s.clearTimers,
      );
      break;

    case "start-in-meeting":
      s.alertOwners.delete(action.eventId);
      s.scheduledEventData.set(action.eventId, {
        title: action.title,
        meetUrl: action.meetUrl,
        openAtMs: action.openAtMs,
        startMs: action.startMs,
        endMs: action.endMs,
      });
      startInMeetingCountdown(runtime, action.eventId, {
        title: action.title,
        endMs: action.endMs,
      });
      break;

    case "cancel-browser":
      cancelBrowserTimer(action.eventId, s.timers);
      break;

    case "cancel-alert":
      cancelAlertTimer(action.eventId, s);
      break;

    case "cancel-title":
      cancelTitleCountdown(
        runtime,
        action.eventId,
        s.titleTimers,
        s.countdownIntervals,
        s.clearTimers,
      );
      break;

    case "clear-fired":
      s.firedEvents.delete(action.eventId);
      break;

    case "clear-alert-fired":
      s.alertFiredEvents.delete(action.eventId);
      break;

    case "clear-in-meeting":
      clearInMeetingState(s, action.eventId);
      break;

    case "delete-snapshot":
      s.alertOwners.delete(action.eventId);
      s.scheduledEventData.delete(action.eventId);
      break;

    case "set-snapshot":
      s.alertOwners.delete(action.eventId);
      s.scheduledEventData.set(action.eventId, action.snapshot);
      break;

    case "update-snapshot":
      s.alertOwners.delete(action.eventId);
      s.scheduledEventData.set(action.eventId, action.snapshot);
      break;

    case "update-title-only": {
      const remaining = Math.ceil((action.startMs - Date.now()) / 60_000);
      if (remaining > 0) s.onTrayTitleUpdate?.(action.title, remaining);
      break;
    }

    case "mark-title-dirty":
      s.titleDirty = true;
      break;

    case "mark-in-meeting-dirty":
      s.inMeetingDirty = true;
      break;

    case "prune-absent": {
      const retain = new Set<EventId>(action.retainIds);
      const onCountdownIntervalCancel = (): void => {
        s.powerCallbacks?.allowSleep?.();
      };
      cancelStaleEntries(s, retain, {
        onBrowserCancel: cancelBrowserTimer,
        onAlertCancel: cancelAlertTimer,
        onCountdownIntervalCancel,
        onPruneCancelledEvents: (activeIds) => pruneCancelledEvents(runtime, activeIds),
      });
      break;
    }

    case "resolve-active-in-meeting":
      resolveActiveInMeetingEvent(runtime);
      break;

    default: {
      const _exhaustive: never = action;
      void _exhaustive;
      break;
    }
  }
}
