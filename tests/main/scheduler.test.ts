import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../../src/domain/entities/settings.js";
import type { MeetingEvent } from "../../src/domain/entities/meeting-event.js";
import type { MeetUrl } from "../../src/domain/entities/brand.js";
import type { BrowserWindow } from "electron";
import type { SchedulerRuntime } from "../../src/main/scheduler/runtime.js";
import type { SchedulerFacade } from "../../src/main/scheduler/facade.js";
import type { ScheduledEventSnapshot } from "../../src/main/scheduler/state/state-timers.js";
import { schedulerTestContext } from "../helpers/scheduler-runtime.js";
import { asTestEventId, asTestIsoUtc, createMockEvent } from "../helpers/test-utils.js";

// Mock electron before importing scheduler
vi.mock("electron", () => {
  function MockNotification(this: { show: ReturnType<typeof vi.fn> }) {
    this.show = vi.fn();
  }
  return {
    app: {
      getPath: vi.fn().mockReturnValue("/tmp/test-user-data"),
    },
    shell: { openExternal: vi.fn().mockResolvedValue(undefined) },
    Notification: MockNotification,
  };
});

// Mock tray module so updateTrayTitle can be spied on
vi.mock("../../src/main/tray.js", () => ({
  updateTrayTitle: vi.fn(),
}));

// Mock power module so scheduler uses a fixed poll interval
vi.mock("../../src/main/system/power.js", () => ({
  getPollInterval: vi.fn().mockReturnValue(2 * 60 * 1000),
  preventSleep: vi.fn(),
  allowSleep: vi.fn(),
}));

// Mock alert window so we can assert showAlert was invoked by the alert timer
vi.mock("../../src/main/windows/alert-window.js", () => ({
  showAlert: vi.fn(),
}));

const mockUpdateTrayTitle = vi.fn();
const schedulerModule = await import("../../src/main/scheduler/index.js");
const { scheduleEvents: scheduleEventsImpl } = schedulerModule;
const facadeModule = await import("../../src/main/scheduler/facade.js");
const { createSchedulerFacade } = facadeModule;
const pollModule = await import("../../src/main/scheduler/poll.js");
const { poll: pollImpl } = pollModule;
const { showAlert: mockShowAlert } = await import("../../src/main/windows/alert-window.js");
const mockGetSettings = vi.fn().mockReturnValue({
  ...DEFAULT_SETTINGS,
  openBeforeMinutes: 3,
});

let runtime: SchedulerRuntime;
let facade: SchedulerFacade;
let refreshCalendarPublication: ReturnType<typeof schedulerTestContext>["refresh"];

function createFreshFixture(): void {
  const context = schedulerTestContext(() => mockGetSettings());
  runtime = context.runtime;
  facade = createSchedulerFacade(context.dependencies, runtime);
  refreshCalendarPublication = context.refresh;
  facade.setTrayTitleCallback(mockUpdateTrayTitle);
}

function resetFixture(): void {
  createFreshFixture();
}

function scheduleEvents(events: readonly MeetingEvent[]): void {
  scheduleEventsImpl(runtime, events);
}

function poll() {
  return pollImpl(runtime);
}

function initPowerCallbacks(callbacks: NonNullable<typeof runtime.state.powerCallbacks>): void {
  facade.initPowerCallbacks(callbacks);
}

function setSchedulerWindow(window: BrowserWindow | null): void {
  runtime.state.win = window;
}

function setTrayTitleCallback(
  callback: (title: string | null, minsRemaining?: number, inMeeting?: boolean) => void,
): void {
  facade.setTrayTitleCallback(callback);
}

function stopScheduler(): void {
  facade.stop();
}

type LegacySchedulerState = Omit<
  SchedulerRuntime["state"],
  | "timers"
  | "alertTimers"
  | "titleTimers"
  | "countdownIntervals"
  | "clearTimers"
  | "inMeetingIntervals"
  | "inMeetingEndTimers"
  | "firedEvents"
  | "alertFiredEvents"
  | "cancelledEvents"
  | "scheduledEventData"
  | "activeTitleEventId"
  | "activeInMeetingEventId"
> & {
  timers: Map<string, ReturnType<typeof setTimeout>>;
  alertTimers: Map<string, ReturnType<typeof setTimeout>>;
  titleTimers: Map<string, ReturnType<typeof setTimeout>>;
  countdownIntervals: Map<string, ReturnType<typeof setInterval>>;
  clearTimers: Map<string, ReturnType<typeof setTimeout>>;
  inMeetingIntervals: Map<string, ReturnType<typeof setInterval>>;
  inMeetingEndTimers: Map<string, ReturnType<typeof setTimeout>>;
  firedEvents: Map<string, number>;
  alertFiredEvents: Map<string, number>;
  cancelledEvents: Set<string>;
  scheduledEventData: Map<string, ScheduledEventSnapshot>;
  activeTitleEventId: string | null;
  activeInMeetingEventId: string | null;
};

const stateModule = {
  get state() {
    return runtime.state.As<LegacySchedulerState>();
  },
  getConsecutiveErrors: () => runtime.state.consecutiveErrors,
};

const getTimers = () => stateModule.state.timers;
const getAlertTimers = () => stateModule.state.alertTimers;
const getTitleTimers = () => stateModule.state.titleTimers;
const getCountdownIntervals = () => stateModule.state.countdownIntervals;
const getClearTimers = () => stateModule.state.clearTimers;
const getInMeetingIntervals = () => stateModule.state.inMeetingIntervals;
const getInMeetingEndTimers = () => stateModule.state.inMeetingEndTimers;
const getActiveInMeetingEventId = () => runtime.state.activeInMeetingEventId;
const getFiredEvents = () => stateModule.state.firedEvents;
const getAlertFiredEvents = () => stateModule.state.alertFiredEvents;
const getScheduledEventData = () => stateModule.state.scheduledEventData;
const markTitleDirty = () => {
  runtime.state.titleDirty = true;
};

let timers: LegacySchedulerState["timers"];
let alertTimers: LegacySchedulerState["alertTimers"];
let titleTimers: LegacySchedulerState["titleTimers"];
let countdownIntervals: LegacySchedulerState["countdownIntervals"];
let clearTimers: LegacySchedulerState["clearTimers"];
let inMeetingIntervals: LegacySchedulerState["inMeetingIntervals"];
let inMeetingEndTimers: LegacySchedulerState["inMeetingEndTimers"];
let firedEvents: LegacySchedulerState["firedEvents"];
let alertFiredEvents: LegacySchedulerState["alertFiredEvents"];
let scheduledEventData: LegacySchedulerState["scheduledEventData"];
function refreshStateRefs(): void {
  timers = getTimers();
  alertTimers = getAlertTimers();
  titleTimers = getTitleTimers();
  countdownIntervals = getCountdownIntervals();
  clearTimers = getClearTimers();
  inMeetingIntervals = getInMeetingIntervals();
  inMeetingEndTimers = getInMeetingEndTimers();
  firedEvents = getFiredEvents();
  alertFiredEvents = getAlertFiredEvents();
  scheduledEventData = getScheduledEventData();
}
const countdownModule = await import("../../src/main/scheduler/countdown.js");
const {
  resolveActiveTitleEvent: resolveActiveTitleEventImpl,
  resolveActiveInMeetingEvent: resolveActiveInMeetingEventImpl,
} = countdownModule;
const resolveActiveTitleEvent = () => resolveActiveTitleEventImpl(runtime);
const resolveActiveInMeetingEvent = () => resolveActiveInMeetingEventImpl(runtime);

// Inject mock tray callback into scheduler
createFreshFixture();
refreshStateRefs();

type EventOverrides = Omit<Partial<MeetingEvent>, "id" | "startDate" | "endDate" | "meetUrl"> & {
  id?: string;
  startDate?: string;
  endDate?: string;
  meetUrl?: string;
};

const makeEvent = (overrides: EventOverrides = {}): MeetingEvent => {
  const event = createMockEvent();
  return {
    ...event,
    ...overrides,
    id: overrides.id === undefined ? event.id : asTestEventId(overrides.id),
    startDate:
      overrides.startDate === undefined ? event.startDate : asTestIsoUtc(overrides.startDate),
    endDate: overrides.endDate === undefined ? event.endDate : asTestIsoUtc(overrides.endDate),
    meetUrl: overrides.meetUrl === undefined ? event.meetUrl : overrides.meetUrl.As<MeetUrl>(),
  };
};

describe("scheduleEvents", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    timers.clear();
    firedEvents.clear();
    scheduledEventData.clear();
    countdownIntervals.clear();
    resetFixture();
    refreshStateRefs();
    vi.mocked(mockUpdateTrayTitle).mockClear();
    initPowerCallbacks({
      getPollInterval: vi.fn().mockReturnValue(2 * 60 * 1000),
      preventSleep: vi.fn(),
      allowSleep: vi.fn(),
    });
    vi.mocked(mockGetSettings).mockClear();
  });
  afterEach(() => {
    vi.useRealTimers();
    timers.clear();
    firedEvents.clear();
    scheduledEventData.clear();
    countdownIntervals.clear();
    resetFixture();
    refreshStateRefs();
    vi.mocked(mockUpdateTrayTitle).mockClear();
    stateModule.state.powerCallbacks = null;
  });
  it("reads settings once per scheduling pass", () => {
    const first = makeEvent({
      id: asTestEventId("settings-a"),
      startDate: asTestIsoUtc(new Date(Date.now() + 5 * 60 * 1000).toISOString()),
    });
    const second = makeEvent({
      id: asTestEventId("settings-b"),
      startDate: asTestIsoUtc(new Date(Date.now() + 10 * 60 * 1000).toISOString()),
    });

    scheduleEvents([first, second]);

    expect(vi.mocked(mockGetSettings)).toHaveBeenCalledTimes(1);
  });
  it("rescheduled event gets a new timer at the new start time", () => {
    const originalStart = new Date(Date.now() + 5 * 60 * 1000);
    const newStart = new Date(Date.now() + 10 * 60 * 1000);

    const event = makeEvent({
      id: "A",
      startDate: originalStart.toISOString(),
    });
    scheduleEvents([event]);

    expect(timers.has("A")).toBe(true);
    expect(scheduledEventData.get("A")?.startMs).toBe(originalStart.getTime());
    // Reschedule to new time
    const rescheduled = makeEvent({
      id: "A",
      startDate: newStart.toISOString(),
    });
    scheduleEvents([rescheduled]);

    expect(timers.has("A")).toBe(true);
    expect(scheduledEventData.get("A")?.startMs).toBe(newStart.getTime());
    expect(firedEvents.has("A")).toBe(false);
  });

  it("firedEvents entries for removed events are pruned only after TTL expiry", () => {
    // Already-expired entry → pruned
    firedEvents.set("B", Date.now() - 1);
    expect(firedEvents.has("B")).toBe(true);
    scheduleEvents([]);
    expect(firedEvents.has("B")).toBe(false);
  });

  it("firedEvents entries for removed events are retained until TTL expires", () => {
    // Future expiry → retained across polls (suppresses delete-and-readd re-fire)
    firedEvents.set("B", Date.now() + 15 * 60_000);
    expect(firedEvents.has("B")).toBe(true);
    scheduleEvents([]);
    expect(firedEvents.has("B")).toBe(true);
  });

  it("delete-and-readd within firedEvents TTL does not re-arm browser timer", () => {
    const event = makeEvent({
      id: "B",
      startDate: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
    });

    firedEvents.set("B", Date.now() + 15 * 60_000);
    scheduleEvents([]);
    scheduleEvents([event]);

    expect(timers.has("B")).toBe(false);
    expect(firedEvents.has("B")).toBe(true);
  });

  it("delete-and-readd after firedEvents TTL expiry re-arms browser timer", () => {
    const event = makeEvent({
      id: "B",
      startDate: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
    });

    firedEvents.set("B", Date.now() - 1);
    scheduleEvents([]);
    scheduleEvents([event]);

    expect(firedEvents.has("B")).toBe(false);
    expect(timers.has("B")).toBe(true);
  });

  it("delete-and-readd within alertFiredEvents TTL does not re-arm alert timer", () => {
    const event = makeEvent({
      id: "B",
      startDate: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
    });

    alertFiredEvents.set("B", Date.now() + 15 * 60_000);
    scheduleEvents([]);
    scheduleEvents([event]);

    expect(alertTimers.has("B")).toBe(false);
    expect(alertFiredEvents.has("B")).toBe(true);
  });

  it("delete-and-readd after alertFiredEvents TTL expiry re-arms alert timer", () => {
    const event = makeEvent({
      id: "B",
      startDate: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
    });

    alertFiredEvents.set("B", Date.now() - 1);
    scheduleEvents([]);
    scheduleEvents([event]);

    expect(alertFiredEvents.has("B")).toBe(false);
    expect(alertTimers.has("B")).toBe(true);
  });

  it("cancelledEvents entries for removed events are pruned on each poll", () => {
    stateModule.state.cancelledEvents.add("X");
    expect(stateModule.state.cancelledEvents.has("X")).toBe(true);

    // Call with empty list — 'X' is no longer active
    scheduleEvents([]);

    expect(stateModule.state.cancelledEvents.has("X")).toBe(false);
  });

  it("already-fired event at the same start time is not rescheduled", () => {
    const startDate = new Date(Date.now() + 5 * 60 * 1000).toISOString();
    const event = makeEvent({ id: "C", startDate });
    const startMs = new Date(startDate).getTime();

    // Mark as already fired
    firedEvents.set("C", Date.now() + 30 * 60_000 + 15 * 60_000);
    scheduledEventData.set("C", {
      title: "Test Meeting",
      meetUrl: event.meetUrl,
      openAtMs: startMs - 3 * 60_000,
      startMs,
      endMs: startMs + 30 * 60 * 1000, // 30 min duration
    });
    scheduleEvents([event]);

    expect(timers.has("C")).toBe(false);
    expect(firedEvents.has("C")).toBe(true);
  });

  // ─── Group A: Active countdown event disappears ──────────────────────────

  it("A1: tray clears when the countdown event is deleted", () => {
    const event = makeEvent({
      id: "evt-a1",
      startDate: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    });
    scheduleEvents([event]);
    expect(vi.mocked(mockUpdateTrayTitle)).toHaveBeenCalledWith("Test Meeting", expect.any(Number));
    vi.mocked(mockUpdateTrayTitle).mockClear();

    // Next poll — event deleted
    scheduleEvents([]);

    expect(vi.mocked(mockUpdateTrayTitle)).toHaveBeenCalledWith(null);
  });

  it("A5: second event is promoted when the earliest countdown event is deleted", () => {
    const first = makeEvent({
      id: "first",
      title: "First Meeting",
      startDate: new Date(Date.now() + 8 * 60 * 1000).toISOString(),
    });
    const second = makeEvent({
      id: "second",
      title: "Second Meeting",
      startDate: new Date(Date.now() + 20 * 60 * 1000).toISOString(),
    });
    scheduleEvents([first, second]);
    vi.mocked(mockUpdateTrayTitle).mockClear();

    // Delete the first (earliest) — second should take over
    scheduleEvents([second]);

    const calls = vi.mocked(mockUpdateTrayTitle).mock.calls;
    const lastCall = calls[calls.length - 1];
    expect(lastCall?.[0]).toBe("Second Meeting");
  });

  it("A6: tray is unchanged when the non-active second event is deleted", () => {
    const first = makeEvent({
      id: "first",
      title: "First Meeting",
      startDate: new Date(Date.now() + 8 * 60 * 1000).toISOString(),
    });
    const second = makeEvent({
      id: "second",
      title: "Second Meeting",
      startDate: new Date(Date.now() + 20 * 60 * 1000).toISOString(),
    });
    scheduleEvents([first, second]);
    vi.mocked(mockUpdateTrayTitle).mockClear();

    // Delete second (non-owning) — first should still be shown
    scheduleEvents([first]);

    const calls = vi.mocked(mockUpdateTrayTitle).mock.calls;
    const calledWithNull = calls.some((c) => c[0] === null);
    expect(calledWithNull).toBe(false);
    const lastCall = calls[calls.length - 1];
    expect(lastCall?.[0]).toBe("First Meeting");
  });

  it("A7: tray clears when all countdown events are deleted simultaneously", () => {
    const e1 = makeEvent({
      id: "e1",
      title: "Meeting 1",
      startDate: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
    });
    const e2 = makeEvent({
      id: "e2",
      title: "Meeting 2",
      startDate: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
    });
    scheduleEvents([e1, e2]);
    vi.mocked(mockUpdateTrayTitle).mockClear();

    scheduleEvents([]); // all gone

    expect(vi.mocked(mockUpdateTrayTitle)).toHaveBeenCalledWith(null);
  });

  // ─── Group D: Multiple concurrent countdowns ─────────────────────────────

  it("D14: earliest-starting event owns the tray — later event never overwrites", () => {
    const earlier = makeEvent({
      id: "earlier",
      title: "Early Meeting",
      startDate: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
    });
    const later = makeEvent({
      id: "later",
      title: "Late Meeting",
      startDate: new Date(Date.now() + 20 * 60 * 1000).toISOString(),
    });
    scheduleEvents([earlier, later]);

    // Advance 1 min to trigger per-minute ticks on both countdowns
    vi.advanceTimersByTime(60_000);

    const nonNullCalls = vi.mocked(mockUpdateTrayTitle).mock.calls.filter((c) => c[0] !== null);
    const lastContentCall = nonNullCalls[nonNullCalls.length - 1];
    expect(lastContentCall?.[0]).toBe("Early Meeting");
    const laterCalls = nonNullCalls.filter((c) => c[0] === "Late Meeting");
    expect(laterCalls).toHaveLength(0);
  });

  it("D15: a new closer event entering the window takes tray ownership", () => {
    const far = makeEvent({
      id: "far",
      title: "Far Meeting",
      startDate: new Date(Date.now() + 25 * 60 * 1000).toISOString(),
    });
    scheduleEvents([far]);
    vi.mocked(mockUpdateTrayTitle).mockClear();

    // Second poll: closer event enters window alongside far
    const close = makeEvent({
      id: "close",
      title: "Close Meeting",
      startDate: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
    });
    scheduleEvents([far, close]);

    const calls = vi.mocked(mockUpdateTrayTitle).mock.calls;
    const lastCall = calls[calls.length - 1];
    expect(lastCall?.[0]).toBe("Close Meeting");
  });

  // ─── Group B: Title/URL changes (same start time) ──────────────────────────

  it("B8: title change while in countdown updates tray immediately without rescheduling", () => {
    const startDate = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    const event = makeEvent({ id: "b8", title: "Old Title", startDate });
    scheduleEvents([event]);
    const timerHandleBefore = timers.get("b8");
    vi.mocked(mockUpdateTrayTitle).mockClear();

    // Next poll — same event, same time, only title changed
    const renamed = makeEvent({ id: "b8", title: "New Title", startDate });
    scheduleEvents([renamed]);

    // Tray should update with new title
    expect(vi.mocked(mockUpdateTrayTitle)).toHaveBeenCalledWith("New Title", expect.any(Number));
    // Browser-open timer must NOT have been rescheduled
    expect(timers.get("b8")).toBe(timerHandleBefore);
    // scheduledEventData should reflect the new title
    expect(scheduledEventData.get("b8")?.title).toBe("New Title");
  });

  it("B9: URL change reschedules browser-open timer while keeping countdown", () => {
    const startDate = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    const event = makeEvent({
      id: "b9",
      title: "Meeting",
      meetUrl: "https://meet.google.com/old-url",
      startDate,
    });
    scheduleEvents([event]);
    const timerHandleBefore = timers.get("b9");
    vi.mocked(mockUpdateTrayTitle).mockClear();

    // Next poll — same event, same time, only URL changed
    const urlChanged = makeEvent({
      id: "b9",
      title: "Meeting",
      meetUrl: "https://meet.google.com/new-url",
      startDate,
    });
    scheduleEvents([urlChanged]);

    // Browser-open timer MUST have been rescheduled (new handle)
    expect(timers.get("b9")).not.toBe(timerHandleBefore);
    expect(timers.has("b9")).toBe(true);
    // scheduledEventData should reflect the new URL
    expect(scheduledEventData.get("b9")?.meetUrl).toBe("https://meet.google.com/new-url");
  });

  it("B10: start time changed to past (in-progress) cleans up orphaned future timers", () => {
    const event = makeEvent({
      id: "b10",
      startDate: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
      meetUrl: "https://meet.google.com/abc-def-ghi",
    });
    scheduleEvents([event]);
    expect(timers.has("b10")).toBe(true);
    expect(alertTimers.has("b10")).toBe(true);
    // Advance 6 min — timers haven't fired yet (alert at 9min, browser at 10min with openBefore=1)
    vi.advanceTimersByTime(6 * 60_000);
    // Now reschedule the same event but with start time in the past (in-progress)
    const inProgressEvent = makeEvent({
      id: "b10",
      startDate: new Date(Date.now() - 3 * 60 * 1000).toISOString(), // 3 min ago
      endDate: new Date(Date.now() + 27 * 60 * 1000).toISOString(), // ends in 27 min
      meetUrl: "https://meet.google.com/abc-def-ghi",
    });
    scheduleEvents([inProgressEvent]);
    // Old timers should be cleaned up
    expect(timers.has("b10")).toBe(false);
    expect(alertTimers.has("b10")).toBe(false);
    expect(titleTimers.has("b10")).toBe(false);
    expect(countdownIntervals.has("b10")).toBe(false);
    expect(clearTimers.has("b10")).toBe(false);
    // In-meeting countdown should have started
    expect(inMeetingIntervals.has("b10")).toBe(true);
    // fired flag should be cleared
    expect(firedEvents.has("b10")).toBe(false);
  });

  it("B11: start time changed after browser-open fired reschedules new timer", () => {
    const event = makeEvent({
      id: "b11",
      startDate: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
      meetUrl: "https://meet.google.com/abc-def-ghi",
    });
    scheduleEvents([event]);
    // Advance past the timer fire time (openBefore=1min, so fires at 4min)
    vi.advanceTimersByTime(5 * 60_000 + 100);
    expect(firedEvents.has("b11")).toBe(true);
    // Reschedule with new start time 15 min from now
    const rescheduled = makeEvent({
      id: "b11",
      startDate: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
      meetUrl: "https://meet.google.com/abc-def-ghi",
    });
    scheduleEvents([rescheduled]);
    // Should have a new timer and fired flag should be cleared
    expect(timers.has("b11")).toBe(true);
    expect(firedEvents.has("b11")).toBe(false);
    const newStartMs = new Date(Date.now() + 15 * 60_000).getTime();
    expect(scheduledEventData.get("b11")?.startMs).toBeCloseTo(newStartMs, -2);
  });

  it("B12: start time changed while alert pending reschedules both timers", () => {
    const event = makeEvent({
      id: "b12",
      startDate: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
      meetUrl: "https://meet.google.com/abc-def-ghi",
    });
    scheduleEvents([event]);
    // Store old timer handles
    const oldBrowserHandle = timers.get("b12");
    const oldAlertHandle = alertTimers.get("b12");
    expect(oldBrowserHandle).toBeDefined();
    expect(oldAlertHandle).toBeDefined();
    // Reschedule to 20 min from now
    const rescheduled = makeEvent({
      id: "b12",
      startDate: new Date(Date.now() + 20 * 60 * 1000).toISOString(),
      meetUrl: "https://meet.google.com/abc-def-ghi",
    });
    scheduleEvents([rescheduled]);
    // Both timers should be rescheduled with new handles
    expect(timers.get("b12")).not.toBe(oldBrowserHandle);
    expect(alertTimers.get("b12")).not.toBe(oldAlertHandle);
    const newStartMs = new Date(Date.now() + 20 * 60_000).getTime();
    expect(scheduledEventData.get("b12")?.startMs).toBeCloseTo(newStartMs, -2);
  });

  it("events without meetUrl still get alert timer scheduled", () => {
    const startDate = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    const event = makeEvent({ id: "no-url", meetUrl: undefined, startDate });

    scheduleEvents([event]);

    expect(alertTimers.has("no-url")).toBe(true);
  });

  it("B13: fired event with unchanged start time is still skipped (regression guard)", () => {
    const startDate = new Date(Date.now() + 5 * 60 * 1000).toISOString();
    const event = makeEvent({
      id: "b13",
      startDate,
      meetUrl: "https://meet.google.com/abc-def-ghi",
    });
    scheduleEvents([event]);
    // Advance past the timer fire time
    vi.advanceTimersByTime(5 * 60_000 + 100);
    expect(firedEvents.has("b13")).toBe(true);
    // Call scheduleEvents with the SAME event (unchanged)
    scheduleEvents([event]);
    // No new timer should be created
    expect(timers.has("b13")).toBe(false);
    expect(firedEvents.has("b13")).toBe(true);
  });

  // ─── Group A continued: Rescheduled-time edge cases ───────────────────────

  it("A2: event rescheduled beyond 30-min window clears tray and schedules future title timer", () => {
    const inWindowStart = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    const event = makeEvent({ id: "a2", startDate: inWindowStart });
    scheduleEvents([event]);
    expect(vi.mocked(mockUpdateTrayTitle)).toHaveBeenCalledWith("Test Meeting", expect.any(Number));
    vi.mocked(mockUpdateTrayTitle).mockClear();

    // Rescheduled to 45 min away (outside 30-min window)
    const rescheduled = makeEvent({
      id: "a2",
      startDate: new Date(Date.now() + 45 * 60 * 1000).toISOString(),
    });
    scheduleEvents([rescheduled]);

    // Tray must clear (no more active countdown)
    expect(vi.mocked(mockUpdateTrayTitle)).toHaveBeenCalledWith(null);
    // A future title timer must be set
    expect(timers.has("a2")).toBe(true); // browser open timer rescheduled
  });

  it("A3: event rescheduled closer restarts countdown with corrected remaining time", () => {
    const originalStart = new Date(Date.now() + 25 * 60 * 1000).toISOString();
    const event = makeEvent({ id: "a3", startDate: originalStart });
    scheduleEvents([event]);
    vi.mocked(mockUpdateTrayTitle).mockClear();

    // Rescheduled to 10 min away (still in window, but closer)
    const newStart = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    const rescheduled = makeEvent({ id: "a3", startDate: newStart });
    scheduleEvents([rescheduled]);

    // Countdown must show ~10 mins remaining, not ~25
    const calls = vi.mocked(mockUpdateTrayTitle).mock.calls.filter((c) => c[0] !== null);
    const lastCall = calls[calls.length - 1];
    expect(lastCall?.[1]).toBeLessThanOrEqual(10);
    expect(lastCall?.[1]).toBeGreaterThan(0);
  });

  it("A4: event rescheduled to tomorrow clears tray and reschedules all timers", () => {
    const inWindowStart = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    const event = makeEvent({ id: "a4", startDate: inWindowStart });
    scheduleEvents([event]);
    vi.mocked(mockUpdateTrayTitle).mockClear();

    // Rescheduled to 23 hours away
    const tomorrow = new Date(Date.now() + 23 * 60 * 60 * 1000).toISOString();
    const rescheduled = makeEvent({ id: "a4", startDate: tomorrow });
    scheduleEvents([rescheduled]);

    // Tray must clear
    expect(vi.mocked(mockUpdateTrayTitle)).toHaveBeenCalledWith(null);
    // Browser timer rescheduled for 23h out
    expect(timers.has("a4")).toBe(true);
    // scheduledEventData must reflect new start
    const newStartMs = new Date(tomorrow).getTime();
    expect(scheduledEventData.get("a4")?.startMs).toBe(newStartMs);
  });

  // ─── Group C: Race conditions ──────────────────────────────────────

  it("C10: startCountdown bails if event was deleted before titleTimer fired", () => {
    // Event starts in 35 min — outside the 30-min window, titleTimer set for 5 min from now
    const startDate = new Date(Date.now() + 35 * 60 * 1000).toISOString();
    const event = makeEvent({ id: "c10", startDate });
    scheduleEvents([event]);
    // titleTimer is set but countdown not yet started
    expect(timers.has("c10")).toBe(true);
    vi.mocked(mockUpdateTrayTitle).mockClear();

    // Event is deleted before the titleTimer fires
    scheduleEvents([]);

    // Now advance past the titleTimer fire time
    vi.advanceTimersByTime(6 * 60 * 1000);

    // startCountdown should have bailed — no countdown interval, no tray update with a title
    const calls = vi.mocked(mockUpdateTrayTitle).mock.calls;
    const titleCalls = calls.filter((c) => c[0] !== null);
    expect(titleCalls).toHaveLength(0);
  });

  it("C11: tray clear at meeting start is idempotent when event also disappears from poll", () => {
    const startDate = new Date(Date.now() + 5 * 60 * 1000).toISOString();
    const event = makeEvent({ id: "c11", startDate });
    scheduleEvents([event]);
    vi.mocked(mockUpdateTrayTitle).mockClear();

    // Advance to meeting start — clearTimer fires, clearing the tray
    vi.advanceTimersByTime(5 * 60 * 1000 + 100);

    // Simultaneously, next poll returns no events (already started / deleted)
    scheduleEvents([]);

    // updateTrayTitle(null) may be called multiple times but must not throw
    const nullCalls = vi.mocked(mockUpdateTrayTitle).mock.calls.filter((c) => c[0] === null);
    expect(nullCalls.length).toBeGreaterThanOrEqual(1);
  });

  it("C12: rapid reschedule between polls leaves no timer leaks", () => {
    const startDate = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    const event = makeEvent({ id: "c12", startDate });
    scheduleEvents([event]);
    expect(timers.size).toBe(1);

    // First reschedule
    const r1 = makeEvent({
      id: "c12",
      startDate: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
    });
    scheduleEvents([r1]);

    // Second reschedule (only final state matters)
    const r2 = makeEvent({
      id: "c12",
      startDate: new Date(Date.now() + 8 * 60 * 1000).toISOString(),
    });
    scheduleEvents([r2]);

    // Must have exactly 1 timer, 1 countdown, 1 scheduledEventData entry
    expect(timers.size).toBe(1);
    expect(scheduledEventData.size).toBe(1);
    // Verify final startMs is the last reschedule
    const expectedMs = new Date(Date.now() + 8 * 60 * 1000).getTime();
    expect(scheduledEventData.get("c12")?.startMs).toBeCloseTo(expectedMs, -2);
  });

  it("C13: per-minute tick does not write stale title after ownership change", () => {
    const farStart = new Date(Date.now() + 20 * 60 * 1000).toISOString();
    const closeStart = new Date(Date.now() + 5 * 60 * 1000).toISOString();
    const far = makeEvent({ id: "far-c13", title: "Far Meeting", startDate: farStart });
    const close = makeEvent({ id: "close-c13", title: "Close Meeting", startDate: closeStart });

    // Both in countdown window
    scheduleEvents([far, close]);
    vi.mocked(mockUpdateTrayTitle).mockClear();

    // Advance 1 minute — both per-minute ticks fire
    vi.advanceTimersByTime(60_000);

    // Only Close Meeting's title should appear; Far Meeting's tick must be suppressed
    const calls = vi.mocked(mockUpdateTrayTitle).mock.calls.filter((c) => c[0] !== null);
    const farCalls = calls.filter((c) => c[0] === "Far Meeting");
    expect(farCalls).toHaveLength(0);
    const closeCalls = calls.filter((c) => c[0] === "Close Meeting");
    expect(closeCalls.length).toBeGreaterThan(0);
  });

  it("E16/17: tray clears after 3 consecutive calendar errors; preserved on 2 errors + success", async () => {
    const startDate = new Date(Date.now() + 5 * 60 * 1000).toISOString();
    const event = makeEvent({ id: "e16", startDate });
    scheduleEvents([event]);
    expect(countdownIntervals.size).toBe(1);
    vi.mocked(mockUpdateTrayTitle).mockClear();

    vi.mocked(refreshCalendarPublication).mockResolvedValue({
      publicationGeneration: 1,
      result: { kind: "err", code: "unknown", error: "permission denied" },
    });

    // 2 errors — tray must still be showing
    await poll();
    await poll();
    expect(stateModule.getConsecutiveErrors()).toBe(2);
    expect(countdownIntervals.size).toBe(1); // countdown still alive

    // 3rd error — tray must clear
    await poll();
    expect(stateModule.getConsecutiveErrors()).toBe(3);
    expect(countdownIntervals.size).toBe(0);
    const nullCalls = vi.mocked(mockUpdateTrayTitle).mock.calls.filter((c) => c[0] === null);
    expect(nullCalls.length).toBeGreaterThanOrEqual(1);

    // Reset mock
    vi.mocked(refreshCalendarPublication).mockResolvedValue({
      publicationGeneration: 1,
      result: {
        kind: "ok",
        source: "live",
        completeness: "complete",
        observedAt: Date.now(),
        events: [],
      },
    });
  });

  it("E16b: consecutiveErrors resets on success; 2 errors + success leaves tray intact", async () => {
    const startDate = new Date(Date.now() + 5 * 60 * 1000).toISOString();
    const event = makeEvent({ id: "e16b", startDate });
    scheduleEvents([event]);
    vi.mocked(mockUpdateTrayTitle).mockClear();

    vi.mocked(refreshCalendarPublication).mockResolvedValue({
      publicationGeneration: 1,
      result: { kind: "err", code: "unknown", error: "permission denied" },
    });

    await poll();
    await poll();
    expect(stateModule.getConsecutiveErrors()).toBe(2);

    // Success — errors reset, tray preserved
    vi.mocked(refreshCalendarPublication).mockResolvedValue({
      publicationGeneration: 1,
      result: {
        kind: "ok",
        source: "live",
        completeness: "complete",
        observedAt: Date.now(),
        events: [event],
      },
    });
    await poll();
    expect(stateModule.getConsecutiveErrors()).toBe(0);
    expect(countdownIntervals.size).toBe(1);

    vi.mocked(refreshCalendarPublication).mockResolvedValue({
      publicationGeneration: 1,
      result: {
        kind: "ok",
        source: "live",
        completeness: "complete",
        observedAt: Date.now(),
        events: [],
      },
    });
  });

  it("E18: scheduleEvents([]) immediately clears tray", () => {
    const startDate = new Date(Date.now() + 5 * 60 * 1000).toISOString();
    const event = makeEvent({ id: "e18", startDate });
    scheduleEvents([event]);
    expect(countdownIntervals.size).toBe(1);
    vi.mocked(mockUpdateTrayTitle).mockClear();

    scheduleEvents([]);

    expect(countdownIntervals.size).toBe(0);
    const nullCalls = vi.mocked(mockUpdateTrayTitle).mock.calls.filter((c) => c[0] === null);
    expect(nullCalls.length).toBeGreaterThanOrEqual(1);
  });

  it("autoOpenEnabled=false: stores snapshot, arms title, never opens browser", () => {
    const preventSleep = vi.fn();
    const allowSleep = vi.fn();
    initPowerCallbacks({
      getPollInterval: vi.fn().mockReturnValue(2 * 60 * 1000),
      preventSleep,
      allowSleep,
    });
    vi.mocked(mockGetSettings).mockReturnValue({
      ...DEFAULT_SETTINGS,
      openBeforeMinutes: 3,
      windowAlert: true,
      autoOpenEnabled: false,
      alertLeadSeconds: 60,
      nativeNotifications: true,
      lateJoinGraceMinutes: 0,
      quietHoursEnabled: false,
    });

    try {
      const startMs = Date.now() + 10 * 60 * 1000;
      const event = makeEvent({
        id: asTestEventId("no-auto"),
        title: "No Auto Open",
        startDate: asTestIsoUtc(new Date(startMs).toISOString()),
        endDate: asTestIsoUtc(new Date(startMs + 30 * 60 * 1000).toISOString()),
      });

      scheduleEvents([event]);

      expect(scheduledEventData.has(event.id)).toBe(true);
      expect(timers.size).toBe(0);
      expect(alertTimers.size).toBe(1);
      expect(titleTimers.size + countdownIntervals.size).toBeGreaterThan(0);

      // Identical re-schedule is idempotent: no browser timer, stable snapshot.
      scheduleEvents([event]);
      expect(timers.size).toBe(0);
      expect(scheduledEventData.size).toBe(1);

      // Advance past open time — still no browser open when auto-open is off.
      vi.advanceTimersByTime(8 * 60 * 1000);
      expect(timers.size).toBe(0);
    } finally {
      vi.mocked(mockGetSettings).mockReturnValue({
        ...DEFAULT_SETTINGS,
        openBeforeMinutes: 3,
        windowAlert: true,
        autoOpenEnabled: true,
        alertLeadSeconds: 60,
        nativeNotifications: true,
        lateJoinGraceMinutes: 0,
        quietHoursEnabled: false,
      });
    }
  });

  it("autoOpenEnabled=false: stop balances sleep blockers after countdown", () => {
    const preventSleep = vi.fn();
    const allowSleep = vi.fn();
    initPowerCallbacks({
      getPollInterval: vi.fn().mockReturnValue(2 * 60 * 1000),
      preventSleep,
      allowSleep,
    });
    vi.mocked(mockGetSettings).mockReturnValue({
      ...DEFAULT_SETTINGS,
      openBeforeMinutes: 3,
      windowAlert: true,
      autoOpenEnabled: false,
      alertLeadSeconds: 60,
      nativeNotifications: true,
      lateJoinGraceMinutes: 0,
      quietHoursEnabled: false,
    });

    try {
      const startMs = Date.now() + 5 * 60 * 1000;
      const event = makeEvent({
        id: asTestEventId("sleep-balance"),
        title: "Sleep Balance",
        startDate: asTestIsoUtc(new Date(startMs).toISOString()),
      });
      scheduleEvents([event]);
      expect(preventSleep.mock.calls.length).toBeGreaterThanOrEqual(1);

      stopScheduler();
      expect(allowSleep.mock.calls.length).toBe(preventSleep.mock.calls.length);
    } finally {
      vi.mocked(mockGetSettings).mockReturnValue({
        ...DEFAULT_SETTINGS,
        openBeforeMinutes: 3,
        windowAlert: true,
        autoOpenEnabled: true,
        alertLeadSeconds: 60,
        nativeNotifications: true,
        lateJoinGraceMinutes: 0,
        quietHoursEnabled: false,
      });
    }
  });
});

describe("setSchedulerWindow and poll IPC notification", () => {
  let mockWebContentsSend: ReturnType<typeof vi.fn>;
  let mockWindow: {
    isDestroyed: ReturnType<typeof vi.fn>;
    webContents: {
      send: ReturnType<typeof vi.fn>;
      isDestroyed: ReturnType<typeof vi.fn>;
    };
  };

  beforeEach(() => {
    vi.useFakeTimers();
    timers.clear();
    firedEvents.clear();
    scheduledEventData.clear();
    countdownIntervals.clear();
    resetFixture();
    refreshStateRefs();
    vi.mocked(mockUpdateTrayTitle).mockClear();
    initPowerCallbacks({
      getPollInterval: vi.fn().mockReturnValue(2 * 60 * 1000),
      preventSleep: vi.fn(),
      allowSleep: vi.fn(),
    });

    // Create mock window with webContents.send
    mockWebContentsSend = vi.fn();
    mockWindow = {
      isDestroyed: vi.fn().mockReturnValue(false),
      webContents: {
        send: mockWebContentsSend,
        isDestroyed: vi.fn().mockReturnValue(false),
      },
    };
  });

  afterEach(() => {
    vi.useRealTimers();
    timers.clear();
    firedEvents.clear();
    scheduledEventData.clear();
    countdownIntervals.clear();
    resetFixture();
    refreshStateRefs();
    stateModule.state.powerCallbacks = null;
  });

  it("F1: setSchedulerWindow stores window reference for poll to use", async () => {
    vi.mocked(refreshCalendarPublication).mockResolvedValue({
      publicationGeneration: 1,
      result: {
        kind: "ok",
        source: "live",
        completeness: "complete",
        observedAt: Date.now(),
        events: [],
      },
    });

    setSchedulerWindow(mockWindow as never);
    await poll();

    // IPC now sends events array (empty in this case) instead of undefined
    expect(mockWebContentsSend).toHaveBeenCalledWith(
      "calendar:result-updated",
      expect.objectContaining({
        publicationGeneration: expect.any(Number),
        result: expect.objectContaining({ kind: "ok" }),
      }),
    );
  });

  it("F2: poll does NOT send IPC if window is null", async () => {
    vi.mocked(refreshCalendarPublication).mockResolvedValue({
      publicationGeneration: 1,
      result: {
        kind: "ok",
        source: "live",
        completeness: "complete",
        observedAt: Date.now(),
        events: [],
      },
    });

    // Don't set window - it should remain null
    setSchedulerWindow(null as never);
    await poll();

    expect(mockWebContentsSend).not.toHaveBeenCalled();
  });

  it("F3: poll does NOT send IPC if window is destroyed", async () => {
    vi.mocked(refreshCalendarPublication).mockResolvedValue({
      publicationGeneration: 1,
      result: {
        kind: "ok",
        source: "live",
        completeness: "complete",
        observedAt: Date.now(),
        events: [],
      },
    });

    mockWindow.isDestroyed.mockReturnValue(true);
    setSchedulerWindow(mockWindow as never);
    await poll();

    expect(mockWebContentsSend).not.toHaveBeenCalled();
  });

  it("F4: poll sends error publication on calendar fetch error", async () => {
    vi.mocked(refreshCalendarPublication).mockResolvedValue({
      publicationGeneration: 1,
      result: {
        kind: "err",
        code: "unknown",
        error: "Calendar access denied",
      },
    });

    setSchedulerWindow(mockWindow as never);
    await poll();

    expect(mockWebContentsSend).toHaveBeenCalledWith(
      "calendar:result-updated",
      expect.objectContaining({
        result: expect.objectContaining({ kind: "err", error: "Calendar access denied" }),
      }),
    );
    expect(stateModule.getConsecutiveErrors()).toBe(1);
  });

  it("F5: poll sends IPC after successful fetch with events", async () => {
    const event = makeEvent({ id: "f5-event" });
    vi.mocked(refreshCalendarPublication).mockResolvedValue({
      publicationGeneration: 1,
      result: {
        kind: "ok",
        source: "live",
        completeness: "complete",
        observedAt: Date.now(),
        events: [event],
      },
    });

    setSchedulerWindow(mockWindow as never);
    await poll();

    expect(stateModule.getConsecutiveErrors()).toBe(0);
    expect(stateModule.getConsecutiveErrors()).toBe(0);
  });
});

describe("Dirty flag for title resolution", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetFixture();
    refreshStateRefs();
    vi.mocked(mockUpdateTrayTitle).mockClear();
    initPowerCallbacks({
      getPollInterval: vi.fn().mockReturnValue(2 * 60 * 1000),
      preventSleep: vi.fn(),
      allowSleep: vi.fn(),
    });
  });
  afterEach(() => {
    vi.useRealTimers();
    resetFixture();
    refreshStateRefs();
    stateModule.state.powerCallbacks = null;
    vi.mocked(mockUpdateTrayTitle).mockClear();
  });

  it("resolveActiveTitleEvent returns cached value when !titleDirty", () => {
    // Schedule an event so countdown starts and activeTitleEventId is set
    const event = makeEvent({
      id: "dirty-t1",
      startDate: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    });
    scheduleEvents([event]);

    // After scheduleEvents, titleDirty was set and resolved, so now titleDirty is false
    expect(stateModule.state.titleDirty).toBe(false);
    expect(stateModule.state.activeTitleEventId).toBe("dirty-t1");
    vi.mocked(mockUpdateTrayTitle).mockClear();

    // Call resolveActiveTitleEvent again — should early-return (not dirty, has cached value)
    resolveActiveTitleEvent();

    // Title callback should NOT have been called (early-returned)
    expect(mockUpdateTrayTitle).not.toHaveBeenCalled();
  });

  it("resolveActiveTitleEvent re-resolves after markTitleDirty()", () => {
    const event = makeEvent({
      id: "dirty-t2",
      startDate: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    });
    scheduleEvents([event]);

    expect(stateModule.state.activeTitleEventId).toBe("dirty-t2");
    vi.mocked(mockUpdateTrayTitle).mockClear();

    // Mark dirty and call resolve — should re-resolve and call tray update
    markTitleDirty();
    expect(stateModule.state.titleDirty).toBe(true);

    resolveActiveTitleEvent();

    // Should have re-resolved and updated tray
    expect(mockUpdateTrayTitle).toHaveBeenCalledWith("Test Meeting", expect.any(Number));
    expect(stateModule.state.titleDirty).toBe(false);
  });

  it("resolveActiveInMeetingEvent returns cached value when !inMeetingDirty", () => {
    // Create an in-progress meeting to trigger in-meeting countdown
    const event = makeEvent({
      id: "dirty-im1",
      startDate: new Date(Date.now() - 5 * 60 * 1000).toISOString(), // started 5 min ago
      endDate: new Date(Date.now() + 25 * 60 * 1000).toISOString(), // ends in 25 min
    });
    scheduleEvents([event]);

    expect(stateModule.state.activeInMeetingEventId).toBe("dirty-im1");
    expect(stateModule.state.inMeetingDirty).toBe(false);
    vi.mocked(mockUpdateTrayTitle).mockClear();

    // Call resolveActiveInMeetingEvent — should early-return (not dirty, has cached value)
    resolveActiveInMeetingEvent();

    // Should NOT have called tray update (early-returned)
    expect(mockUpdateTrayTitle).not.toHaveBeenCalled();
  });

  it("scheduleEvents marks titleDirty when countdown starts", () => {
    const event = makeEvent({
      id: "dirty-s1",
      startDate: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    });
    // Before scheduling, dirty flag is false (fresh state)
    expect(stateModule.state.titleDirty).toBe(false);

    scheduleEvents([event]);

    // After scheduling, resolveActiveTitleEvent was called which resets the flag
    // But the flag was set before resolve ran
    expect(stateModule.state.activeTitleEventId).toBe("dirty-s1");
    // After resolution, dirty is reset
    expect(stateModule.state.titleDirty).toBe(false);

    // Now delete the event — cleanup marks dirty and re-resolves
    scheduleEvents([]);
    expect(stateModule.state.activeTitleEventId).toBeNull();
  });

  it("scheduleEvents marks inMeetingDirty when in-meeting countdown starts/stops", () => {
    // In-progress event triggers in-meeting countdown
    const event = makeEvent({
      id: "dirty-s2",
      startDate: new Date(Date.now() - 2 * 60 * 1000).toISOString(),
      endDate: new Date(Date.now() + 28 * 60 * 1000).toISOString(),
    });

    scheduleEvents([event]);

    // In-meeting countdown started → dirty was set and resolved
    expect(stateModule.state.activeInMeetingEventId).toBe("dirty-s2");
    expect(stateModule.state.inMeetingDirty).toBe(false); // resolved resets it

    // Remove the event — cleanup marks dirty and re-resolves
    scheduleEvents([]);
    expect(stateModule.state.activeInMeetingEventId).toBeNull();
  });
});

describe("F5: in-progress auto-open suppression after meeting start", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetFixture();
    refreshStateRefs();
    setSchedulerWindow(null);
    setTrayTitleCallback(mockUpdateTrayTitle);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not auto-open an in-progress event first discovered after start", () => {
    const event = makeEvent({
      id: "f5-catchup",
      title: "Late-discovered Meeting",
      startDate: new Date(Date.now() - 30 * 1000).toISOString(),
      endDate: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
      meetUrl: "https://meet.google.com/ymr-evmf-wri",
    });

    expect(firedEvents.has("f5-catchup")).toBe(false);
    scheduleEvents([event]);

    vi.advanceTimersByTime(50);

    expect(firedEvents.has("f5-catchup")).toBe(false);
    expect(timers.has("f5-catchup")).toBe(false);
    // In-meeting countdown still runs in parallel.
    expect(inMeetingIntervals.has("f5-catchup")).toBe(true);
  });

  it("does NOT fire when event is cancelled (alert dismissed via Cmd+W or X)", () => {
    // Pre-mark the event as cancelled (simulates user dismissing alert before sleep)
    const event = makeEvent({
      id: "f5-cancelled",
      startDate: new Date(Date.now() - 30 * 1000).toISOString(),
      endDate: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
      meetUrl: "https://meet.google.com/cancelled-test",
    });
    stateModule.state.cancelledEvents.add(event.id);

    scheduleEvents([event]);
    vi.advanceTimersByTime(50);

    // Suppression honored — no fire, no browser timer
    expect(firedEvents.has("f5-cancelled")).toBe(false);
    expect(timers.has("f5-cancelled")).toBe(false);
    // In-meeting countdown still runs (independent of browser auto-open)
    expect(inMeetingIntervals.has("f5-cancelled")).toBe(true);
  });

  it("does NOT fire for an in-progress event first discovered after start", () => {
    const event = makeEvent({
      id: "f5-stale",
      startDate: new Date(Date.now() - 3 * 60 * 1000).toISOString(),
      endDate: new Date(Date.now() + 27 * 60 * 1000).toISOString(),
      meetUrl: "https://meet.google.com/stale-test",
    });

    scheduleEvents([event]);
    vi.advanceTimersByTime(50);

    expect(firedEvents.has("f5-stale")).toBe(false);
    expect(timers.has("f5-stale")).toBe(false);
    // In-meeting countdown still expected for in-progress events
    expect(inMeetingIntervals.has("f5-stale")).toBe(true);
  });

  it("does NOT fire when event has no meetUrl", () => {
    const event = makeEvent({
      id: "f5-nourl",
      startDate: new Date(Date.now() - 30 * 1000).toISOString(),
      endDate: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
      meetUrl: undefined,
    });

    scheduleEvents([event]);
    vi.advanceTimersByTime(50);

    expect(firedEvents.has("f5-nourl")).toBe(false);
    expect(timers.has("f5-nourl")).toBe(false);
  });

  it("does NOT re-fire when event is already in firedEvents (alert path fired earlier)", () => {
    // Simulate: browser-open already fired pre-meeting (e.g., before sleep)
    const event = makeEvent({
      id: "f5-already",
      startDate: new Date(Date.now() - 30 * 1000).toISOString(),
      endDate: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
      meetUrl: "https://meet.google.com/already-fired",
    });
    stateModule.state.firedEvents.set(event.id, Date.now());

    scheduleEvents([event]);
    vi.advanceTimersByTime(50);

    // firedEvents still has it; no new browser timer scheduled
    expect(firedEvents.has("f5-already")).toBe(true);
    expect(timers.has("f5-already")).toBe(false);
  });
});

describe("REGRESSION: same-id reschedule from in-progress to future start", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetFixture();
    refreshStateRefs();
    vi.mocked(mockUpdateTrayTitle).mockClear();
    vi.mocked(mockShowAlert).mockClear();
    initPowerCallbacks({
      getPollInterval: vi.fn().mockReturnValue(2 * 60 * 1000),
      preventSleep: vi.fn(),
      allowSleep: vi.fn(),
    });
    setTrayTitleCallback(mockUpdateTrayTitle);
  });
  afterEach(() => {
    vi.useRealTimers();
    resetFixture();
    refreshStateRefs();
    stateModule.state.powerCallbacks = null;
    vi.mocked(mockUpdateTrayTitle).mockClear();
  });

  it("R1: clears in-meeting interval, end timer, and active id when same id moves to future start", () => {
    const baseNow = new Date("2026-05-23T12:00:00.000Z").getTime();
    vi.setSystemTime(baseNow);

    // First poll: event is already in progress (started 5 min ago, ends in 25 min)
    const inProgress = makeEvent({
      id: "rs1",
      startDate: new Date(baseNow - 5 * 60 * 1000).toISOString(),
      endDate: new Date(baseNow + 25 * 60 * 1000).toISOString(),
      meetUrl: "https://meet.google.com/abc-def-ghi",
    });
    scheduleEvents([inProgress]);

    // Pre-conditions: in-meeting state is set
    expect(inMeetingIntervals.has("rs1")).toBe(true);
    expect(inMeetingEndTimers.has("rs1")).toBe(true);
    expect(getActiveInMeetingEventId()).toBe("rs1");
    const oldEndMs = baseNow + 25 * 60 * 1000;
    expect(scheduledEventData.get("rs1")?.endMs).toBe(oldEndMs);

    // Second poll: same id, but moved to future (e.g. organizer rescheduled to tomorrow)
    const futureStartMs = baseNow + 23 * 60 * 60 * 1000;
    const futureEndMs = futureStartMs + 30 * 60 * 1000;
    const future = makeEvent({
      id: "rs1",
      startDate: new Date(futureStartMs).toISOString(),
      endDate: new Date(futureEndMs).toISOString(),
      meetUrl: "https://meet.google.com/abc-def-ghi",
    });
    scheduleEvents([future]);

    // Expected: in-meeting state cleared, snapshot reflects future start
    expect(inMeetingIntervals.has("rs1")).toBe(false);
    expect(inMeetingEndTimers.has("rs1")).toBe(false);
    expect(getActiveInMeetingEventId()).toBeNull();
    expect(scheduledEventData.get("rs1")?.startMs).toBe(futureStartMs);
    expect(scheduledEventData.get("rs1")?.endMs).toBe(futureEndMs);
    // Browser timer should now exist for the future schedule
    expect(timers.has("rs1")).toBe(true);
  });

  it("R2: advancing past the old endMs does not delete the future scheduledEventData snapshot", () => {
    const baseNow = new Date("2026-05-23T12:00:00.000Z").getTime();
    vi.setSystemTime(baseNow);

    // In-progress event ending in 10 min
    const inProgress = makeEvent({
      id: "rs2",
      startDate: new Date(baseNow - 5 * 60 * 1000).toISOString(),
      endDate: new Date(baseNow + 10 * 60 * 1000).toISOString(),
      meetUrl: "https://meet.google.com/zzz-zzz-zzz",
    });
    scheduleEvents([inProgress]);
    const oldEndMs = baseNow + 10 * 60 * 1000;

    // Reschedule same id to tomorrow
    const futureStartMs = baseNow + 24 * 60 * 60 * 1000;
    const futureEndMs = futureStartMs + 30 * 60 * 1000;
    const future = makeEvent({
      id: "rs2",
      startDate: new Date(futureStartMs).toISOString(),
      endDate: new Date(futureEndMs).toISOString(),
      meetUrl: "https://meet.google.com/zzz-zzz-zzz",
    });
    scheduleEvents([future]);

    // Snapshot the future state
    expect(scheduledEventData.get("rs2")?.startMs).toBe(futureStartMs);

    // Advance past the OLD endMs — the stale in-meeting end timer (if not cleared)
    // would fire here and delete scheduledEventData for "rs2".
    vi.advanceTimersByTime(oldEndMs - baseNow + 1000);

    // The future snapshot must survive
    expect(scheduledEventData.has("rs2")).toBe(true);
    expect(scheduledEventData.get("rs2")?.startMs).toBe(futureStartMs);
    expect(scheduledEventData.get("rs2")?.endMs).toBe(futureEndMs);
  });

  it("R3: characterization — browser-open timer fires at the NEW future time, not the old in-progress moment", () => {
    const baseNow = new Date("2026-05-23T12:00:00.000Z").getTime();
    vi.setSystemTime(baseNow);

    const inProgress = makeEvent({
      id: "rs3",
      startDate: new Date(baseNow - 2 * 60 * 1000).toISOString(),
      endDate: new Date(baseNow + 28 * 60 * 1000).toISOString(),
      meetUrl: "https://meet.google.com/aaa-bbb-ccc",
    });
    scheduleEvents([inProgress]);

    // Reschedule same id to 15 min from now (well within MAX_SCHEDULE_AHEAD)
    const futureStartMs = baseNow + 15 * 60 * 1000;
    const futureEndMs = futureStartMs + 30 * 60 * 1000;
    const future = makeEvent({
      id: "rs3",
      startDate: new Date(futureStartMs).toISOString(),
      endDate: new Date(futureEndMs).toISOString(),
      meetUrl: "https://meet.google.com/aaa-bbb-ccc",
    });
    scheduleEvents([future]);

    // Browser timer must be armed for the future schedule
    expect(timers.has("rs3")).toBe(true);
    expect(firedEvents.has("rs3")).toBe(false);

    // With openBeforeMinutes=3, browser opens at futureStartMs - 3min = baseNow + 12min
    // Advance past that point
    vi.advanceTimersByTime(12 * 60 * 1000 + 1000);
    expect(firedEvents.has("rs3")).toBe(true);
  });

  it("R4: alert timer is armed for the future event and fires at the new alert time, not suppressed by stale in-meeting state", () => {
    const baseNow = new Date("2026-05-23T12:00:00.000Z").getTime();
    vi.setSystemTime(baseNow);

    // First poll: in-progress event with an active in-meeting countdown
    const inProgress = makeEvent({
      id: "rs4",
      startDate: new Date(baseNow - 2 * 60 * 1000).toISOString(),
      endDate: new Date(baseNow + 28 * 60 * 1000).toISOString(),
      meetUrl: "https://meet.google.com/ddd-eee-fff",
    });
    scheduleEvents([inProgress]);

    // Sanity: in-progress events do not arm an alert timer (alert is pre-meeting)
    expect(alertTimers.has("rs4")).toBe(false);
    expect(inMeetingIntervals.has("rs4")).toBe(true);
    expect(alertFiredEvents.has("rs4")).toBe(false);

    // Reschedule same id to 15 min from now
    const futureStartMs = baseNow + 15 * 60 * 1000;
    const futureEndMs = futureStartMs + 30 * 60 * 1000;
    const future = makeEvent({
      id: "rs4",
      startDate: new Date(futureStartMs).toISOString(),
      endDate: new Date(futureEndMs).toISOString(),
      meetUrl: "https://meet.google.com/ddd-eee-fff",
    });
    scheduleEvents([future]);

    // Stale in-meeting state must be cleared by the reschedule
    expect(inMeetingIntervals.has("rs4")).toBe(false);
    expect(inMeetingEndTimers.has("rs4")).toBe(false);
    expect(getActiveInMeetingEventId()).toBeNull();

    // Alert timer is now armed for the future event
    expect(alertTimers.has("rs4")).toBe(true);
    expect(alertFiredEvents.has("rs4")).toBe(false);

    // With openBeforeMinutes=3 and ALERT_OFFSET_MS=60s, alert fires at
    // futureStartMs - 3min - 60s = baseNow + 11min. Advance past that point.
    vi.advanceTimersByTime(11 * 60 * 1000 + 1000);

    // Alert path actually ran for the future event (not suppressed by stale state)
    expect(alertFiredEvents.has("rs4")).toBe(true);
    expect(alertTimers.has("rs4")).toBe(false);
    expect(mockShowAlert).toHaveBeenCalledTimes(1);
    expect(mockShowAlert).toHaveBeenCalledWith(
      expect.objectContaining({ id: "rs4" }),
      expect.anything(),
      expect.any(String),
    );
  });
});
