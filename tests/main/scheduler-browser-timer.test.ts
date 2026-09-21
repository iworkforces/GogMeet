import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { EventId } from "../../src/domain/entities/brand.js";
import type { MeetingEvent } from "../../src/domain/entities/meeting-event.js";
import { asTestEventId, createMockEvent } from "../helpers/test-utils.js";
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
