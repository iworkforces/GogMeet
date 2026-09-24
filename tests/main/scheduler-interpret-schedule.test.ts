import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { interpretSchedulePlan } from "../../src/main/scheduler/adapters/interpret-schedule.js";
import { showAlert } from "../../src/main/windows/alert-window.js";
import { schedulerTestContext } from "../helpers/scheduler-runtime.js";
import { asTestIsoUtc, createMockEvent } from "../helpers/test-utils.js";

vi.mock("../../src/main/windows/alert-window.js", () => ({ showAlert: vi.fn() }));

describe("interpretSchedulePlan", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("alert dismissal cancels the browser timer in the interpreted runtime", async () => {
    const context = schedulerTestContext();
    const now = Date.now();
    const event = createMockEvent({
      startDate: asTestIsoUtc(new Date(now + 6_000).toISOString()),
      endDate: asTestIsoUtc(new Date(now + 60_000).toISOString()),
    });
    interpretSchedulePlan(
      context.runtime,
      {
        activeIds: new Set([event.id]),
        actions: [
          {
            type: "set-snapshot",
            eventId: event.id,
            snapshot: {
              title: event.title,
              meetUrl: event.meetUrl,
              openAtMs: now + 5_000,
              startMs: now + 6_000,
              endMs: now + 60_000,
            },
          },
          {
            type: "arm-browser",
            event,
            delayMs: 5_000,
            openAtMs: now + 5_000,
            startMs: now + 6_000,
            endMs: now + 60_000,
            graceMs: 0,
            notify: false,
          },
          {
            type: "arm-alert",
            event,
            delayMs: 1_000,
            endMs: now + 60_000,
            alertLeadMs: 0,
            openAtMs: now + 5_000,
          },
        ],
      },
      { shouldAbort: () => false },
    );
    await vi.advanceTimersByTimeAsync(1_000);
    const dismiss = vi.mocked(showAlert).mock.calls[0]?.[1];
    expect(dismiss).toBeDefined();
    dismiss?.();
    expect(context.runtime.state.timers.has(event.id)).toBe(false);
    expect(context.runtime.state.firedEvents.has(event.id)).toBe(true);
  });
});
