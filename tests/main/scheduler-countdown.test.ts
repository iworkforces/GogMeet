import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { ScheduledEventSnapshot } from "../../src/main/scheduler/state/index.js";
import { asTestEventId, asTestMeetUrl } from "../helpers/test-utils.js";
import type { SchedulerRuntime } from "../../src/main/scheduler/runtime.js";
import type { SchedulerState } from "../../src/main/scheduler/state/index.js";
import { schedulerTestContext } from "../helpers/scheduler-runtime.js";

// Mock power module
vi.mock("../../src/main/system/power.js", () => ({
  getPollInterval: vi.fn().mockReturnValue(2 * 60 * 1000),
  preventSleep: vi.fn(),
  allowSleep: vi.fn(),
}));

// Mock electron (required by transitive imports)
vi.mock("electron", () => ({
  app: { getPath: vi.fn().mockReturnValue("/tmp/test") },
}));

const {
  resolveActiveTitleEvent: resolveActiveTitleEventImpl,
  resolveActiveInMeetingEvent: resolveActiveInMeetingEventImpl,
  startInMeetingCountdown: startInMeetingCountdownImpl,
  clearAllDisplayTimers: clearAllDisplayTimersImpl,
} = await import("../../src/main/scheduler/countdown.js");

let runtime: SchedulerRuntime;
type TestSchedulerState = Omit<
  SchedulerState,
  | "countdownIntervals"
  | "scheduledEventData"
  | "inMeetingIntervals"
  | "inMeetingEndTimers"
  | "clearTimers"
  | "activeTitleEventId"
  | "activeInMeetingEventId"
> & {
  countdownIntervals: Map<string, ReturnType<typeof setInterval>>;
  scheduledEventData: Map<string, ScheduledEventSnapshot>;
  inMeetingIntervals: Map<string, ReturnType<typeof setInterval>>;
  inMeetingEndTimers: Map<string, ReturnType<typeof setTimeout>>;
  clearTimers: Map<string, ReturnType<typeof setTimeout>>;
  activeTitleEventId: string | null;
  activeInMeetingEventId: string | null;
};
let state: TestSchedulerState;

beforeEach(() => {
  runtime = schedulerTestContext().runtime;
  state = runtime.state.As<TestSchedulerState>();
});

function markTitleDirty(): void {
  state.titleDirty = true;
}

function resolveActiveTitleEvent(): void {
  resolveActiveTitleEventImpl(runtime);
}

function resolveActiveInMeetingEvent(): void {
  resolveActiveInMeetingEventImpl(runtime);
}

function startInMeetingCountdown(
  eventId: string,
  data: { readonly title: string; readonly endMs: number },
): void {
  startInMeetingCountdownImpl(runtime, asTestEventId(eventId), data);
}

function clearAllDisplayTimers(): void {
  clearAllDisplayTimersImpl(runtime);
}

function makeSnapshot(overrides: Partial<ScheduledEventSnapshot> = {}): ScheduledEventSnapshot {
  return {
    title: "Test Meeting",
    meetUrl: asTestMeetUrl("https://meet.google.com/abc"),
    openAtMs: Date.now() + 9 * 60 * 1000,
    startMs: Date.now() + 10 * 60 * 1000,
    endMs: Date.now() + 40 * 60 * 1000,
    ...overrides,
  };
}

describe("resolveActiveTitleEvent", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    state.countdownIntervals.clear();
    state.scheduledEventData.clear();
    state.inMeetingIntervals.clear();
    state.activeTitleEventId = null;
    state.activeInMeetingEventId = null;
    state.titleDirty = true; // force resolution
    state.inMeetingDirty = false;
    state.onTrayTitleUpdate = vi.fn();
  });

  afterEach(() => {
    state.countdownIntervals.clear();
    state.scheduledEventData.clear();
    state.inMeetingIntervals.clear();
    state.activeTitleEventId = null;
    state.activeInMeetingEventId = null;
    state.onTrayTitleUpdate = null;
    vi.useRealTimers();
  });

  it("returns early if in-meeting event is active with an interval", () => {
    state.activeInMeetingEventId = "im-1";
    state.inMeetingIntervals.set(
      "im-1",
      setInterval(() => {}, 60_000),
    );
    state.titleDirty = true;

    resolveActiveTitleEvent();

    // Should not have called tray update or changed activeTitleEventId
    expect(state.onTrayTitleUpdate).not.toHaveBeenCalled();
    // titleDirty unchanged (early return before clearing)
    expect(state.titleDirty).toBe(true);

    clearInterval(state.inMeetingIntervals.get("im-1")!);
    state.inMeetingIntervals.clear();
  });

  it("returns cached value when titleDirty is false and activeTitleEventId is set", () => {
    state.titleDirty = false;
    state.activeTitleEventId = "cached-1";

    resolveActiveTitleEvent();

    expect(state.onTrayTitleUpdate).not.toHaveBeenCalled();
  });

  it("selects earliest-starting event among countdown intervals", () => {
    const now = Date.now();
    // Event A: starts in 20 min
    state.countdownIntervals.set(
      "A",
      setInterval(() => {}, 60_000),
    );
    state.scheduledEventData.set(
      "A",
      makeSnapshot({
        title: "Meeting A",
        startMs: now + 20 * 60 * 1000,
      }),
    );
    // Event B: starts in 5 min (earlier)
    state.countdownIntervals.set(
      "B",
      setInterval(() => {}, 60_000),
    );
    state.scheduledEventData.set(
      "B",
      makeSnapshot({
        title: "Meeting B",
        startMs: now + 5 * 60 * 1000,
      }),
    );

    resolveActiveTitleEvent();

    expect(state.activeTitleEventId).toBe("B");
    expect(state.onTrayTitleUpdate).toHaveBeenCalledWith("Meeting B", expect.any(Number));
    expect(state.titleDirty).toBe(false);

    clearInterval(state.countdownIntervals.get("A")!);
    clearInterval(state.countdownIntervals.get("B")!);
    state.countdownIntervals.clear();
  });

  it("clears tray when no countdown intervals exist", () => {
    state.titleDirty = true;
    // No intervals

    resolveActiveTitleEvent();

    expect(state.activeTitleEventId).toBeNull();
    expect(state.onTrayTitleUpdate).toHaveBeenCalledWith(null);
    expect(state.titleDirty).toBe(false);
  });

  it("re-resolves after markTitleDirty() clears cache", () => {
    // First resolution
    const now = Date.now();
    state.countdownIntervals.set(
      "evt-1",
      setInterval(() => {}, 60_000),
    );
    state.scheduledEventData.set(
      "evt-1",
      makeSnapshot({
        title: "My Meeting",
        startMs: now + 10 * 60 * 1000,
      }),
    );

    resolveActiveTitleEvent();
    expect(state.activeTitleEventId).toBe("evt-1");
    expect(state.titleDirty).toBe(false);
    vi.mocked(state.onTrayTitleUpdate!).mockClear();

    // Second call without marking dirty — should early-return
    resolveActiveTitleEvent();
    expect(state.onTrayTitleUpdate).not.toHaveBeenCalled();

    // Mark dirty and re-resolve
    markTitleDirty();
    expect(state.titleDirty).toBe(true);
    resolveActiveTitleEvent();
    expect(state.onTrayTitleUpdate).toHaveBeenCalledWith("My Meeting", expect.any(Number));

    clearInterval(state.countdownIntervals.get("evt-1")!);
    state.countdownIntervals.clear();
  });

  it("skips countdown intervals with no scheduledEventData", () => {
    state.countdownIntervals.set(
      "no-data",
      setInterval(() => {}, 60_000),
    );
    // No corresponding entry in scheduledEventData

    resolveActiveTitleEvent();

    expect(state.activeTitleEventId).toBeNull();
    expect(state.onTrayTitleUpdate).toHaveBeenCalledWith(null);

    clearInterval(state.countdownIntervals.get("no-data")!);
    state.countdownIntervals.clear();
  });
});

describe("resolveActiveInMeetingEvent", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    state.inMeetingIntervals.clear();
    state.countdownIntervals.clear();
    state.scheduledEventData.clear();
    state.activeInMeetingEventId = null;
    state.activeTitleEventId = null;
    state.inMeetingDirty = true;
    state.titleDirty = false;
    state.onTrayTitleUpdate = vi.fn();
  });

  afterEach(() => {
    state.inMeetingIntervals.clear();
    state.countdownIntervals.clear();
    state.scheduledEventData.clear();
    state.activeInMeetingEventId = null;
    state.activeTitleEventId = null;
    state.onTrayTitleUpdate = null;
    vi.useRealTimers();
  });

  it("returns cached value when inMeetingDirty is false and activeInMeetingEventId is set", () => {
    state.inMeetingDirty = false;
    state.activeInMeetingEventId = "cached-im";

    resolveActiveInMeetingEvent();

    expect(state.onTrayTitleUpdate).not.toHaveBeenCalled();
  });

  it("selects soonest-ending event among in-meeting intervals", () => {
    const now = Date.now();
    // Event A: ends in 30 min
    state.inMeetingIntervals.set(
      "A",
      setInterval(() => {}, 60_000),
    );
    state.scheduledEventData.set(
      "A",
      makeSnapshot({
        title: "Meeting A",
        endMs: now + 30 * 60 * 1000,
      }),
    );
    // Event B: ends in 10 min (sooner)
    state.inMeetingIntervals.set(
      "B",
      setInterval(() => {}, 60_000),
    );
    state.scheduledEventData.set(
      "B",
      makeSnapshot({
        title: "Meeting B",
        endMs: now + 10 * 60 * 1000,
      }),
    );

    resolveActiveInMeetingEvent();

    expect(state.activeInMeetingEventId).toBe("B");
    expect(state.onTrayTitleUpdate).toHaveBeenCalledWith("Meeting B", expect.any(Number), true);
    expect(state.inMeetingDirty).toBe(false);

    clearInterval(state.inMeetingIntervals.get("A")!);
    clearInterval(state.inMeetingIntervals.get("B")!);
    state.inMeetingIntervals.clear();
  });

  it("falls back to resolveActiveTitleEvent when no in-meeting intervals", () => {
    state.inMeetingDirty = true;
    // Set up a countdown so resolveActiveTitleEvent has something to do
    state.titleDirty = true;

    resolveActiveInMeetingEvent();

    expect(state.activeInMeetingEventId).toBeNull();
    // Falls back — resolveActiveTitleEvent was called (tray cleared since no countdowns)
    expect(state.onTrayTitleUpdate).toHaveBeenCalledWith(null);
  });

  it("skips in-meeting intervals with no scheduledEventData", () => {
    state.inMeetingIntervals.set(
      "no-data",
      setInterval(() => {}, 60_000),
    );

    resolveActiveInMeetingEvent();

    expect(state.activeInMeetingEventId).toBeNull();

    clearInterval(state.inMeetingIntervals.get("no-data")!);
    state.inMeetingIntervals.clear();
  });
});

describe("startInMeetingCountdown", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    state.inMeetingIntervals.clear();
    state.inMeetingEndTimers.clear();
    state.scheduledEventData.clear();
    state.countdownIntervals.clear();
    state.activeInMeetingEventId = null;
    state.activeTitleEventId = null;
    state.inMeetingDirty = false;
    state.titleDirty = false;
    state.onTrayTitleUpdate = vi.fn();
  });

  afterEach(() => {
    for (const handle of state.inMeetingIntervals.values()) clearInterval(handle);
    for (const handle of state.inMeetingEndTimers.values()) clearTimeout(handle);
    state.inMeetingIntervals.clear();
    state.inMeetingEndTimers.clear();
    state.scheduledEventData.clear();
    state.countdownIntervals.clear();
    state.activeInMeetingEventId = null;
    state.activeTitleEventId = null;
    state.onTrayTitleUpdate = null;
    vi.useRealTimers();
  });

  it("does nothing when meeting has already ended", () => {
    const now = Date.now();
    startInMeetingCountdown("evt-1", { title: "Ended", endMs: now - 1000 });

    expect(state.inMeetingIntervals.has("evt-1")).toBe(false);
    expect(state.inMeetingEndTimers.has("evt-1")).toBe(false);
  });

  it("creates interval and end timer for active meeting", () => {
    const now = Date.now();
    const endMs = now + 30 * 60 * 1000;
    state.scheduledEventData.set("evt-1", makeSnapshot({ endMs }));

    startInMeetingCountdown("evt-1", { title: "Active Meeting", endMs });

    expect(state.inMeetingIntervals.has("evt-1")).toBe(true);
    expect(state.inMeetingEndTimers.has("evt-1")).toBe(true);
  });

  it("resolves active in-meeting event after starting", () => {
    const now = Date.now();
    const endMs = now + 30 * 60 * 1000;
    state.scheduledEventData.set("evt-1", makeSnapshot({ title: "Meeting", endMs }));

    startInMeetingCountdown("evt-1", { title: "Meeting", endMs });

    expect(state.activeInMeetingEventId).toBe("evt-1");
    expect(state.inMeetingDirty).toBe(false); // resolved
  });

  it("per-minute tick updates tray with remaining time (in-meeting)", () => {
    const now = Date.now();
    const endMs = now + 15 * 60 * 1000;
    state.scheduledEventData.set("evt-1", makeSnapshot({ title: "Meeting", endMs }));

    startInMeetingCountdown("evt-1", { title: "Meeting", endMs });
    vi.mocked(state.onTrayTitleUpdate!).mockClear();

    // Advance 1 minute — tick fires
    vi.advanceTimersByTime(60_000);

    expect(state.onTrayTitleUpdate).toHaveBeenCalledWith("Meeting", expect.any(Number), true);
  });

  it("per-minute tick is suppressed when event does not own in-meeting title", () => {
    const now = Date.now();
    const endMs = now + 15 * 60 * 1000;
    state.scheduledEventData.set("evt-1", makeSnapshot({ title: "Meeting", endMs }));

    startInMeetingCountdown("evt-1", { title: "Meeting", endMs });

    // Change ownership
    state.activeInMeetingEventId = "other-event";
    vi.mocked(state.onTrayTitleUpdate!).mockClear();

    vi.advanceTimersByTime(60_000);

    expect(state.onTrayTitleUpdate).not.toHaveBeenCalled();
  });

  it("cleans up at meeting end and re-resolves", () => {
    const now = Date.now();
    const endMs = now + 5 * 60 * 1000;
    state.scheduledEventData.set("evt-1", makeSnapshot({ title: "Short Meeting", endMs }));

    startInMeetingCountdown("evt-1", { title: "Short Meeting", endMs });

    expect(state.inMeetingIntervals.has("evt-1")).toBe(true);
    expect(state.inMeetingEndTimers.has("evt-1")).toBe(true);

    // Advance to meeting end
    vi.advanceTimersByTime(5 * 60 * 1000 + 100);

    expect(state.inMeetingIntervals.has("evt-1")).toBe(false);
    expect(state.inMeetingEndTimers.has("evt-1")).toBe(false);
    expect(state.scheduledEventData.has("evt-1")).toBe(false);
    expect(state.activeInMeetingEventId).toBeNull();
  });

  it("end timer resets activeInMeetingEventId when event owned it", () => {
    const now = Date.now();
    const endMs = now + 3 * 60 * 1000;
    state.scheduledEventData.set("evt-1", makeSnapshot({ endMs }));

    startInMeetingCountdown("evt-1", { title: "Meeting", endMs });
    expect(state.activeInMeetingEventId).toBe("evt-1");

    vi.advanceTimersByTime(3 * 60 * 1000 + 100);

    expect(state.activeInMeetingEventId).toBeNull();
  });

  it("per-minute tick cleans up when remaining drops to zero (sleep-delayed end)", () => {
    const now = Date.now();
    // End just under 60s away so the first interval tick sees remaining <= 0
    // after advancing one minute past the end.
    const endMs = now + 30 * 1000;
    state.scheduledEventData.set("evt-1", makeSnapshot({ title: "Almost Done", endMs }));

    startInMeetingCountdown("evt-1", { title: "Almost Done", endMs });
    expect(state.inMeetingIntervals.has("evt-1")).toBe(true);

    // Advance past end via interval path (simulate delayed end timeout).
    vi.advanceTimersByTime(60_000 + 100);

    expect(state.inMeetingIntervals.has("evt-1")).toBe(false);
    expect(state.scheduledEventData.has("evt-1")).toBe(false);
    expect(state.activeInMeetingEventId).toBeNull();
  });
});

describe("clearAllDisplayTimers", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    state.powerCallbacks = null;
  });

  afterEach(() => {
    state.countdownIntervals.clear();
    state.clearTimers.clear();
    state.inMeetingIntervals.clear();
    state.inMeetingEndTimers.clear();
    state.powerCallbacks = null;
    vi.useRealTimers();
  });

  it("releases pre-meeting sleep blocker when clearing active countdown timers", () => {
    const allowSleep = vi.fn();
    const eventId = asTestEventId("a");
    state.powerCallbacks = {
      getPollInterval: vi.fn().mockReturnValue(2 * 60 * 1000),
      preventSleep: vi.fn(),
      allowSleep,
    };
    state.countdownIntervals.set(
      eventId,
      setInterval(() => {}, 60_000),
    );
    state.clearTimers.set(
      eventId,
      setTimeout(() => {}, 60_000),
    );

    clearAllDisplayTimers();

    expect(allowSleep).toHaveBeenCalledTimes(1);
    expect(state.countdownIntervals.size).toBe(0);
    expect(state.clearTimers.size).toBe(0);
  });

  it("does not release sleep when no countdown interval was active", () => {
    const allowSleep = vi.fn();
    const eventId = asTestEventId("a");
    state.powerCallbacks = {
      getPollInterval: vi.fn().mockReturnValue(2 * 60 * 1000),
      preventSleep: vi.fn(),
      allowSleep,
    };
    state.clearTimers.set(
      eventId,
      setTimeout(() => {}, 60_000),
    );

    clearAllDisplayTimers();

    expect(allowSleep).not.toHaveBeenCalled();
    expect(state.clearTimers.size).toBe(0);
  });

  it("clears in-meeting timers without touching pre-meeting sleep state", () => {
    const allowSleep = vi.fn();
    const eventId = asTestEventId("c");
    state.powerCallbacks = {
      getPollInterval: vi.fn().mockReturnValue(2 * 60 * 1000),
      preventSleep: vi.fn(),
      allowSleep,
    };
    state.inMeetingIntervals.set(
      eventId,
      setInterval(() => {}, 60_000),
    );
    state.inMeetingEndTimers.set(
      eventId,
      setTimeout(() => {}, 60_000),
    );

    clearAllDisplayTimers();

    expect(allowSleep).not.toHaveBeenCalled();
    expect(state.inMeetingIntervals.size).toBe(0);
    expect(state.inMeetingEndTimers.size).toBe(0);
  });

  it("clears all countdown and in-meeting timer maps", () => {
    // Populate all 4 maps
    state.countdownIntervals.set(
      "a",
      setInterval(() => {}, 60_000),
    );
    state.countdownIntervals.set(
      "b",
      setInterval(() => {}, 60_000),
    );
    state.clearTimers.set(
      "a",
      setTimeout(() => {}, 60_000),
    );
    state.inMeetingIntervals.set(
      "c",
      setInterval(() => {}, 60_000),
    );
    state.inMeetingEndTimers.set(
      "c",
      setTimeout(() => {}, 60_000),
    );

    clearAllDisplayTimers();

    expect(state.countdownIntervals.size).toBe(0);
    expect(state.clearTimers.size).toBe(0);
    expect(state.inMeetingIntervals.size).toBe(0);
    expect(state.inMeetingEndTimers.size).toBe(0);
  });

  it("is safe to call when maps are already empty", () => {
    expect(() => clearAllDisplayTimers()).not.toThrow();
    expect(state.countdownIntervals.size).toBe(0);
  });
});
