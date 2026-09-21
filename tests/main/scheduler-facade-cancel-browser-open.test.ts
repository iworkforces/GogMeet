import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSchedulerFacade } from "../../src/main/scheduler/facade.js";
import type { EventId } from "../../src/domain/entities/brand.js";
import { schedulerTestContext } from "../helpers/scheduler-runtime.js";
import {
  asTestEventId,
  asTestIsoUtc,
  createMockEvent,
  createMockSettings,
  okCalendarResult,
} from "../helpers/test-utils.js";

function scheduledFacade(id: EventId) {
  const now = Date.now();
  const event = createMockEvent({
    id,
    startDate: asTestIsoUtc(new Date(now + 61_000).toISOString()),
    endDate: asTestIsoUtc(new Date(now + 120_000).toISOString()),
  });
  const context = schedulerTestContext(
    createMockSettings({ openBeforeMinutes: 1, windowAlert: false }),
    { publicationGeneration: 1, result: okCalendarResult([event]) },
  );
  return { context, facade: createSchedulerFacade(context.dependencies), event };
}

describe("SchedulerFacade.cancelPendingBrowserOpen", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("clears the pending browser timer for the given event id", async () => {
    const { context, facade, event } = scheduledFacade(asTestEventId("cancel-1"));
    await facade.forcePoll({ reason: "user" });

    facade.cancelPendingBrowserOpen(event.id);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(context.open).not.toHaveBeenCalled();
    facade.stop();
  });

  it("suppresses re-arming on later refresh polls", async () => {
    const { context, facade, event } = scheduledFacade(asTestEventId("cancel-2"));
    await facade.forcePoll({ reason: "user" });
    facade.cancelPendingBrowserOpen(event.id);

    await facade.forcePoll({ reason: "user" });
    await vi.advanceTimersByTimeAsync(1_000);

    expect(context.open).not.toHaveBeenCalled();
    facade.stop();
  });

  it("is idempotent", () => {
    const { facade, event } = scheduledFacade(asTestEventId("cancel-3"));
    facade.cancelPendingBrowserOpen(event.id);
    expect(() => facade.cancelPendingBrowserOpen(event.id)).not.toThrow();
    facade.stop();
  });

  it("is safe when no timer exists", () => {
    const context = schedulerTestContext();
    const facade = createSchedulerFacade(context.dependencies);
    expect(() => facade.cancelPendingBrowserOpen(asTestEventId("missing"))).not.toThrow();
    facade.stop();
  });
});
