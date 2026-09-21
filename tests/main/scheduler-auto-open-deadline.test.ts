import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MeetingEvent } from "../../src/domain/entities/meeting-event.js";
import type { AppSettings } from "../../src/domain/entities/settings.js";
import type { SchedulerRuntime } from "../../src/main/scheduler/runtime.js";
import {
  asTestEventId,
  asTestIsoUtc,
  createMockEvent,
  createMockSettings,
} from "../helpers/test-utils.js";
import { schedulerTestContext } from "../helpers/scheduler-runtime.js";

vi.mock("electron", () => {
  function MockNotification(this: { show: ReturnType<typeof vi.fn> }) {
    this.show = vi.fn();
  }

  return {
    Notification: MockNotification,
    shell: { openExternal: vi.fn().mockResolvedValue(undefined) },
  };
});

vi.mock("../../src/main/windows/alert-window.js", () => ({
  showAlert: vi.fn(),
}));

vi.mock("../../src/domain/services/build-meet-url.js", () => ({
  buildMeetUrl: vi
    .fn()
    .mockReturnValue("https://meet.google.com/abc-def-ghi?authuser=user%40test.com"),
}));

const { scheduleEvents } = await import("../../src/main/scheduler/index.js");
const { scheduleBrowserTimer } = await import("../../src/main/scheduler/browser-timer.js");
const { buildMeetUrl } = await import("../../src/domain/services/build-meet-url.js");

const BASE_NOW = new Date("2026-06-18T12:00:00.000Z").getTime();
const MINUTE_MS = 60_000;

function makeEvent(
  id: string,
  startMs: number,
  endMs: number,
  overrides: Partial<MeetingEvent> = {},
): MeetingEvent {
  return createMockEvent({
    id: asTestEventId(id),
    startDate: asTestIsoUtc(new Date(startMs).toISOString()),
    endDate: asTestIsoUtc(new Date(endMs).toISOString()),
    ...overrides,
  });
}

describe("scheduler browser auto-open deadline", () => {
  let settings: AppSettings;
  let runtime: SchedulerRuntime;
  let open: ReturnType<typeof schedulerTestContext>["open"];

  function setOpenBeforeMinutes(minutes: number): void {
    settings = createMockSettings({ openBeforeMinutes: minutes, windowAlert: false });
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(BASE_NOW);
    setOpenBeforeMinutes(3);
    const context = schedulerTestContext(() => settings);
    runtime = context.runtime;
    open = context.open;
    vi.mocked(buildMeetUrl).mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.mocked(buildMeetUrl).mockClear();
  });

  it("opens a future meeting at the configured offset before start", () => {
    const startMs = BASE_NOW + 10 * MINUTE_MS;
    const event = makeEvent("deadline-happy", startMs, startMs + 30 * MINUTE_MS);

    scheduleEvents(runtime, [event]);
    vi.advanceTimersByTime(7 * MINUTE_MS);

    expect(open).toHaveBeenCalledTimes(1);
    expect(runtime.state.firedEvents.has(event.id)).toBe(true);
  });

  it("opens an unchanged future meeting after scheduler epoch changes", () => {
    const startMs = BASE_NOW + 10 * MINUTE_MS;
    const event = makeEvent("deadline-epoch-change", startMs, startMs + 30 * MINUTE_MS);

    scheduleEvents(runtime, [event]);
    runtime.state.pollEpoch += 1;
    scheduleEvents(runtime, [event]);
    vi.advanceTimersByTime(7 * MINUTE_MS);

    expect(open).toHaveBeenCalledTimes(1);
    expect(runtime.state.firedEvents.has(event.id)).toBe(true);
    expect(runtime.state.timers.has(event.id)).toBe(false);
  });

  it("does not open a future meeting before the configured offset", () => {
    const startMs = BASE_NOW + 10 * MINUTE_MS;
    const event = makeEvent("deadline-early", startMs, startMs + 30 * MINUTE_MS);

    scheduleEvents(runtime, [event]);
    vi.advanceTimersByTime(7 * MINUTE_MS - 1);

    expect(open).not.toHaveBeenCalled();
    expect(runtime.state.firedEvents.has(event.id)).toBe(false);
    expect(runtime.state.timers.has(event.id)).toBe(true);
  });

  it("reschedules when openBeforeMinutes changes between polls", () => {
    const startMs = BASE_NOW + 10 * MINUTE_MS;
    const event = makeEvent("deadline-settings-change", startMs, startMs + 30 * MINUTE_MS);

    setOpenBeforeMinutes(1);
    scheduleEvents(runtime, [event]);

    setOpenBeforeMinutes(3);
    scheduleEvents(runtime, [event]);

    vi.advanceTimersByTime(7 * MINUTE_MS - 1);
    expect(open).not.toHaveBeenCalled();
    expect(runtime.state.firedEvents.has(event.id)).toBe(false);

    vi.advanceTimersByTime(1);
    expect(open).toHaveBeenCalledTimes(1);
    expect(runtime.state.firedEvents.has(event.id)).toBe(true);
  });

  it("does not auto-open an in-progress meeting first discovered after start", () => {
    const startMs = BASE_NOW - 30_000;
    const event = makeEvent("deadline-started", startMs, BASE_NOW + 30 * MINUTE_MS);

    scheduleEvents(runtime, [event]);
    vi.advanceTimersByTime(50);

    expect(open).not.toHaveBeenCalled();
    expect(runtime.state.firedEvents.has(event.id)).toBe(false);
    expect(runtime.state.timers.has(event.id)).toBe(false);
    expect(runtime.state.inMeetingIntervals.has(event.id)).toBe(true);
  });

  it("does not open when a browser timer callback runs at or after meeting start", () => {
    const startMs = BASE_NOW + MINUTE_MS;
    const endMs = startMs + 30 * MINUTE_MS;
    const event = makeEvent("deadline-late-callback", startMs, endMs);
    const openAtMs = startMs - 2 * MINUTE_MS;

    scheduleBrowserTimer(runtime, event, 2 * MINUTE_MS, openAtMs, startMs, endMs, 0);
    vi.advanceTimersByTime(2 * MINUTE_MS);

    expect(buildMeetUrl).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
    // Past start with grace 0: mark fired so we do not reschedule storms
    expect(runtime.state.firedEvents.has(event.id)).toBe(true);
    expect(runtime.state.timers.has(event.id)).toBe(false);
  });
});
