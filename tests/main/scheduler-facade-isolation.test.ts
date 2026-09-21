import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSchedulerFacade } from "../../src/main/scheduler/facade.js";
import { schedulerTestContext } from "../helpers/scheduler-runtime.js";
import {
  asTestIsoUtc,
  createMockEvent,
  createMockSettings,
  okCalendarResult,
} from "../helpers/test-utils.js";

describe("scheduler facade instance isolation", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("interleaves polls, deferred opens, stop, and cancellation without crossing owners", async () => {
    const now = Date.now();
    const event = createMockEvent({
      startDate: asTestIsoUtc(new Date(now + 61_000).toISOString()),
      endDate: asTestIsoUtc(new Date(now + 120_000).toISOString()),
    });
    const settings = createMockSettings({
      openBeforeMinutes: 1,
      windowAlert: false,
      nativeNotifications: false,
    });
    const first = schedulerTestContext(settings);
    const second = schedulerTestContext(settings);
    first.refresh.mockResolvedValue({
      publicationGeneration: 1,
      result: okCalendarResult([event]),
    });
    second.refresh.mockResolvedValue({
      publicationGeneration: 8,
      result: okCalendarResult([event]),
    });
    const firstFacade = createSchedulerFacade(first.dependencies);
    const secondFacade = createSchedulerFacade(second.dependencies);

    await Promise.all([
      firstFacade.forcePoll({ reason: "user" }),
      secondFacade.forcePoll({ reason: "user" }),
    ]);
    firstFacade.stop();
    await vi.advanceTimersByTimeAsync(1_000);

    expect(first.open).not.toHaveBeenCalled();
    expect(second.open).toHaveBeenCalledOnce();
    expect(first.cancelRefresh).toHaveBeenCalledOnce();
    expect(second.cancelRefresh).not.toHaveBeenCalled();
    expect(first.refresh).toHaveBeenCalledOnce();
    expect(second.refresh).toHaveBeenCalledOnce();
    secondFacade.stop();
  });
});
