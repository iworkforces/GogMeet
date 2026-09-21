import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CalendarPublication } from "../../src/domain/entities/calendar-publication.js";
import { createSchedulerFacade, type SchedulerFacade } from "../../src/main/scheduler/facade.js";
import {
  calendarPublication,
  schedulerTestContext,
  type SchedulerTestContext,
} from "../helpers/scheduler-runtime.js";

const FORCE_POLL_COALESCE_MS = 10_000;
const POLL_INTERVAL_MS = 2 * 60_000;

interface DeferredPublication {
  readonly promise: Promise<CalendarPublication>;
  readonly resolve: (publication: CalendarPublication) => void;
}

function deferredPublication(): DeferredPublication {
  let resolve = (_publication: CalendarPublication): void => {};
  const promise = new Promise<CalendarPublication>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

describe("SchedulerFacade force-poll coordination", () => {
  let context: SchedulerTestContext;
  let facade: SchedulerFacade;

  beforeEach(() => {
    vi.useFakeTimers();
    context = schedulerTestContext();
    facade = createSchedulerFacade(context.dependencies);
    facade.initPowerCallbacks({
      getPollInterval: () => POLL_INTERVAL_MS,
      preventSleep: vi.fn(),
      allowSleep: vi.fn(),
    });
  });

  afterEach(() => {
    facade.stop();
    vi.useRealTimers();
  });

  it("schedules one deferred poll inside the coalesce window", async () => {
    await facade.forcePoll();
    await facade.forcePoll();
    await facade.forcePoll({ reason: "watch" });
    await facade.forcePoll({ reason: "auto" });
    expect(context.refresh).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(FORCE_POLL_COALESCE_MS);

    expect(context.refresh).toHaveBeenCalledTimes(2);
  });

  it("lets user polls bypass coalescing", async () => {
    await facade.forcePoll({ reason: "auto" });
    await facade.forcePoll({ reason: "user" });
    expect(context.refresh).toHaveBeenCalledTimes(2);
  });

  it("cancels a deferred auto poll when a user poll runs", async () => {
    await facade.forcePoll({ reason: "auto" });
    await facade.forcePoll({ reason: "auto" });
    await facade.forcePoll({ reason: "user" });

    await vi.advanceTimersByTimeAsync(FORCE_POLL_COALESCE_MS * 2);

    expect(context.refresh).toHaveBeenCalledTimes(2);
  });

  it("cancels a deferred poll when stopped", async () => {
    await facade.forcePoll();
    await facade.forcePoll();
    facade.stop();

    await vi.advanceTimersByTimeAsync(FORCE_POLL_COALESCE_MS * 2);

    expect(context.refresh).toHaveBeenCalledOnce();
  });

  it("runs one follow-up for requests arriving during a deferred poll", async () => {
    await facade.forcePoll();
    const deferred = deferredPublication();
    context.refresh.mockReturnValueOnce(deferred.promise);
    await facade.forcePoll();
    await vi.advanceTimersByTimeAsync(FORCE_POLL_COALESCE_MS);
    expect(context.refresh).toHaveBeenCalledTimes(2);

    const requests = [facade.forcePoll(), facade.forcePoll(), facade.forcePoll()];
    deferred.resolve(calendarPublication(2));
    await Promise.all(requests);

    expect(context.refresh).toHaveBeenCalledTimes(3);
  });

  it("does not overlap an in-flight poll", async () => {
    const deferred = deferredPublication();
    context.refresh.mockReturnValueOnce(deferred.promise);
    const first = facade.forcePoll();
    await Promise.resolve();

    const second = facade.forcePoll();
    expect(context.refresh).toHaveBeenCalledOnce();
    deferred.resolve(calendarPublication());
    await Promise.all([first, second]);

    expect(context.refresh).toHaveBeenCalledTimes(2);
  });

  it("coalesces many overlapping requests into one follow-up", async () => {
    const deferred = deferredPublication();
    context.refresh.mockReturnValueOnce(deferred.promise);
    const first = facade.forcePoll();
    await Promise.resolve();

    const overlapping = Array.from({ length: 4 }, () => facade.forcePoll());
    deferred.resolve(calendarPublication());
    await Promise.all([first, ...overlapping]);

    expect(context.refresh).toHaveBeenCalledTimes(2);
  });

  it("clears the in-flight guard after a rejected refresh", async () => {
    context.refresh.mockRejectedValueOnce(new Error("boom"));
    await facade.forcePoll();
    await facade.forcePoll({ reason: "user" });
    expect(context.refresh).toHaveBeenCalledTimes(2);
  });

  it("waits for the startup poll to settle before arming cadence", async () => {
    const deferred = deferredPublication();
    context.refresh.mockReturnValueOnce(deferred.promise);
    facade.start();
    facade.start();
    await Promise.resolve();

    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    expect(context.refresh).toHaveBeenCalledOnce();
    deferred.resolve(calendarPublication());
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);

    expect(context.refresh).toHaveBeenCalledTimes(2);
  });

  it("queues a request arriving while the first follow-up is running", async () => {
    const firstDeferred = deferredPublication();
    const secondDeferred = deferredPublication();
    context.refresh
      .mockReturnValueOnce(firstDeferred.promise)
      .mockReturnValueOnce(secondDeferred.promise);
    const first = facade.forcePoll();
    await Promise.resolve();
    const second = facade.forcePoll();

    firstDeferred.resolve(calendarPublication(1));
    await Promise.resolve();
    await Promise.resolve();
    expect(context.refresh).toHaveBeenCalledTimes(2);

    vi.setSystemTime(Date.now() + FORCE_POLL_COALESCE_MS + 1);
    const third = facade.forcePoll();
    secondDeferred.resolve(calendarPublication(2));
    await Promise.all([first, second, third]);

    expect(context.refresh).toHaveBeenCalledTimes(3);
  });
});
