import { describe, it, expect, vi } from "vitest";
import type { CalendarResult } from "../../src/domain/entities/calendar-result.js";
import {
  CalendarRefreshCancelledError,
  createCalendarRefreshCoordinator,
} from "../../src/main/calendar/refresh-coordinator.js";

function okResult(label: string, observedAt = Date.now()): CalendarResult {
  return {
    kind: "ok",
    source: "live",
    completeness: "complete",
    observedAt,
    events: [
      {
        id: label as never,
        title: label,
        startDate: "2026-07-30T10:00:00.000Z" as never,
        endDate: "2026-07-30T11:00:00.000Z" as never,
        calendarName: "Work",
        isAllDay: false,
        description: "",
      },
    ],
  };
}

function createDeferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (reason: unknown) => void;
} {
  let resolve = (_value: T): void => {};
  let reject = (_reason: unknown): void => {};
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("calendar refresh coordinator", () => {
  it("happy path: one request produces one provider call and one publication", async () => {
    const fetch = vi.fn().mockResolvedValue(okResult("solo"));
    const coordinator = createCalendarRefreshCoordinator(fetch);

    const publication = await coordinator.requestRefresh();

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(publication.publicationGeneration).toBe(1);
    expect(publication.result).toMatchObject({ kind: "ok" });
    expect(coordinator.getLastPublication()).toEqual(publication);
  });

  it("ten concurrent requests produce at most current plus one follow-up", async () => {
    const first = createDeferred<CalendarResult>();
    const second = createDeferred<CalendarResult>();
    let calls = 0;
    const coordinator = createCalendarRefreshCoordinator((_signal) => {
      calls += 1;
      if (calls === 1) return first.promise;
      if (calls === 2) return second.promise;
      return Promise.resolve(okResult(`extra-${calls}`));
    });

    const waiters = Array.from({ length: 10 }, () => coordinator.requestRefresh());
    await Promise.resolve();
    expect(calls).toBe(1);

    // While first is in flight, all waiters share the chain and only queue one follow-up.
    first.resolve(okResult("gen-1"));
    // Allow the follow-up to start before resolving it.
    await Promise.resolve();
    await Promise.resolve();
    expect(calls).toBe(2);
    second.resolve(okResult("gen-2"));

    const publications = await Promise.all(waiters);
    expect(calls).toBe(2);
    // All waiters resolve to the final (follow-up) publication.
    const gens = new Set(publications.map((p) => p.publicationGeneration));
    expect(gens.size).toBe(1);
    expect(publications[0]?.publicationGeneration).toBe(2);
    expect(coordinator.getLastPublication()?.publicationGeneration).toBe(2);
  });

  it("older completion does not mutate lastPublication after a newer follow-up", async () => {
    const first = createDeferred<CalendarResult>();
    const second = createDeferred<CalendarResult>();
    let calls = 0;
    const coordinator = createCalendarRefreshCoordinator(() => {
      calls += 1;
      return calls === 1 ? first.promise : second.promise;
    });

    const waiterA = coordinator.requestRefresh();
    // Queue follow-up before first completes.
    const waiterB = coordinator.requestRefresh();
    await Promise.resolve();

    // Complete first (superseded) then second.
    first.resolve(okResult("stale"));
    await Promise.resolve();
    await Promise.resolve();
    second.resolve(okResult("fresh"));

    const [a, b] = await Promise.all([waiterA, waiterB]);
    expect(a.publicationGeneration).toBe(b.publicationGeneration);
    expect(a.result).toMatchObject({ kind: "ok" });
    if (a.result.kind === "ok") {
      expect(a.result.events[0]?.title).toBe("fresh");
    }
    expect(coordinator.getLastPublication()?.publicationGeneration).toBe(2);
  });

  it("manual refresh cannot resolve without a publication", async () => {
    const coordinator = createCalendarRefreshCoordinator(async () =>
      okResult("must-publish"),
    );
    const publication = await coordinator.requestRefresh();
    expect(publication).toMatchObject({
      publicationGeneration: expect.any(Number),
      result: { kind: "ok" },
    });
  });

  it("cancel aborts provider work and rejects waiters with CalendarRefreshCancelledError", async () => {
    const deferred = createDeferred<CalendarResult>();
    const seenSignal: { current: AbortSignal | null } = { current: null };
    let calls = 0;
    const coordinator = createCalendarRefreshCoordinator((signal) => {
      calls += 1;
      seenSignal.current = signal;
      return calls === 1
        ? deferred.promise
        : Promise.resolve(okResult("after-cancel"));
    });

    const pending = coordinator.requestRefresh();
    await Promise.resolve();
    expect(seenSignal.current?.aborted).toBe(false);

    coordinator.cancel();
    expect(seenSignal.current?.aborted).toBe(true);

    await expect(pending).rejects.toBeInstanceOf(CalendarRefreshCancelledError);
    expect(coordinator.getLastPublication()).toBeNull();

    // New request after cancel starts clean under a new lifecycle.
    const next = await coordinator.requestRefresh();
    expect(next.publicationGeneration).toBe(2);
    expect(next.result).toMatchObject({ kind: "ok" });
  });

  it("isolates cancellation and publication generations between coordinators", async () => {
    const firstA = createDeferred<CalendarResult>();
    let callsA = 0;
    const signalA: { current: AbortSignal | null } = { current: null };
    const coordinatorA = createCalendarRefreshCoordinator((signal) => {
      callsA += 1;
      signalA.current = signal;
      return callsA === 1
        ? firstA.promise
        : Promise.resolve(okResult("a-after-cancel"));
    });
    let callsB = 0;
    const coordinatorB = createCalendarRefreshCoordinator(async () => {
      callsB += 1;
      return okResult(`b-${callsB}`);
    });

    const pendingA = coordinatorA.requestRefresh();
    await Promise.resolve();
    const firstB = await coordinatorB.requestRefresh();

    expect(firstB.publicationGeneration).toBe(1);
    expect(signalA.current?.aborted).toBe(false);

    coordinatorA.cancel();
    await expect(pendingA).rejects.toBeInstanceOf(CalendarRefreshCancelledError);

    expect(signalA.current?.aborted).toBe(true);
    expect(coordinatorA.getLastPublication()).toBeNull();
    expect(coordinatorB.getLastPublication()).toEqual(firstB);

    const [nextA, secondB] = await Promise.all([
      coordinatorA.requestRefresh(),
      coordinatorB.requestRefresh(),
    ]);

    expect(nextA.publicationGeneration).toBe(2);
    expect(secondB.publicationGeneration).toBe(2);
    expect(nextA.result).toMatchObject({
      kind: "ok",
      events: [expect.objectContaining({ title: "a-after-cancel" })],
    });
    expect(secondB.result).toMatchObject({
      kind: "ok",
      events: [expect.objectContaining({ title: "b-2" })],
    });
    expect(coordinatorA.getLastPublication()).toEqual(nextA);
    expect(coordinatorB.getLastPublication()).toEqual(secondB);
  });

  it("retries once when a follow-up is queued after a transient fetch failure", async () => {
    let calls = 0;
    let requestFollowUp!: () => Promise<unknown>;
    const coordinator = createCalendarRefreshCoordinator(async () => {
      calls += 1;
      if (calls === 1) {
        // Queue follow-up before failure surfaces.
        void requestFollowUp();
        throw new Error("transient");
      }
      return okResult("recovered");
    });
    requestFollowUp = coordinator.requestRefresh;

    const publication = await coordinator.requestRefresh();
    expect(calls).toBe(2);
    expect(publication.result).toMatchObject({ kind: "ok" });
    if (publication.result.kind === "ok") {
      expect(publication.result.events[0]?.title).toBe("recovered");
    }
  });

  it("rejects immediately when the signal is already aborted", async () => {
    const coordinator = createCalendarRefreshCoordinator(async (signal) => {
      // Simulate a hang that only ends on abort.
      await new Promise<void>((_resolve, reject) => {
        if (signal.aborted) {
          reject(new DOMException("Aborted", "AbortError"));
          return;
        }
        signal.addEventListener(
          "abort",
          () => reject(new DOMException("Aborted", "AbortError")),
          { once: true },
        );
      });
      return okResult("never");
    });

    const pending = coordinator.requestRefresh();
    await Promise.resolve();
    coordinator.cancel();
    await expect(pending).rejects.toBeInstanceOf(CalendarRefreshCancelledError);
  });

  it("propagates non-cancel fetch errors when no follow-up is queued", async () => {
    const coordinator = createCalendarRefreshCoordinator(async () => {
      throw new Error("hard-failure");
    });
    await expect(coordinator.requestRefresh()).rejects.toThrow(/hard-failure/);
  });
});
