import type { EventId, MeetUrl } from "../../../domain/entities/brand.js";
import type { MeetingEvent } from "../../../domain/entities/meeting-event.js";
import type { ScheduledEventSnapshot } from "../state/state-timers.js";

export type { ScheduledEventSnapshot };

/** Pure scheduling decisions produced by planSchedule. */
export type ScheduleAction =
  | {
      type: "arm-browser";
      event: MeetingEvent;
      delayMs: number;
      openAtMs: number;
      startMs: number;
      endMs: number;
      notify: boolean;
      graceMs: number;
    }
  | {
      type: "arm-alert";
      event: MeetingEvent;
      delayMs: number;
      endMs: number;
      alertLeadMs: number;
      openAtMs: number;
    }
  | {
      type: "arm-title";
      eventId: EventId;
      eventTitle: string;
      startMs: number;
      endMs: number;
      nowMs: number;
    }
  | {
      type: "start-in-meeting";
      eventId: EventId;
      title: string;
      meetUrl: MeetUrl | undefined;
      openAtMs: number;
      startMs: number;
      endMs: number;
    }
  | { type: "cancel-browser"; eventId: EventId }
  | { type: "cancel-alert"; eventId: EventId }
  | { type: "cancel-title"; eventId: EventId }
  | { type: "clear-fired"; eventId: EventId }
  | { type: "clear-alert-fired"; eventId: EventId }
  | { type: "clear-in-meeting"; eventId: EventId }
  | { type: "delete-snapshot"; eventId: EventId }
  /** First-write / upsert of schedule snapshot — independent of browser timers. */
  | { type: "set-snapshot"; eventId: EventId; snapshot: ScheduledEventSnapshot }
  | { type: "update-snapshot"; eventId: EventId; snapshot: ScheduledEventSnapshot }
  | { type: "update-title-only"; eventId: EventId; title: string; startMs: number }
  | { type: "mark-title-dirty" }
  | { type: "mark-in-meeting-dirty" }
  | { type: "prune-absent"; retainIds: readonly EventId[] }
  | { type: "resolve-active-in-meeting" };

export interface SchedulePlan {
  readonly actions: readonly ScheduleAction[];
  readonly activeIds: ReadonlySet<EventId>;
}

/** Read-only view of scheduler timer state for pure planning. */
export interface ScheduleSnapshot {
  readonly firedEvents: ReadonlyMap<EventId, number>;
  readonly alertFiredEvents: ReadonlyMap<EventId, number>;
  readonly pendingBrowserIds: ReadonlySet<EventId>;
  readonly scheduledEventData: ReadonlyMap<EventId, ScheduledEventSnapshot>;
  readonly inMeetingIds: ReadonlySet<EventId>;
  readonly activeTitleEventId: EventId | null;
  readonly previousActiveIds: ReadonlySet<EventId>;
}

export interface PlanScheduleOptions {
  readonly lateJoinGraceMs: number;
}
