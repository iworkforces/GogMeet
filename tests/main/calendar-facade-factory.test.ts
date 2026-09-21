import { describe, expect, it, vi } from "vitest";
import type {
  CalendarResult,
  CalendarResultOkLive,
} from "../../src/domain/entities/calendar-result.js";
import type { CalendarUiState } from "../../src/domain/entities/calendar-ui-state.js";
import type { CalendarProvider } from "../../src/main/calendar/provider.js";
import { CalendarRefreshCancelledError } from "../../src/main/calendar/refresh-coordinator.js";
import { createCalendarFacade } from "../../src/main/facades/calendar.js";
import { asTestEventId, asTestIsoUtc } from "../helpers/test-utils.js";

function liveResult(
  title: string,
  completeness: "complete" | "partial" = "complete",
): CalendarResultOkLive {
  return {
    kind: "ok",
    source: "live",
    completeness,
    observedAt: Date.now(),
    events: [
      {
        id: asTestEventId(title),
        title,
        startDate: asTestIsoUtc("2026-07-30T10:00:00.000Z"),
        endDate: asTestIsoUtc("2026-07-30T11:00:00.000Z"),
        calendarName: "Work",
        isAllDay: false,
      },
    ],
  };
}

function createProvider(permission: "granted" | "denied", result: CalendarResult): CalendarProvider {
  return {
    id: "google-calendar",
    getEvents: vi.fn().mockResolvedValue(result),
    getPermissionStatus: vi.fn().mockResolvedValue(permission),
    requestPermission: vi.fn().mockResolvedValue(permission),
    isOAuthConfigured: () => true,
  };
}

function createDeferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolve = (_value: T): void => {};
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe("calendar facade factory", () => {
  it("isolates permission caches between instances", async () => {
    const providerA = createProvider("granted", liveResult("A"));
    const providerB = createProvider("denied", liveResult("B"));
    const resolveProviderA = vi.fn(async () => providerA);
    const resolveProviderB = vi.fn(async () => providerB);
    const facadeA = createCalendarFacade({ resolveProvider: resolveProviderA });
    const facadeB = createCalendarFacade({ resolveProvider: resolveProviderB });

    expect(await facadeA.getCalendarPermissionStatus()).toBe("granted");
    expect(await facadeB.getCalendarPermissionStatus()).toBe("denied");
    expect(await facadeA.getCalendarPermissionStatus()).toBe("granted");
    expect(providerA.getPermissionStatus).toHaveBeenCalledTimes(1);
    expect(providerB.getPermissionStatus).toHaveBeenCalledTimes(1);
    expect(resolveProviderA).toHaveBeenCalledTimes(1);
    expect(resolveProviderB).toHaveBeenCalledTimes(1);

    facadeA.invalidateCalendarPermissionCache();
    expect(await facadeA.getCalendarPermissionStatus()).toBe("granted");
    expect(await facadeB.getCalendarPermissionStatus()).toBe("denied");
    expect(providerA.getPermissionStatus).toHaveBeenCalledTimes(2);
    expect(providerB.getPermissionStatus).toHaveBeenCalledTimes(1);
  });

  it("isolates UI publications, publication generations, and publishers", async () => {
    const publishedA: CalendarUiState[] = [];
    const publishedB: CalendarUiState[] = [];
    const facadeA = createCalendarFacade({
      resolveProvider: async () => createProvider("granted", liveResult("A", "partial")),
      publisher: { publishCalendarStatus: (state) => publishedA.push(state) },
    });
    const facadeB = createCalendarFacade({
      resolveProvider: async () => createProvider("granted", liveResult("B")),
      publisher: { publishCalendarStatus: (state) => publishedB.push(state) },
    });

    const [publicationA, publicationB] = await Promise.all([
      facadeA.refreshCalendarPublication(),
      facadeB.refreshCalendarPublication(),
    ]);

    expect(publicationA.publicationGeneration).toBe(1);
    expect(publicationB.publicationGeneration).toBe(1);
    expect(facadeA.getCalendarUiState()).toMatchObject({ phase: "limited" });
    expect(facadeB.getCalendarUiState()).toMatchObject({ phase: "ready" });
    expect(publishedA).toHaveLength(1);
    expect(publishedA[0]?.events?.[0]?.title).toBe("A");
    expect(publishedB).toHaveLength(1);
    expect(publishedB[0]?.events?.[0]?.title).toBe("B");
    expect(facadeA.getLastPublication()).toEqual(publicationA);
    expect(facadeB.getLastPublication()).toEqual(publicationB);
  });

  it("isolates cancellation, provider ports, and cached providers", async () => {
    const pendingA = createDeferred<CalendarResult>();
    const pendingB = createDeferred<CalendarResult>();
    const signalA: { current: AbortSignal | null } = { current: null };
    const signalB: { current: AbortSignal | null } = { current: null };
    const providerA = createProvider("granted", liveResult("unused-A"));
    const providerB = createProvider("granted", liveResult("unused-B"));
    providerA.getEvents = vi.fn((signal) => {
      signalA.current = signal;
      return pendingA.promise;
    });
    providerB.getEvents = vi.fn((signal) => {
      signalB.current = signal;
      return pendingB.promise;
    });
    const facadeA = createCalendarFacade({ resolveProvider: async () => providerA });
    const facadeB = createCalendarFacade({ resolveProvider: async () => providerB });

    const refreshA = facadeA.refreshCalendarPublication();
    const refreshB = facadeB.refreshCalendarPublication();
    await Promise.resolve();
    await Promise.resolve();
    facadeA.cancelActiveCalendarRefresh();

    expect(signalA.current?.aborted).toBe(true);
    expect(signalB.current?.aborted).toBe(false);
    await expect(refreshA).rejects.toBeInstanceOf(CalendarRefreshCancelledError);
    pendingB.resolve(liveResult("B"));
    await expect(refreshB).resolves.toMatchObject({ publicationGeneration: 1 });
    expect(await (await facadeA.getCalendarPort()).getPermissionStatus()).toBe("granted");
    expect(await (await facadeB.getCalendarPort()).getPermissionStatus()).toBe("granted");
    expect(providerA.getPermissionStatus).toHaveBeenCalledTimes(1);
    expect(providerB.getPermissionStatus).toHaveBeenCalledTimes(1);
  });

  it("keeps disconnect, warmup, auto-request, and poll errors instance-owned", async () => {
    const warmupA = vi.fn().mockResolvedValue(undefined);
    const disconnectA = vi.fn().mockResolvedValue(undefined);
    const resetA = vi.fn();
    const resetB = vi.fn();
    const publishedA: CalendarUiState[] = [];
    const publishedB: CalendarUiState[] = [];
    const providerA = {
      ...createProvider("granted", liveResult("A")),
      warmup: warmupA,
      disconnect: disconnectA,
    } satisfies CalendarProvider;
    const facadeA = createCalendarFacade({
      resolveProvider: async () => providerA,
      resetProvider: resetA,
      publisher: { publishCalendarStatus: (state) => publishedA.push(state) },
      isDarwin: () => true,
    });
    const facadeB = createCalendarFacade({
      resolveProvider: async () => createProvider("denied", liveResult("B")),
      resetProvider: resetB,
      publisher: { publishCalendarStatus: (state) => publishedB.push(state) },
      isDarwin: () => false,
    });

    await facadeA.warmupCalendarProvider();
    facadeA.reportCalendarPollError("offline", liveResult("retained").events);
    facadeB.reportCalendarPollError("network down", null);
    await facadeA.disconnectCalendar();

    expect(warmupA).toHaveBeenCalledTimes(1);
    expect(disconnectA).toHaveBeenCalledTimes(1);
    expect(resetA).toHaveBeenCalledTimes(1);
    expect(resetB).not.toHaveBeenCalled();
    expect(facadeA.getCalendarUiState()).toMatchObject({
      phase: "disconnected",
      permission: "not-determined",
    });
    expect(facadeB.getCalendarUiState()).toMatchObject({ phase: "error", lastError: "network down" });
    expect(facadeA.shouldAutoRequestCalendarPermission()).toBe(true);
    expect(facadeB.shouldAutoRequestCalendarPermission()).toBe(false);
    expect(publishedA).toHaveLength(2);
    expect(publishedB).toHaveLength(1);
  });
});
