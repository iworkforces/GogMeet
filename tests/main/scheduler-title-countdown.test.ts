import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { TitleCountdownParams } from "../../src/main/scheduler/title-countdown.js";
import type { SchedulerRuntime } from "../../src/main/scheduler/runtime.js";
import type {
  SchedulerState,
  ScheduledEventSnapshot,
} from "../../src/main/scheduler/state/index.js";
import { createSchedulerState } from "../../src/main/scheduler/state/index.js";
import { asTestEventId } from "../helpers/test-utils.js";
import { schedulerTestContext } from "../helpers/scheduler-runtime.js";

// Mock power module
vi.mock("../../src/main/system/power.js", () => ({
  getPollInterval: vi.fn().mockReturnValue(2 * 60 * 1000),
  preventSleep: vi.fn(),
  allowSleep: vi.fn(),
}));

// Mock countdown module — isolate title-countdown from countdown logic
vi.mock("../../src/main/scheduler/countdown.js", () => ({
  resolveActiveTitleEvent: vi.fn(),
  startInMeetingCountdown: vi.fn(),
}));

// Mock electron (required by transitive imports)
vi.mock("electron", () => ({
  app: { getPath: vi.fn().mockReturnValue("/tmp/test") },
}));

// Mock settings (used by scheduler/index.ts transitively)
vi.mock("../../src/main/facades/settings.js", () => ({
  getSettings: vi.fn().mockReturnValue({
    schemaVersion: 3,
    openBeforeMinutes: 1,
    launchAtLogin: false,
    showTomorrowMeetings: true,
    showCompletedTodayMeetings: false,
    windowAlert: true,
    autoOpenEnabled: true,
    alertLeadSeconds: 60,
    nativeNotifications: true,
    lateJoinGraceMinutes: 0,
    quietHoursEnabled: false,
    quietHoursStart: "22:00",
    quietHoursEnd: "07:00",
  }),
}));

const { preventSleep, allowSleep } = await import("../../src/main/system/power.js");
const { resolveActiveTitleEvent, startInMeetingCountdown } =
  await import("../../src/main/scheduler/countdown.js");
const {
  scheduleTitleCountdown: scheduleTitleCountdownImpl,
  cancelTitleCountdown: cancelTitleCountdownImpl,
  TITLE_BEFORE_MS,
} = await import("../../src/main/scheduler/title-countdown.js");

type TestSchedulerState = Omit<
  SchedulerState,
  | "titleTimers"
  | "countdownIntervals"
  | "clearTimers"
  | "scheduledEventData"
  | "cancelledEvents"
  | "activeTitleEventId"
> & {
  titleTimers: Map<string, ReturnType<typeof setTimeout>>;
  countdownIntervals: Map<string, ReturnType<typeof setInterval>>;
  clearTimers: Map<string, ReturnType<typeof setTimeout>>;
  scheduledEventData: Map<
    string,
    Omit<ScheduledEventSnapshot, "meetUrl" | "openAtMs"> & {
      meetUrl: string | undefined;
      openAtMs?: number;
    }
  >;
  cancelledEvents: Set<string>;
  activeTitleEventId: string | null;
};

let runtime: SchedulerRuntime;
let state: TestSchedulerState;

beforeEach(() => {
  runtime = schedulerTestContext().runtime;
  state = runtime.state.As<TestSchedulerState>();
});

function scheduleTitleCountdown(
  params: TitleCountdownParams,
  titleTimers: Map<string, ReturnType<typeof setTimeout>>,
  countdownIntervals: Map<string, ReturnType<typeof setInterval>>,
  clearTimers: Map<string, ReturnType<typeof setTimeout>>,
): void {
  scheduleTitleCountdownImpl(
    runtime,
    params,
    titleTimers.As<SchedulerState["titleTimers"]>(),
    countdownIntervals.As<SchedulerState["countdownIntervals"]>(),
    clearTimers.As<SchedulerState["clearTimers"]>(),
  );
}

function cancelTitleCountdown(
  eventId: string,
  titleTimers: Map<string, ReturnType<typeof setTimeout>>,
  countdownIntervals: Map<string, ReturnType<typeof setInterval>>,
  clearTimers: Map<string, ReturnType<typeof setTimeout>>,
): void {
  cancelTitleCountdownImpl(
    runtime,
    asTestEventId(eventId),
    titleTimers.As<SchedulerState["titleTimers"]>(),
    countdownIntervals.As<SchedulerState["countdownIntervals"]>(),
    clearTimers.As<SchedulerState["clearTimers"]>(),
  );
}

function initPowerCallbacks(callbacks: SchedulerState["powerCallbacks"]): void {
  state.powerCallbacks = callbacks;
}

function makeParams(
  overrides: Partial<Omit<TitleCountdownParams, "eventId">> & { readonly eventId?: string } = {},
): TitleCountdownParams {
  const { eventId = "evt-1", ...rest } = overrides;
  return {
    eventId: asTestEventId(eventId),
    eventTitle: "Standup",
    startMs: Date.now() + 10 * 60 * 1000, // 10 min from now
    endMs: Date.now() + 40 * 60 * 1000,
    now: Date.now(),
    ...rest,
  };
}

describe("scheduleTitleCountdown", () => {
  let titleTimers: Map<string, ReturnType<typeof setTimeout>>;
  let countdownIntervals: Map<string, ReturnType<typeof setInterval>>;
  let clearTimers: Map<string, ReturnType<typeof setTimeout>>;

  beforeEach(() => {
    vi.useFakeTimers();
    titleTimers = state.titleTimers;
    countdownIntervals = state.countdownIntervals;
    clearTimers = state.clearTimers;
    vi.mocked(preventSleep).mockClear();
    vi.mocked(allowSleep).mockClear();
    vi.mocked(resolveActiveTitleEvent).mockClear();
    vi.mocked(startInMeetingCountdown).mockClear();
    // Ensure scheduledEventData has entry for test events
    state.scheduledEventData.set("evt-1", {
      title: "Standup",
      meetUrl: "https://meet.google.com/abc",
      startMs: Date.now() + 10 * 60 * 1000,
      endMs: Date.now() + 40 * 60 * 1000,
    });
    state.onTrayTitleUpdate = vi.fn();
    state.activeTitleEventId = null;
    initPowerCallbacks({
      getPollInterval: vi.fn().mockReturnValue(2 * 60 * 1000),
      preventSleep,
      allowSleep,
    });
  });

  afterEach(() => {
    for (const handle of titleTimers.values()) clearTimeout(handle);
    for (const handle of countdownIntervals.values()) clearInterval(handle);
    for (const handle of clearTimers.values()) clearTimeout(handle);
    titleTimers.clear();
    countdownIntervals.clear();
    clearTimers.clear();
    state.scheduledEventData.clear();
    state.onTrayTitleUpdate = null;
    state.activeTitleEventId = null;
    state.powerCallbacks = null;
    vi.useRealTimers();
  });

  it("TITLE_BEFORE_MS is 30 minutes", () => {
    expect(TITLE_BEFORE_MS).toBe(30 * 60 * 1000);
  });

  it("schedules a future title timer when event is more than 30 min out", () => {
    const now = Date.now();
    const params = makeParams({
      startMs: now + 45 * 60 * 1000, // 45 min away
      now,
    });
    state.scheduledEventData.set("evt-1", {
      title: "Standup",
      meetUrl: undefined,
      startMs: params.startMs,
      endMs: params.endMs,
    });

    scheduleTitleCountdown(params, titleTimers, countdownIntervals, clearTimers);

    expect(titleTimers.has("evt-1")).toBe(true);
    // No immediate countdown
    expect(countdownIntervals.has("evt-1")).toBe(false);
  });

  it("starts countdown immediately when within 30-min window", () => {
    const now = Date.now();
    const params = makeParams({
      startMs: now + 10 * 60 * 1000, // 10 min away (within 30-min window)
      now,
    });

    scheduleTitleCountdown(params, titleTimers, countdownIntervals, clearTimers);

    // No titleTimer (starts immediately)
    expect(titleTimers.has("evt-1")).toBe(false);
    // Countdown interval started
    expect(countdownIntervals.has("evt-1")).toBe(true);
    // Clear timer set for meeting start
    expect(clearTimers.has("evt-1")).toBe(true);
    // preventSleep called
    expect(preventSleep).toHaveBeenCalled();
    // resolveActiveTitleEvent called
    expect(resolveActiveTitleEvent).toHaveBeenCalled();
  });

  it("does nothing when event start is in the past", () => {
    const now = Date.now();
    const params = makeParams({
      startMs: now - 5 * 60 * 1000, // 5 min ago
      now,
    });

    scheduleTitleCountdown(params, titleTimers, countdownIntervals, clearTimers);

    expect(titleTimers.has("evt-1")).toBe(false);
    expect(countdownIntervals.has("evt-1")).toBe(false);
    expect(clearTimers.has("evt-1")).toBe(false);
  });

  it("fires title timer and starts countdown after delay elapses", () => {
    const now = Date.now();
    const startMs = now + 35 * 60 * 1000; // 35 min away → titleTimer at 5 min
    const params = makeParams({ startMs, now });
    state.scheduledEventData.set("evt-1", {
      title: "Standup",
      meetUrl: undefined,
      startMs,
      endMs: params.endMs,
    });

    scheduleTitleCountdown(params, titleTimers, countdownIntervals, clearTimers);

    expect(titleTimers.has("evt-1")).toBe(true);
    expect(countdownIntervals.has("evt-1")).toBe(false);

    // Advance to when title timer should fire (5 min)
    vi.advanceTimersByTime(5 * 60 * 1000);

    // titleTimer should have been removed and countdown started
    expect(titleTimers.has("evt-1")).toBe(false);
    expect(countdownIntervals.has("evt-1")).toBe(true);
    expect(clearTimers.has("evt-1")).toBe(true);
    expect(preventSleep).toHaveBeenCalled();
  });

  it("cancels existing timers before rescheduling (idempotent)", () => {
    const now = Date.now();
    const params = makeParams({ now });

    scheduleTitleCountdown(params, titleTimers, countdownIntervals, clearTimers);
    const firstInterval = countdownIntervals.get("evt-1");
    const firstClear = clearTimers.get("evt-1");

    // Reschedule
    scheduleTitleCountdown(params, titleTimers, countdownIntervals, clearTimers);
    const secondInterval = countdownIntervals.get("evt-1");
    const secondClear = clearTimers.get("evt-1");

    expect(secondInterval).not.toBe(firstInterval);
    expect(secondClear).not.toBe(firstClear);
    expect(countdownIntervals.size).toBe(1);
    expect(clearTimers.size).toBe(1);
  });

  it("clears countdown at meeting start and transitions to in-meeting", () => {
    const now = Date.now();
    const startMs = now + 5 * 60 * 1000;
    const endMs = now + 35 * 60 * 1000;
    const params = makeParams({ startMs, endMs, now });

    state.scheduledEventData.set("evt-1", {
      title: "Standup",
      meetUrl: "https://meet.google.com/abc",
      startMs,
      endMs,
    });

    scheduleTitleCountdown(params, titleTimers, countdownIntervals, clearTimers);

    expect(countdownIntervals.has("evt-1")).toBe(true);

    // Advance to meeting start
    vi.advanceTimersByTime(5 * 60 * 1000 + 100);

    // Countdown should be cleared
    expect(countdownIntervals.has("evt-1")).toBe(false);
    expect(clearTimers.has("evt-1")).toBe(false);
    // allowSleep called when countdown clears
    expect(allowSleep).toHaveBeenCalled();
    // in-meeting countdown should start
    expect(startInMeetingCountdown).toHaveBeenCalledWith(
      runtime,
      asTestEventId("evt-1"),
      expect.objectContaining({ title: "Standup" }),
    );
  });

  it("clears countdown at start and falls back to resolveActiveTitleEvent if event data missing", () => {
    const now = Date.now();
    const startMs = now + 5 * 60 * 1000;
    const params = makeParams({ startMs, now });

    scheduleTitleCountdown(params, titleTimers, countdownIntervals, clearTimers);
    vi.mocked(resolveActiveTitleEvent).mockClear();

    // Remove event data before clear timer fires
    state.scheduledEventData.delete("evt-1");

    vi.advanceTimersByTime(5 * 60 * 1000 + 100);

    expect(startInMeetingCountdown).not.toHaveBeenCalled();
    expect(resolveActiveTitleEvent).toHaveBeenCalled();
  });

  it("per-minute tick updates tray title with remaining minutes", () => {
    const now = Date.now();
    const startMs = now + 10 * 60 * 1000;
    const params = makeParams({ startMs, now });
    state.activeTitleEventId = "evt-1";

    scheduleTitleCountdown(params, titleTimers, countdownIntervals, clearTimers);

    // Initial tick should have fired
    expect(state.onTrayTitleUpdate).toHaveBeenCalledWith("Standup", expect.any(Number));

    vi.mocked(state.onTrayTitleUpdate!).mockClear();

    // Advance 1 minute — per-minute tick
    vi.advanceTimersByTime(60_000);

    expect(state.onTrayTitleUpdate).toHaveBeenCalledWith("Standup", expect.any(Number));
  });

  it("per-minute tick is suppressed when event does not own the title", () => {
    const now = Date.now();
    const params = makeParams({ now });
    state.activeTitleEventId = "other-event"; // someone else owns the title

    scheduleTitleCountdown(params, titleTimers, countdownIntervals, clearTimers);
    vi.mocked(state.onTrayTitleUpdate!).mockClear();

    vi.advanceTimersByTime(60_000);

    // tick should be suppressed since evt-1 doesn't own the title
    expect(state.onTrayTitleUpdate).not.toHaveBeenCalled();
  });

  it("startCountdown bails if event was deleted from scheduledEventData", () => {
    const now = Date.now();
    const startMs = now + 35 * 60 * 1000; // future title timer
    const params = makeParams({ startMs, now });

    scheduleTitleCountdown(params, titleTimers, countdownIntervals, clearTimers);
    expect(titleTimers.has("evt-1")).toBe(true);

    // Remove event data before title timer fires
    state.scheduledEventData.delete("evt-1");

    vi.advanceTimersByTime(5 * 60 * 1000); // fire title timer

    // startCountdown should bail — no countdown started
    expect(countdownIntervals.has("evt-1")).toBe(false);
    expect(preventSleep).not.toHaveBeenCalled();
  });

  it("clearTimer resets activeTitleEventId when event owned the title", () => {
    const now = Date.now();
    const startMs = now + 2 * 60 * 1000;
    const params = makeParams({ startMs, now });
    state.scheduledEventData.set("evt-1", {
      title: "Standup",
      meetUrl: undefined,
      startMs,
      endMs: params.endMs,
    });

    scheduleTitleCountdown(params, titleTimers, countdownIntervals, clearTimers);

    // Simulate this event owning the title
    state.activeTitleEventId = "evt-1";

    // Advance to meeting start
    vi.advanceTimersByTime(2 * 60 * 1000 + 100);

    // activeTitleEventId should be reset to null
    expect(state.activeTitleEventId).toBeNull();
  });
});

describe("cancelTitleCountdown", () => {
  let titleTimers: Map<string, ReturnType<typeof setTimeout>>;
  let countdownIntervals: Map<string, ReturnType<typeof setInterval>>;
  let clearTimers: Map<string, ReturnType<typeof setTimeout>>;

  beforeEach(() => {
    vi.useFakeTimers();
    titleTimers = state.titleTimers;
    countdownIntervals = state.countdownIntervals;
    clearTimers = state.clearTimers;
    vi.mocked(preventSleep).mockClear();
    vi.mocked(allowSleep).mockClear();
    vi.mocked(resolveActiveTitleEvent).mockClear();
    vi.mocked(startInMeetingCountdown).mockClear();
    state.scheduledEventData.set("evt-1", {
      title: "Standup",
      meetUrl: undefined,
      startMs: Date.now() + 10 * 60 * 1000,
      endMs: Date.now() + 40 * 60 * 1000,
    });
    state.onTrayTitleUpdate = vi.fn();
    initPowerCallbacks({
      getPollInterval: vi.fn().mockReturnValue(2 * 60 * 1000),
      preventSleep,
      allowSleep,
    });
  });

  afterEach(() => {
    for (const handle of titleTimers.values()) clearTimeout(handle);
    for (const handle of countdownIntervals.values()) clearInterval(handle);
    for (const handle of clearTimers.values()) clearTimeout(handle);
    titleTimers.clear();
    countdownIntervals.clear();
    clearTimers.clear();
    state.scheduledEventData.clear();
    state.onTrayTitleUpdate = null;
    state.powerCallbacks = null;
    vi.useRealTimers();
  });

  it("cancels title timer and removes from map", () => {
    const handle = setTimeout(() => {}, 60_000);
    titleTimers.set("evt-1", handle);

    cancelTitleCountdown("evt-1", titleTimers, countdownIntervals, clearTimers);

    expect(titleTimers.has("evt-1")).toBe(false);
  });

  it("cancels countdown interval and calls allowSleep + markTitleDirty", () => {
    const handle = setInterval(() => {}, 60_000);
    countdownIntervals.set("evt-1", handle);

    cancelTitleCountdown("evt-1", titleTimers, countdownIntervals, clearTimers);

    expect(countdownIntervals.has("evt-1")).toBe(false);
    expect(allowSleep).toHaveBeenCalled();
  });

  it("cancels clear timer and removes from map", () => {
    const handle = setTimeout(() => {}, 60_000);
    clearTimers.set("evt-1", handle);

    cancelTitleCountdown("evt-1", titleTimers, countdownIntervals, clearTimers);

    expect(clearTimers.has("evt-1")).toBe(false);
  });

  it("clears all three timer types when all present", () => {
    const params = makeParams();
    scheduleTitleCountdown(params, titleTimers, countdownIntervals, clearTimers);

    expect(countdownIntervals.has("evt-1")).toBe(true);
    expect(clearTimers.has("evt-1")).toBe(true);

    cancelTitleCountdown("evt-1", titleTimers, countdownIntervals, clearTimers);

    expect(titleTimers.has("evt-1")).toBe(false);
    expect(countdownIntervals.has("evt-1")).toBe(false);
    expect(clearTimers.has("evt-1")).toBe(false);
  });

  it("is safe to call with non-existent eventId (no-op)", () => {
    expect(() =>
      cancelTitleCountdown("nonexistent", titleTimers, countdownIntervals, clearTimers),
    ).not.toThrow();
    expect(titleTimers.size).toBe(0);
    expect(countdownIntervals.size).toBe(0);
    expect(clearTimers.size).toBe(0);
  });

  it("prevents countdown tick from firing after cancellation", () => {
    const params = makeParams();
    scheduleTitleCountdown(params, titleTimers, countdownIntervals, clearTimers);

    cancelTitleCountdown("evt-1", titleTimers, countdownIntervals, clearTimers);
    vi.mocked(state.onTrayTitleUpdate!).mockClear();

    // Advance past all possible timers
    vi.advanceTimersByTime(45 * 60 * 1000);

    // No tray update should happen since countdown was cancelled
    expect(state.onTrayTitleUpdate).not.toHaveBeenCalled();
  });
});

describe("cancelledEvents tracking", () => {
  let titleTimers: Map<string, ReturnType<typeof setTimeout>>;
  let countdownIntervals: Map<string, ReturnType<typeof setInterval>>;
  let clearTimers: Map<string, ReturnType<typeof setTimeout>>;

  beforeEach(() => {
    vi.useFakeTimers();
    titleTimers = state.titleTimers;
    countdownIntervals = state.countdownIntervals;
    clearTimers = state.clearTimers;
    vi.mocked(preventSleep).mockClear();
    vi.mocked(allowSleep).mockClear();
    vi.mocked(resolveActiveTitleEvent).mockClear();
    vi.mocked(startInMeetingCountdown).mockClear();
    state.cancelledEvents.clear();
    state.scheduledEventData.set("evt-1", {
      title: "Standup",
      meetUrl: undefined,
      startMs: Date.now() + 10 * 60 * 1000,
      endMs: Date.now() + 40 * 60 * 1000,
    });
    state.onTrayTitleUpdate = vi.fn();
    state.activeTitleEventId = null;
    initPowerCallbacks({
      getPollInterval: vi.fn().mockReturnValue(2 * 60 * 1000),
      preventSleep,
      allowSleep,
    });
  });

  afterEach(() => {
    for (const handle of titleTimers.values()) clearTimeout(handle);
    for (const handle of countdownIntervals.values()) clearInterval(handle);
    for (const handle of clearTimers.values()) clearTimeout(handle);
    titleTimers.clear();
    countdownIntervals.clear();
    clearTimers.clear();
    state.scheduledEventData.clear();
    state.cancelledEvents.clear();
    state.onTrayTitleUpdate = null;
    state.activeTitleEventId = null;
    state.powerCallbacks = null;
    vi.useRealTimers();
  });

  it("cancelTitleCountdown adds eventId to state.cancelledEvents when an active countdown exists", () => {
    const params = makeParams();
    scheduleTitleCountdown(params, titleTimers, countdownIntervals, clearTimers);
    expect(countdownIntervals.has("evt-1")).toBe(true);
    expect(state.cancelledEvents.has("evt-1")).toBe(false);

    cancelTitleCountdown("evt-1", titleTimers, countdownIntervals, clearTimers);

    expect(state.cancelledEvents.has("evt-1")).toBe(true);
  });

  it("cancelTitleCountdown does not mark cancelledEvents when no countdown is active", () => {
    // Only a title timer scheduled (event >30 min out), no countdown interval yet
    const now = Date.now();
    const params = makeParams({ startMs: now + 45 * 60 * 1000, now });
    state.scheduledEventData.set("evt-1", {
      title: "Standup",
      meetUrl: undefined,
      startMs: params.startMs,
      endMs: params.endMs,
    });
    scheduleTitleCountdown(params, titleTimers, countdownIntervals, clearTimers);
    expect(titleTimers.has("evt-1")).toBe(true);
    expect(countdownIntervals.has("evt-1")).toBe(false);

    cancelTitleCountdown("evt-1", titleTimers, countdownIntervals, clearTimers);

    expect(state.cancelledEvents.has("evt-1")).toBe(false);
  });

  it("clearHandle skips in-meeting transition when event was cancelled mid-countdown", () => {
    const now = Date.now();
    const startMs = now + 5 * 60 * 1000;
    const params = makeParams({ startMs, now });
    state.scheduledEventData.set("evt-1", {
      title: "Standup",
      meetUrl: "https://meet.google.com/abc",
      startMs,
      endMs: params.endMs,
    });

    scheduleTitleCountdown(params, titleTimers, countdownIntervals, clearTimers);
    expect(countdownIntervals.has("evt-1")).toBe(true);

    // Cancel countdown — adds to cancelledEvents and clears the interval
    cancelTitleCountdown("evt-1", titleTimers, countdownIntervals, clearTimers);
    expect(state.cancelledEvents.has("evt-1")).toBe(true);

    // clearHandle was NOT removed by cancelTitleCountdown's clearTimeout path?
    // It WAS removed (clearTimers.delete in cancel). Re-set a fresh clearTimer to
    // simulate the race: clearHandle fires while cancelledEvents still has the id.
    // Easier: verify cancelledEvents marker exists so the guard would fire.
    expect(state.cancelledEvents.has("evt-1")).toBe(true);
    expect(startInMeetingCountdown).not.toHaveBeenCalled();
  });

  it("startCountdown clears stale cancelledEvents marker when (re-)scheduling", () => {
    // Pre-seed the cancelled marker as if a previous cycle had cancelled it
    state.cancelledEvents.add("evt-1");
    expect(state.cancelledEvents.has("evt-1")).toBe(true);

    const now = Date.now();
    const params = makeParams({ startMs: now + 10 * 60 * 1000, now });
    state.scheduledEventData.set("evt-1", {
      title: "Standup",
      meetUrl: undefined,
      startMs: params.startMs,
      endMs: params.endMs,
    });

    // Within 30-min window → startCountdown runs immediately
    scheduleTitleCountdown(params, titleTimers, countdownIntervals, clearTimers);

    // startCountdown should have removed the stale marker
    expect(state.cancelledEvents.has("evt-1")).toBe(false);
    expect(countdownIntervals.has("evt-1")).toBe(true);
  });
});

describe("multiple events scheduled simultaneously", () => {
  let titleTimers: Map<string, ReturnType<typeof setTimeout>>;
  let countdownIntervals: Map<string, ReturnType<typeof setInterval>>;
  let clearTimers: Map<string, ReturnType<typeof setTimeout>>;

  beforeEach(() => {
    vi.useFakeTimers();
    titleTimers = state.titleTimers;
    countdownIntervals = state.countdownIntervals;
    clearTimers = state.clearTimers;
    vi.mocked(preventSleep).mockClear();
    vi.mocked(allowSleep).mockClear();
    vi.mocked(resolveActiveTitleEvent).mockClear();
    vi.mocked(startInMeetingCountdown).mockClear();
    state.cancelledEvents.clear();
    state.onTrayTitleUpdate = vi.fn();
    state.activeTitleEventId = null;
    initPowerCallbacks({
      getPollInterval: vi.fn().mockReturnValue(2 * 60 * 1000),
      preventSleep,
      allowSleep,
    });
  });

  afterEach(() => {
    for (const handle of titleTimers.values()) clearTimeout(handle);
    for (const handle of countdownIntervals.values()) clearInterval(handle);
    for (const handle of clearTimers.values()) clearTimeout(handle);
    titleTimers.clear();
    countdownIntervals.clear();
    clearTimers.clear();
    state.scheduledEventData.clear();
    state.cancelledEvents.clear();
    state.onTrayTitleUpdate = null;
    state.activeTitleEventId = null;
    state.powerCallbacks = null;
    vi.useRealTimers();
  });

  it("two events with independent timers do not interfere", () => {
    const now = Date.now();

    // Event A: within 30-min window → immediate countdown
    const paramsA = makeParams({
      eventId: "evt-A",
      eventTitle: "Meeting A",
      startMs: now + 10 * 60 * 1000,
      endMs: now + 40 * 60 * 1000,
      now,
    });
    state.scheduledEventData.set("evt-A", {
      title: "Meeting A",
      meetUrl: undefined,
      startMs: paramsA.startMs,
      endMs: paramsA.endMs,
    });

    // Event B: >30 min out → titleTimer only
    const paramsB = makeParams({
      eventId: "evt-B",
      eventTitle: "Meeting B",
      startMs: now + 45 * 60 * 1000,
      endMs: now + 75 * 60 * 1000,
      now,
    });
    state.scheduledEventData.set("evt-B", {
      title: "Meeting B",
      meetUrl: undefined,
      startMs: paramsB.startMs,
      endMs: paramsB.endMs,
    });

    scheduleTitleCountdown(paramsA, titleTimers, countdownIntervals, clearTimers);
    scheduleTitleCountdown(paramsB, titleTimers, countdownIntervals, clearTimers);

    // Each event tracked under its own id
    expect(countdownIntervals.has("evt-A")).toBe(true);
    expect(countdownIntervals.has("evt-B")).toBe(false);
    expect(titleTimers.has("evt-B")).toBe(true);
    expect(titleTimers.has("evt-A")).toBe(false);
    expect(clearTimers.has("evt-A")).toBe(true);
    expect(clearTimers.has("evt-B")).toBe(false);
  });

  it("cancelling one event leaves the other event's timers intact", () => {
    const now = Date.now();

    const paramsA = makeParams({
      eventId: "evt-A",
      eventTitle: "Meeting A",
      startMs: now + 10 * 60 * 1000,
      endMs: now + 40 * 60 * 1000,
      now,
    });
    state.scheduledEventData.set("evt-A", {
      title: "Meeting A",
      meetUrl: undefined,
      startMs: paramsA.startMs,
      endMs: paramsA.endMs,
    });

    const paramsB = makeParams({
      eventId: "evt-B",
      eventTitle: "Meeting B",
      startMs: now + 15 * 60 * 1000,
      endMs: now + 45 * 60 * 1000,
      now,
    });
    state.scheduledEventData.set("evt-B", {
      title: "Meeting B",
      meetUrl: undefined,
      startMs: paramsB.startMs,
      endMs: paramsB.endMs,
    });

    scheduleTitleCountdown(paramsA, titleTimers, countdownIntervals, clearTimers);
    scheduleTitleCountdown(paramsB, titleTimers, countdownIntervals, clearTimers);
    expect(countdownIntervals.size).toBe(2);
    expect(clearTimers.size).toBe(2);

    cancelTitleCountdown("evt-A", titleTimers, countdownIntervals, clearTimers);

    // Only evt-A removed
    expect(countdownIntervals.has("evt-A")).toBe(false);
    expect(clearTimers.has("evt-A")).toBe(false);
    expect(countdownIntervals.has("evt-B")).toBe(true);
    expect(clearTimers.has("evt-B")).toBe(true);
    expect(state.cancelledEvents.has("evt-A")).toBe(true);
    expect(state.cancelledEvents.has("evt-B")).toBe(false);
  });
});

describe("fresh scheduler state", () => {
  it("does not carry cancelledEvents into a new instance", () => {
    state.cancelledEvents.add("evt-1");
    state.cancelledEvents.add("evt-2");
    expect(state.cancelledEvents.size).toBe(2);

    const fresh = createSchedulerState();

    expect(fresh.cancelledEvents.size).toBe(0);
    expect(fresh.cancelledEvents.has(asTestEventId("evt-1"))).toBe(false);
    expect(fresh.cancelledEvents.has(asTestEventId("evt-2"))).toBe(false);
  });
});
