import { describe, expect, it } from "vitest";
import type { CalendarResult } from "../../src/domain/entities/calendar-result.js";
import {
  CalendarRefreshCancelledError,
  createCalendarRefreshCoordinator,
} from "../../src/main/calendar/refresh-coordinator.js";
import { createMockEvent, okCalendarResult } from "../helpers/test-utils.js";

function result(title: string): CalendarResult {
  return okCalendarResult([createMockEvent({ title })]);
}

describe("calendar refresh late results", () => {
  it("rejects every cancelled waiter before an abort-ignoring fetcher completes", async () => {
    const oldFetch = Promise.withResolvers<CalendarResult>();
    const started = Promise.withResolvers<void>();
    const coordinator = createCalendarRefreshCoordinator(() => {
      started.resolve();
      return oldFetch.promise;
    });
    const first = coordinator.requestRefresh();
    await started.promise;
    const second = coordinator.requestRefresh();

    coordinator.cancel();

    await expect(first).rejects.toBeInstanceOf(CalendarRefreshCancelledError);
    await expect(second).rejects.toBeInstanceOf(CalendarRefreshCancelledError);
    expect(coordinator.getLastPublication()).toBeNull();
    oldFetch.resolve(result("ignored old result"));
  });

  it("keeps the new publication after a cancelled old fetch fulfills late", async () => {
    const oldFetch = Promise.withResolvers<CalendarResult>();
    const newFetch = Promise.withResolvers<CalendarResult>();
    const oldStarted = Promise.withResolvers<void>();
    const newStarted = Promise.withResolvers<void>();
    let calls = 0;
    const coordinator = createCalendarRefreshCoordinator(() => {
      calls += 1;
      if (calls === 1) {
        oldStarted.resolve();
        return oldFetch.promise;
      }
      newStarted.resolve();
      return newFetch.promise;
    });
    const cancelled = coordinator.requestRefresh();
    await oldStarted.promise;
    coordinator.cancel();
    await expect(cancelled).rejects.toBeInstanceOf(CalendarRefreshCancelledError);
    const current = coordinator.requestRefresh();
    await newStarted.promise;

    newFetch.resolve(result("new meeting"));
    const publication = await current;
    oldFetch.resolve(result("stale meeting"));
    await oldFetch.promise;

    expect(publication).toMatchObject({
      publicationGeneration: 2,
      result: { kind: "ok", events: [expect.objectContaining({ title: "new meeting" })] },
    });
    expect(coordinator.getLastPublication()).toEqual(publication);
    expect(calls).toBe(2);
  });
});
