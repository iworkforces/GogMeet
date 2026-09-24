import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { EventId } from "../../src/domain/entities/brand.js";
import type { MeetingEvent } from "../../src/domain/entities/meeting-event.js";
import { asTestEventId, createMockEvent } from "../helpers/test-utils.js";
import type { SchedulerRuntime } from "../../src/main/scheduler/runtime.js";
import { DEFAULT_SETTINGS } from "../../src/domain/entities/settings.js";
import { createSchedulerState } from "../../src/main/scheduler/state/index.js";
import { schedulerTestContext } from "../helpers/scheduler-runtime.js";

vi.mock("../../src/main/windows/alert-window.js", () => ({
  showAlert: vi.fn(),
}));

const { showAlert } = await import("../../src/main/windows/alert-window.js");
const { scheduleAlertTimer, cancelAlertTimer, ALERT_OFFSET_MS } =
  await import("../../src/main/scheduler/alert-timer.js");

function makeEvent(overrides: Partial<MeetingEvent> = {}): MeetingEvent {
  return createMockEvent({ id: asTestEventId("evt-1"), title: "Standup", ...overrides });
}

describe("scheduleAlertTimer", () => {
  let alertTimers: Map<EventId, ReturnType<typeof setTimeout>>;
  let alertFiredEvents: Map<EventId, number>;
  let runtime: SchedulerRuntime;

  beforeEach(() => {
    vi.useFakeTimers();
    runtime = schedulerTestContext().runtime;
    alertTimers = runtime.state.alertTimers;
    alertFiredEvents = runtime.state.alertFiredEvents;
    vi.mocked(showAlert).mockReset();
  });

  afterEach(() => {
    for (const handle of alertTimers.values()) clearTimeout(handle);
    alertTimers.clear();
    vi.useRealTimers();
  });

  it("creates a timer and stores it in alertTimers map", () => {
    const event = makeEvent();
    scheduleAlertTimer(runtime, event, 120_000, Date.now() + 30 * 60_000);

    expect(alertTimers.has(event.id)).toBe(true);
  });

  it("adds event to alertFiredEvents when timer fires", () => {
    const event = makeEvent();
    const delay = 120_000;
    scheduleAlertTimer(runtime, event, delay, Date.now() + 30 * 60_000);

    vi.advanceTimersByTime(delay); // alertDelay = 120000 - 60000 = 60000
    expect(alertFiredEvents.has(event.id)).toBe(true);
  });

  it("calls showAlert(event) when timer fires", () => {
    const event = makeEvent();
    const delay = 120_000;
    scheduleAlertTimer(runtime, event, delay, Date.now() + 30 * 60_000);

    vi.advanceTimersByTime(delay);
    expect(showAlert).toHaveBeenCalledWith(
      event,
      expect.any(Function),
      undefined,
      expect.any(Function),
    );
  });

  it("calls showAlert for events without meetUrl", () => {
    const event = makeEvent({ meetUrl: undefined });
    const delay = 120_000;
    scheduleAlertTimer(runtime, event, delay, Date.now() + 30 * 60_000);

    vi.advanceTimersByTime(delay);
    expect(showAlert).toHaveBeenCalledWith(
      event,
      expect.any(Function),
      undefined,
      expect.any(Function),
    );
    expect(event.meetUrl).toBeUndefined();
  });

  it("catches errors from showAlert gracefully", () => {
    vi.mocked(showAlert).mockImplementation(() => {
      throw new Error("window creation failed");
    });

    const event = makeEvent();
    const delay = 120_000;
    scheduleAlertTimer(runtime, event, delay, Date.now() + 30 * 60_000);

    // Should not throw
    expect(() => vi.advanceTimersByTime(delay)).not.toThrow();
    expect(alertFiredEvents.has(event.id)).toBe(true);
  });

  it("cancels existing timer before scheduling new one (idempotent)", () => {
    const event = makeEvent();
    scheduleAlertTimer(runtime, event, 120_000, Date.now() + 30 * 60_000);
    const firstHandle = alertTimers.get(event.id);

    scheduleAlertTimer(runtime, event, 180_000, Date.now() + 30 * 60_000);
    const secondHandle = alertTimers.get(event.id);

    expect(secondHandle).not.toBe(firstHandle);
    expect(alertTimers.size).toBe(1);

    // Advance past first delay — showAlert should NOT fire for the cancelled first timer
    vi.advanceTimersByTime(60_000); // 120000 - 60000 = 60000
    expect(showAlert).not.toHaveBeenCalled();

    // Advance to second timer: 180000 - 60000 = 120000
    vi.advanceTimersByTime(60_000);
    expect(showAlert).toHaveBeenCalledOnce();
  });

  it("calculates delay as effectiveDelay - ALERT_OFFSET_MS", () => {
    const event = makeEvent();
    const effectiveDelay = 90_000;
    const expectedAlertDelay = effectiveDelay - ALERT_OFFSET_MS; // 30000

    scheduleAlertTimer(runtime, event, effectiveDelay, Date.now() + 30 * 60_000);

    // Should NOT have fired yet at 29999ms
    vi.advanceTimersByTime(expectedAlertDelay - 1);
    expect(showAlert).not.toHaveBeenCalled();

    // Should fire at exactly 30000ms
    vi.advanceTimersByTime(1);
    expect(showAlert).toHaveBeenCalledOnce();
  });

  it("uses Math.max(0, ...) for delay (no negative delays)", () => {
    const event = makeEvent();
    // effectiveDelay < ALERT_OFFSET_MS → delay should be 0
    scheduleAlertTimer(runtime, event, 30_000, Date.now() + 30 * 60_000);

    // Should fire immediately (delay 0)
    vi.advanceTimersByTime(0);
    expect(showAlert).toHaveBeenCalledOnce();
  });

  it("removes timer from map when timer fires", () => {
    const event = makeEvent();
    scheduleAlertTimer(runtime, event, 120_000, Date.now() + 30 * 60_000);
    expect(alertTimers.has(event.id)).toBe(true);

    vi.advanceTimersByTime(60_000); // 120000 - 60000 = 60000
    expect(alertTimers.has(event.id)).toBe(false);
  });

  it.each([
    ["exact quiet start", 22, 0, "22:00", "07:00", true],
    ["overnight after midnight", 2, 0, "22:00", "07:00", true],
    ["exact quiet end", 7, 0, "22:00", "07:00", false],
    ["equal endpoints", 22, 0, "22:00", "22:00", false],
    ["invalid start", 22, 0, "invalid", "07:00", false],
    ["invalid end", 22, 0, "22:00", "invalid", false],
  ])("uses live quiet hours at %s", (_label, hour, minute, start, end, quiet) => {
    vi.setSystemTime(new Date(2026, 0, 2, hour, minute));
    runtime = schedulerTestContext({
      ...DEFAULT_SETTINGS,
      quietHoursEnabled: true,
      quietHoursStart: start,
      quietHoursEnd: end,
    }).runtime;
    const event = makeEvent();
    const endMs = Date.now() + 30 * 60_000;
    scheduleAlertTimer(runtime, event, 0, endMs);
    vi.advanceTimersByTime(0);

    expect(runtime.state.alertTimers.has(event.id)).toBe(false);
    expect(runtime.state.alertFiredEvents.get(event.id)).toBe(endMs + 15 * 60_000);
    expect(showAlert).toHaveBeenCalledTimes(quiet ? 0 : 1);
    expect(runtime.state.firedEvents.has(event.id)).toBe(false);
  });

  it("reads changed settings at fire and again when a queued alert is presented", () => {
    vi.setSystemTime(new Date(2026, 0, 2, 21, 59));
    let settings = { ...DEFAULT_SETTINGS, quietHoursEnabled: false };
    runtime = schedulerTestContext(() => settings).runtime;
    const event = makeEvent();
    scheduleAlertTimer(runtime, event, 0, Date.now() + 30 * 60_000);
    vi.advanceTimersByTime(0);
    const canShow = vi.mocked(showAlert).mock.calls[0]?.[3];
    expect(canShow?.()).toBe(true);
    settings = {
      ...settings,
      quietHoursEnabled: true,
      quietHoursStart: "22:00",
      quietHoursEnd: "07:00",
    };
    vi.setSystemTime(new Date(2026, 0, 2, 22, 0));
    expect(canShow?.()).toBe(false);
    expect(runtime.state.firedEvents.has(event.id)).toBe(false);
    expect(runtime.state.alertFiredEvents.has(event.id)).toBe(true);
  });

  it("uses the live settings getter when the timer fires rather than the scheduling snapshot", () => {
    vi.setSystemTime(new Date(2026, 0, 2, 21, 59));
    let settings = { ...DEFAULT_SETTINGS, quietHoursEnabled: false };
    runtime = schedulerTestContext(() => settings).runtime;
    const event = makeEvent();
    const endMs = Date.now() + 30 * 60_000;
    scheduleAlertTimer(runtime, event, 120_000, endMs);
    settings = {
      ...settings,
      quietHoursEnabled: true,
      quietHoursStart: "22:00",
      quietHoursEnd: "07:00",
    };
    vi.advanceTimersByTime(60_000);
    expect(showAlert).not.toHaveBeenCalled();
    expect(runtime.state.alertFiredEvents.get(event.id)).toBe(endMs + 15 * 60_000);
    expect(runtime.state.firedEvents.has(event.id)).toBe(false);
  });

  it("stale timer callback cannot remove successor handle or mark its alert fired", () => {
    const spy = vi.spyOn(globalThis, "setTimeout");
    const event = makeEvent();
    scheduleAlertTimer(runtime, event, 120_000, Date.now() + 30 * 60_000);
    const staleCallback = spy.mock.calls[0]?.[0];
    scheduleAlertTimer(runtime, event, 180_000, Date.now() + 40 * 60_000);
    const successorHandle = runtime.state.alertTimers.get(event.id);
    spy.mockRestore();
    if (typeof staleCallback !== "function") throw new Error("missing alert callback");
    staleCallback();
    expect(runtime.state.alertTimers.get(event.id)).toBe(successorHandle);
    expect(runtime.state.alertFiredEvents.has(event.id)).toBe(false);
    expect(showAlert).not.toHaveBeenCalled();
  });

  it("old dismissal cannot cancel a successor browser timer after same-id reschedule", () => {
    const event = makeEvent();
    scheduleAlertTimer(runtime, event, 0, Date.now() + 30 * 60_000);
    vi.advanceTimersByTime(0);
    const oldDismissal = vi.mocked(showAlert).mock.calls[0]?.[1];
    const oldCanShow = vi.mocked(showAlert).mock.calls[0]?.[3];
    const browserHandle = setTimeout(() => undefined, 300_000);
    runtime.state.timers.set(event.id, browserHandle);
    scheduleAlertTimer(runtime, event, 120_000, Date.now() + 40 * 60_000);
    oldDismissal?.();
    expect(oldCanShow?.()).toBe(false);
    expect(runtime.state.timers.get(event.id)).toBe(browserHandle);
    expect(runtime.state.firedEvents.has(event.id)).toBe(false);
  });

  it("old presentation cannot revive after a same-id, same-time successor fires", () => {
    const event = makeEvent();
    const endMs = Date.now() + 30 * 60_000;
    scheduleAlertTimer(runtime, event, 0, endMs);
    vi.advanceTimersByTime(0);
    const oldDismissal = vi.mocked(showAlert).mock.calls[0]?.[1];
    const oldCanShow = vi.mocked(showAlert).mock.calls[0]?.[3];

    scheduleAlertTimer(runtime, event, 0, endMs);
    vi.advanceTimersByTime(0);
    const currentDismissal = vi.mocked(showAlert).mock.calls[1]?.[1];
    const currentCanShow = vi.mocked(showAlert).mock.calls[1]?.[3];
    const browserHandle = setTimeout(() => undefined, 300_000);
    runtime.state.timers.set(event.id, browserHandle);

    expect(oldCanShow?.()).toBe(false);
    oldDismissal?.();
    expect(runtime.state.timers.get(event.id)).toBe(browserHandle);
    expect(currentCanShow?.()).toBe(true);
    currentDismissal?.();
    expect(runtime.state.timers.has(event.id)).toBe(false);
    expect(runtime.state.firedEvents.has(event.id)).toBe(true);
  });

  it("cancel revokes a fired alert presentation before a browser timer is dismissed", () => {
    const event = makeEvent();
    scheduleAlertTimer(runtime, event, 0, Date.now() + 30 * 60_000);
    vi.advanceTimersByTime(0);
    const dismissal = vi.mocked(showAlert).mock.calls[0]?.[1];
    const canShow = vi.mocked(showAlert).mock.calls[0]?.[3];
    const browserHandle = setTimeout(() => undefined, 300_000);
    runtime.state.timers.set(event.id, browserHandle);

    cancelAlertTimer(event.id, runtime.state);
    expect(canShow?.()).toBe(false);
    dismissal?.();
    expect(runtime.state.timers.get(event.id)).toBe(browserHandle);
  });

  it("stopped lifecycle timer and old dismissal cannot affect successor state", () => {
    const spy = vi.spyOn(globalThis, "setTimeout");
    const event = makeEvent();
    scheduleAlertTimer(runtime, event, 0, Date.now() + 30 * 60_000);
    const staleCallback = spy.mock.calls[0]?.[0];
    vi.advanceTimersByTime(0);
    const dismissal = vi.mocked(showAlert).mock.calls[0]?.[1];
    const canShow = vi.mocked(showAlert).mock.calls[0]?.[3];
    runtime.lifecycleGeneration += 1;
    runtime.state = createSchedulerState();
    scheduleAlertTimer(runtime, event, 120_000, Date.now() + 40 * 60_000);
    const successorHandle = runtime.state.alertTimers.get(event.id);
    spy.mockRestore();
    if (typeof staleCallback !== "function") throw new Error("missing alert callback");
    staleCallback();
    dismissal?.();
    expect(canShow?.()).toBe(false);
    expect(runtime.state.alertTimers.get(event.id)).toBe(successorHandle);
    expect(runtime.state.alertFiredEvents.has(event.id)).toBe(false);
    expect(runtime.state.firedEvents.has(event.id)).toBe(false);
  });
});

describe("cancelAlertTimer", () => {
  let alertTimers: Map<EventId, ReturnType<typeof setTimeout>>;
  let runtime: SchedulerRuntime;

  beforeEach(() => {
    vi.useFakeTimers();
    runtime = schedulerTestContext().runtime;
    alertTimers = runtime.state.alertTimers;
    vi.mocked(showAlert).mockReset();
  });

  afterEach(() => {
    for (const handle of alertTimers.values()) clearTimeout(handle);
    alertTimers.clear();
    vi.useRealTimers();
  });

  it("clears timer and removes from map", () => {
    const event = makeEvent();
    scheduleAlertTimer(runtime, event, 120_000, Date.now() + 30 * 60_000);
    expect(alertTimers.has(event.id)).toBe(true);

    cancelAlertTimer(event.id, runtime.state);
    expect(alertTimers.has(event.id)).toBe(false);

    // Timer should not fire after cancellation
    vi.advanceTimersByTime(120_000);
    expect(showAlert).not.toHaveBeenCalled();
  });

  it("is safe to call with non-existent eventId (no-op)", () => {
    expect(() => cancelAlertTimer(asTestEventId("nonexistent"), runtime.state)).not.toThrow();
    expect(alertTimers.size).toBe(0);
  });
});

describe("scheduleAlertTimer TTL suppression", () => {
  let alertTimers: Map<EventId, ReturnType<typeof setTimeout>>;
  let alertFiredEvents: Map<EventId, number>;
  let runtime: SchedulerRuntime;
  const FIFTEEN_MIN_MS = 15 * 60 * 1000;

  beforeEach(() => {
    vi.useFakeTimers();
    runtime = schedulerTestContext().runtime;
    alertTimers = runtime.state.alertTimers;
    alertFiredEvents = runtime.state.alertFiredEvents;
    vi.mocked(showAlert).mockReset();
  });

  afterEach(() => {
    for (const handle of alertTimers.values()) clearTimeout(handle);
    alertTimers.clear();
    vi.useRealTimers();
  });

  it("records expiry as endMs + 15min when timer fires", () => {
    const event = makeEvent();
    const endMs = Date.now() + 30 * 60_000;
    scheduleAlertTimer(runtime, event, 120_000, endMs);
    vi.advanceTimersByTime(60_000);
    expect(alertFiredEvents.get(event.id)).toBe(endMs + FIFTEEN_MIN_MS);
  });
});
