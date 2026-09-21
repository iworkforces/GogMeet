import { vi } from "vitest";
import type { CalendarPublication } from "../../src/domain/entities/calendar-publication.js";
import type { AppSettings } from "../../src/domain/entities/settings.js";
import type { MeetingEvent } from "../../src/domain/entities/meeting-event.js";
import { ok } from "../../src/domain/entities/result.js";
import {
  createSchedulerRuntime,
  type SchedulerDependencies,
  type SchedulerRuntime,
} from "../../src/main/scheduler/runtime.js";
import { createMockSettings, okCalendarResult } from "./test-utils.js";

export interface SchedulerTestContext {
  readonly runtime: SchedulerRuntime;
  readonly dependencies: SchedulerDependencies;
  readonly refresh: ReturnType<typeof vi.fn<() => Promise<CalendarPublication>>>;
  readonly cancelRefresh: ReturnType<typeof vi.fn<() => void>>;
  readonly getLastPublication: ReturnType<typeof vi.fn<() => CalendarPublication | null>>;
  readonly reportError: ReturnType<
    typeof vi.fn<(error: string, events: MeetingEvent[] | null) => void>
  >;
  readonly open: ReturnType<typeof vi.fn<SchedulerDependencies["opener"]["open"]>>;
}

export function calendarPublication(generation = 1): CalendarPublication {
  return { publicationGeneration: generation, result: okCalendarResult() };
}

export function schedulerTestContext(
  settings: AppSettings | (() => AppSettings) = createMockSettings(),
  publication: CalendarPublication = calendarPublication(),
): SchedulerTestContext {
  const refresh = vi.fn<() => Promise<CalendarPublication>>().mockResolvedValue(publication);
  const cancelRefresh = vi.fn<() => void>();
  const getLastPublication = vi.fn<() => CalendarPublication | null>().mockReturnValue(publication);
  const reportError = vi.fn<SchedulerDependencies["calendar"]["reportCalendarPollError"]>();
  const open = vi.fn<SchedulerDependencies["opener"]["open"]>().mockResolvedValue(ok(undefined));
  const dependencies: SchedulerDependencies = {
    calendar: {
      refreshCalendarPublication: refresh,
      getLastPublication,
      cancelActiveCalendarRefresh: cancelRefresh,
      reportCalendarPollError: reportError,
    },
    settings: { get: () => (typeof settings === "function" ? settings() : settings) },
    opener: { open },
  };
  return {
    runtime: createSchedulerRuntime(dependencies),
    dependencies,
    refresh,
    cancelRefresh,
    getLastPublication,
    reportError,
    open,
  };
}
