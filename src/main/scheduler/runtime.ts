import type { CalendarPublication } from "../../domain/entities/calendar-publication.js";
import type { MeetingEvent } from "../../domain/entities/meeting-event.js";
import type { AppSettings } from "../../domain/entities/settings.js";
import type { MeetingOpenerPort } from "../application/ports/meeting-opener-port.js";
import { createSchedulerState, type SchedulerState } from "./state/index.js";

export interface SchedulerDependencies {
  readonly calendar: {
    readonly refreshCalendarPublication: () => Promise<CalendarPublication>;
    readonly getLastPublication: () => CalendarPublication | null;
    readonly cancelActiveCalendarRefresh: () => void;
    readonly reportCalendarPollError: (error: string, lastEvents: MeetingEvent[] | null) => void;
  };
  readonly settings: {
    readonly get: () => AppSettings;
  };
  readonly opener: MeetingOpenerPort;
}

export interface SchedulerRuntime {
  state: SchedulerState;
  readonly dependencies: SchedulerDependencies;
  lastPollCompletedAt: number;
  pendingForcePollTimer: ReturnType<typeof setTimeout> | null;
  inFlightPoll: Promise<CalendarPublication | null> | null;
  queuedPollRequested: boolean;
  lifecycleGeneration: number;
  firstPollTraced: boolean;
  firstPollStartMs: number;
  lastSentEventsSignature: string | null;
  lastSentDisplaySignature: string | null;
  started: boolean;
}

export function createSchedulerRuntime(dependencies: SchedulerDependencies): SchedulerRuntime {
  return {
    state: createSchedulerState(),
    dependencies,
    lastPollCompletedAt: 0,
    pendingForcePollTimer: null,
    inFlightPoll: null,
    queuedPollRequested: false,
    lifecycleGeneration: 0,
    firstPollTraced: false,
    firstPollStartMs: 0,
    lastSentEventsSignature: null,
    lastSentDisplaySignature: null,
    started: false,
  };
}
