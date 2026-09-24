import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { EventId } from "../../src/domain/entities/brand.js";
import type { MeetingEvent } from "../../src/domain/entities/meeting-event.js";
import type { AppSettings } from "../../src/domain/entities/settings.js";
import { asTestEventId, createMockEvent, createMockSettings } from "../helpers/test-utils.js";
import type { SchedulerRuntime } from "../../src/main/scheduler/runtime.js";
import { schedulerTestContext } from "../helpers/scheduler-runtime.js";

// Override the global electron mock with a constructable Notification
vi.mock("electron", () => {
  const MockNotification = vi.fn().mockImplementation(function (this: Record<string, unknown>) {
    this.show = vi.fn();
  });
  return {
    Notification: MockNotification,
  };
});

vi.mock("../../src/domain/services/build-meet-url.js", () => ({
  buildMeetUrl: vi
    .fn()
    .mockReturnValue("https://meet.google.com/abc-def-ghi?authuser=user%40test.com"),
}));

const { Notification } = await import("electron");
const { buildMeetUrl } = await import("../../src/domain/services/build-meet-url.js");
const { scheduleBrowserTimer, cancelBrowserTimer } =
  await import("../../src/main/scheduler/browser-timer.js");

function makeEvent(overrides: Partial<MeetingEvent> = {}): MeetingEvent {
  return createMockEvent({
    id: asTestEventId("evt-1"),
    title: "Standup",
    userEmail: "user@test.com",
    ...overrides,
  });
}

describe("scheduleBrowserTimer", () => {
  let timers: Map<EventId, ReturnType<typeof setTimeout>>;
  let firedEvents: Map<EventId, number>;
  let runtime: SchedulerRuntime;
  let open: ReturnType<typeof schedulerTestContext>["open"];

  const effectiveDelay = 60_000;
  const startMs = Date.now() + 5 * 60 * 1000;
  const openAtMs = startMs - effectiveDelay;
  const endMs = Date.now() + 35 * 60 * 1000;

  beforeEach(() => {
    vi.useFakeTimers();
    const context = schedulerTestContext();
    runtime = context.runtime;
    open = context.open;
    timers = runtime.state.timers;
    firedEvents = runtime.state.firedEvents;
    vi.mocked(buildMeetUrl).mockClear();
    vi.mocked(Notification).mockClear();
  });

  afterEach(() => {
    for (const handle of timers.values()) clearTimeout(handle);
    timers.clear();
    vi.useRealTimers();
  });

  function schedule(event: MeetingEvent): void {
    scheduleBrowserTimer(runtime, event, effectiveDelay, openAtMs, startMs, endMs, 0);
  }

  it("creates a timer and stores it in timers map", () => {
    const event = makeEvent();
    schedule(event);

    expect(timers.has(event.id)).toBe(true);
  });

  it("does not write schedule snapshots (interpreter owns set-snapshot)", () => {
    // scheduleBrowserTimer no longer accepts scheduledEventData — snapshots
    // must come from interpretSchedulePlan applying set-snapshot.
    const event = makeEvent();
    schedule(event);
    expect(timers.has(event.id)).toBe(true);
  });

  it("adds event to firedEvents when timer fires", () => {
    const event = makeEvent();
    schedule(event);

    vi.advanceTimersByTime(60_000);
    expect(firedEvents.has(event.id)).toBe(true);
  });

  it("shows Notification when timer fires", () => {
    const event = makeEvent();
    schedule(event);

    vi.advanceTimersByTime(60_000);
    expect(Notification).toHaveBeenCalledWith({
      title: "Standup",
      body: expect.stringMatching(/^Starting (now|in \d+ min)$/),
    });
  });

  it("with meetUrl: opens browser via the owning opener", () => {
    const event = makeEvent();
    schedule(event);

    vi.advanceTimersByTime(60_000);
    expect(open).toHaveBeenCalledWith(
      "https://meet.google.com/abc-def-ghi?authuser=user%40test.com",
    );
  });

  it("without meetUrl: does NOT open browser, just logs", () => {
    const event = makeEvent({ meetUrl: undefined });
    schedule(event);

    vi.advanceTimersByTime(60_000);
    expect(open).not.toHaveBeenCalled();
    expect(buildMeetUrl).not.toHaveBeenCalled();
  });

  it("builds correct URL via buildMeetUrl()", () => {
    const event = makeEvent();
    schedule(event);

    vi.advanceTimersByTime(60_000);
    expect(buildMeetUrl).toHaveBeenCalledWith(event);
  });

  it("removes timer from map when timer fires", () => {
    const event = makeEvent();
    schedule(event);
    expect(timers.has(event.id)).toBe(true);

    vi.advanceTimersByTime(60_000);
    expect(timers.has(event.id)).toBe(false);
  });
});

describe("cancelBrowserTimer", () => {
  let timers: Map<EventId, ReturnType<typeof setTimeout>>;
  let runtime: SchedulerRuntime;
  let open: ReturnType<typeof schedulerTestContext>["open"];

  beforeEach(() => {
    vi.useFakeTimers();
    const context = schedulerTestContext();
    runtime = context.runtime;
    open = context.open;
    timers = runtime.state.timers;
  });

  afterEach(() => {
    for (const handle of timers.values()) clearTimeout(handle);
    timers.clear();
    vi.useRealTimers();
  });

  it("clears timer and removes from map", () => {
    const event = makeEvent();
    const startMs = Date.now();
    const openAtMs = startMs - 60_000;
    scheduleBrowserTimer(runtime, event, 60_000, openAtMs, startMs, startMs + 30 * 60_000, 0);
    expect(timers.has(event.id)).toBe(true);

    cancelBrowserTimer(event.id, timers);
    expect(timers.has(event.id)).toBe(false);

    // Timer should not fire after cancellation
    vi.advanceTimersByTime(60_000);
    expect(open).not.toHaveBeenCalled();
  });

  it("is safe to call with non-existent eventId (no-op)", () => {
    expect(() => cancelBrowserTimer(asTestEventId("nonexistent"), timers)).not.toThrow();
    expect(timers.size).toBe(0);
  });
});

describe("scheduleBrowserTimer TTL suppression", () => {
  const FIFTEEN_MIN_MS = 15 * 60 * 1000;

  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => vi.useRealTimers());

  it("records expiry as endMs + 15min when timer fires", () => {
    const runtime = schedulerTestContext().runtime;
    const firedEvents = runtime.state.firedEvents;
    const event = makeEvent();
    const startMs = Date.now() + 5 * 60_000;
    const openAtMs = startMs - 60_000;
    const endMs = Date.now() + 35 * 60_000;
    scheduleBrowserTimer(runtime, event, 60_000, openAtMs, startMs, endMs, 0);
    vi.advanceTimersByTime(60_000);
    expect(firedEvents.get(event.id)).toBe(endMs + FIFTEEN_MIN_MS);
  });
});

describe("browser timer notification at firing", () => {
  let settings: AppSettings;
  let runtime: SchedulerRuntime;
  let open: ReturnType<typeof schedulerTestContext>["open"];
  const delay = 60_000;

  beforeEach(() => {
    vi.useFakeTimers();
    settings = createMockSettings();
    const context = schedulerTestContext(() => settings);
    runtime = context.runtime;
    open = context.open;
    vi.mocked(Notification).mockClear();
  });

  afterEach(() => vi.useRealTimers());

  function arm(planned = true): MeetingEvent {
    const event = makeEvent();
    const startMs = Date.now() + 5 * 60_000;
    const endMs = startMs + 30 * 60_000;
    scheduleBrowserTimer(runtime, event, delay, 0, startMs, endMs, 0, {
      nativeNotifications: planned,
    });
    return event;
  }

  it.each<[string, string, string, string, boolean, boolean]>([
    ["quiet at planning then open at firing", "22:59", "22:00", "23:00", true, true],
    ["open at planning then quiet at firing", "21:59", "22:00", "23:00", true, false],
    ["overnight after midnight", "23:59", "22:00", "07:00", true, false],
    ["overnight end is exclusive", "06:59", "22:00", "07:00", true, true],
    ["equal endpoints do not mute", "10:59", "11:00", "11:00", true, true],
    ["invalid endpoint does not mute", "10:59", "invalid", "12:00", true, true],
    ["disabled quiet hours do not mute", "21:59", "22:00", "23:00", false, true],
  ])("%s", (_name, plan, start, end, enabled, expected) => {
    const [planHours, planMinutes] = plan.split(":").map(Number);
    vi.setSystemTime(new Date(2026, 5, 18, planHours, planMinutes));
    settings = createMockSettings({
      quietHoursEnabled: true,
      quietHoursStart: start,
      quietHoursEnd: end,
    });
    arm();
    settings = { ...settings, quietHoursEnabled: enabled };

    vi.advanceTimersByTime(delay);

    expect(Notification).toHaveBeenCalledTimes(expected ? 1 : 0);
    expect(open).toHaveBeenCalledTimes(1);
  });

  it.each([
    { name: "turned off", planned: true, current: false },
    { name: "turned on after planning", planned: false, current: true },
  ])("keeps native notification suppressed when $name", ({ planned, current }) => {
    vi.setSystemTime(new Date(2026, 5, 18, 12, 0));
    settings = createMockSettings({ nativeNotifications: planned });
    arm(planned);
    settings = createMockSettings({ nativeNotifications: current });

    vi.advanceTimersByTime(delay);

    expect(Notification).not.toHaveBeenCalled();
    expect(open).toHaveBeenCalledTimes(1);
  });

  it.each([
    { graceMs: 30_001, expected: 1 },
    { graceMs: 30_000, expected: 0 },
  ])("uses exact grace deadline with $graceMs ms grace", ({ graceMs, expected }) => {
    vi.setSystemTime(new Date(2026, 5, 18, 12, 0));
    const event = makeEvent();
    const startMs = Date.now() + 30_000;
    const endMs = startMs + 30 * 60_000;
    scheduleBrowserTimer(runtime, event, delay, Date.now(), startMs, endMs, graceMs);

    vi.advanceTimersByTime(delay);

    expect(Notification).toHaveBeenCalledTimes(expected);
    expect(open).toHaveBeenCalledTimes(expected);
    expect(runtime.state.firedEvents.get(event.id)).toBe(endMs + 15 * 60_000);
  });

  it("does not let a replaced or stopped callback mutate state or open", () => {
    vi.setSystemTime(new Date(2026, 5, 18, 12, 0));
    const timeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const event = arm();
    const staleCallback = timeoutSpy.mock.calls.at(-1)?.[0];
    if (typeof staleCallback !== "function") throw new Error("timer callback missing");
    arm();
    staleCallback();
    expect(runtime.state.timers.has(event.id)).toBe(true);
    expect(runtime.state.firedEvents.has(event.id)).toBe(false);
    runtime.lifecycleGeneration += 1;
    runtime.state = schedulerTestContext(() => settings).runtime.state;

    vi.advanceTimersByTime(delay);
    staleCallback();

    expect(runtime.state.firedEvents.has(event.id)).toBe(false);
    expect(Notification).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
    timeoutSpy.mockRestore();
  });
});
