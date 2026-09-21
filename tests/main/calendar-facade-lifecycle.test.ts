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

function liveResult(title: string): CalendarResultOkLive {
  return {
    kind: "ok",
    source: "live",
    completeness: "complete",
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

function createProvider(result: CalendarResult): CalendarProvider {
  return {
    id: "google-calendar",
    getEvents: vi.fn().mockResolvedValue(result),
    getPermissionStatus: vi.fn().mockResolvedValue("granted"),
    requestPermission: vi.fn().mockResolvedValue("granted"),
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

async function settleAsyncWork(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

describe("calendar facade lifecycle", () => {
  it("shares one pending provider resolution across concurrent cold calls", async () => {
    const deferred = createDeferred<CalendarProvider>();
    const provider = {
      ...createProvider(liveResult("shared")),
      warmup: vi.fn().mockResolvedValue(undefined),
    } satisfies CalendarProvider;
    const resolveProvider = vi.fn(() => deferred.promise);
    const facade = createCalendarFacade({ resolveProvider });

    const warmup = facade.warmupCalendarProvider();
    const permissionStatus = facade.getCalendarPermissionStatus();
    await vi.waitFor(() => expect(resolveProvider).toHaveBeenCalledOnce());
    deferred.resolve(provider);

    await expect(Promise.all([warmup, permissionStatus])).resolves.toEqual([undefined, "granted"]);
    expect(resolveProvider).toHaveBeenCalledOnce();
    expect(provider.warmup).toHaveBeenCalledOnce();
    expect(provider.getPermissionStatus).toHaveBeenCalledOnce();
  });

  it("does not publish when an AbortSignal-ignoring provider resolves after active refresh cancellation", async () => {
    const deferred = createDeferred<CalendarResult>();
    const provider = createProvider(liveResult("unused"));
    provider.getEvents = vi.fn(() => deferred.promise);
    const published: CalendarUiState[] = [];
    const facade = createCalendarFacade({
      resolveProvider: async () => provider,
      publisher: { publishCalendarStatus: (state) => published.push(state) },
    });

    const refresh = facade.refreshCalendarPublication();
    await vi.waitFor(() => expect(provider.getEvents).toHaveBeenCalledOnce());
    facade.cancelActiveCalendarRefresh();

    await expect(refresh).rejects.toBeInstanceOf(CalendarRefreshCancelledError);
    deferred.resolve(liveResult("stale"));
    await settleAsyncWork();

    expect(published).toEqual([]);
    expect(facade.getCalendarUiState().events).toBeNull();
    expect(facade.getLastPublication()).toBeNull();
  });

  it("keeps disconnected UI after an in-flight refresh resolves stale data", async () => {
    const deferred = createDeferred<CalendarResult>();
    const disconnect = vi.fn().mockResolvedValue(undefined);
    const provider = {
      ...createProvider(liveResult("unused")),
      getEvents: vi.fn(() => deferred.promise),
      disconnect,
    } satisfies CalendarProvider;
    const published: CalendarUiState[] = [];
    const facade = createCalendarFacade({
      resolveProvider: async () => provider,
      resetProvider: vi.fn(),
      publisher: { publishCalendarStatus: (state) => published.push(state) },
    });

    const refresh = facade.refreshCalendarPublication();
    await vi.waitFor(() => expect(provider.getEvents).toHaveBeenCalledOnce());
    await facade.disconnectCalendar();
    deferred.resolve(liveResult("stale"));
    await expect(refresh).rejects.toBeInstanceOf(CalendarRefreshCancelledError);
    await settleAsyncWork();

    expect(disconnect).toHaveBeenCalledOnce();
    expect(published.map((state) => state.phase)).toEqual(["disconnected"]);
    expect(facade.getCalendarUiState()).toMatchObject({
      phase: "disconnected",
      events: null,
    });
    expect(facade.getLastPublication()).toBeNull();
  });

  it("rejects a delayed provider resolution invalidated by disconnect without caching or using it", async () => {
    const oldResolution = createDeferred<CalendarProvider>();
    const oldWarmup = vi.fn().mockResolvedValue(undefined);
    const oldProvider = {
      ...createProvider(liveResult("old")),
      warmup: oldWarmup,
    } satisfies CalendarProvider;
    const disconnectProvider = {
      ...createProvider(liveResult("disconnect")),
      disconnect: vi.fn().mockResolvedValue(undefined),
    } satisfies CalendarProvider;
    const freshProvider = createProvider(liveResult("fresh"));
    vi.mocked(freshProvider.getPermissionStatus).mockResolvedValue("denied");
    const resolveProvider = vi
      .fn<() => Promise<CalendarProvider>>()
      .mockImplementationOnce(() => oldResolution.promise)
      .mockResolvedValueOnce(disconnectProvider)
      .mockResolvedValueOnce(freshProvider);
    const facade = createCalendarFacade({ resolveProvider, resetProvider: vi.fn() });

    const warmup = facade.warmupCalendarProvider();
    await vi.waitFor(() => expect(resolveProvider).toHaveBeenCalledTimes(1));
    await facade.disconnectCalendar();
    oldResolution.resolve(oldProvider);

    await expect(warmup).rejects.toMatchObject({
      name: "CalendarProviderLifecycleInvalidatedError",
    });
    expect(oldWarmup).not.toHaveBeenCalled();
    expect(await (await facade.getCalendarPort()).getPermissionStatus()).toBe("denied");
    expect(freshProvider.getPermissionStatus).toHaveBeenCalledOnce();
    expect(oldProvider.getPermissionStatus).not.toHaveBeenCalled();
  });

  it("keeps disconnected UI when requestPermission resolves after disconnect", async () => {
    const requestPermission = createDeferred<"granted">();
    const provider = {
      ...createProvider(liveResult("request")),
      requestPermission: vi.fn(() => requestPermission.promise),
      disconnect: vi.fn().mockResolvedValue(undefined),
    } satisfies CalendarProvider;
    const published: CalendarUiState[] = [];
    const facade = createCalendarFacade({
      resolveProvider: async () => provider,
      resetProvider: vi.fn(),
      publisher: { publishCalendarStatus: (state) => published.push(state) },
    });

    const request = facade.requestCalendarPermission();
    await vi.waitFor(() => expect(provider.requestPermission).toHaveBeenCalledOnce());
    await facade.disconnectCalendar();
    requestPermission.resolve("granted");

    await expect(request).rejects.toMatchObject({
      name: "CalendarProviderLifecycleInvalidatedError",
    });
    expect(published.map((state) => state.phase)).toEqual(["connecting", "disconnected"]);
    expect(facade.getCalendarUiState()).toMatchObject({
      phase: "disconnected",
      permission: "not-determined",
    });
  });

  it("keeps disconnected UI when getPermissionStatus resolves after disconnect", async () => {
    const permissionStatus = createDeferred<"granted">();
    const provider = {
      ...createProvider(liveResult("status")),
      getPermissionStatus: vi.fn(() => permissionStatus.promise),
      disconnect: vi.fn().mockResolvedValue(undefined),
    } satisfies CalendarProvider;
    const published: CalendarUiState[] = [];
    const facade = createCalendarFacade({
      resolveProvider: async () => provider,
      resetProvider: vi.fn(),
      publisher: { publishCalendarStatus: (state) => published.push(state) },
    });

    const status = facade.getCalendarPermissionStatus();
    await vi.waitFor(() => expect(provider.getPermissionStatus).toHaveBeenCalledOnce());
    await facade.disconnectCalendar();
    permissionStatus.resolve("granted");

    await expect(status).rejects.toMatchObject({
      name: "CalendarProviderLifecycleInvalidatedError",
    });
    expect(published.map((state) => state.phase)).toEqual(["disconnected"]);
    expect(facade.getCalendarUiState()).toMatchObject({
      phase: "disconnected",
      permission: "not-determined",
    });
  });

  it("does not cache an account label continuation that resolves after disconnect", async () => {
    const accountLabel = createDeferred<string | null>();
    const getAccountLabel = vi
      .fn<() => Promise<string | null>>()
      .mockImplementationOnce(() => accountLabel.promise)
      .mockResolvedValueOnce(null);
    const provider = {
      ...createProvider(liveResult("account")),
      getPermissionStatus: vi.fn().mockResolvedValue("denied"),
      getAccountLabel,
      disconnect: vi.fn().mockResolvedValue(undefined),
    } satisfies CalendarProvider;
    const facade = createCalendarFacade({
      resolveProvider: async () => provider,
      resetProvider: vi.fn(),
    });

    const request = facade.requestCalendarPermission();
    await vi.waitFor(() => expect(provider.getAccountLabel).toHaveBeenCalledOnce());
    await facade.disconnectCalendar();
    accountLabel.resolve("stale@example.com");

    await expect(request).rejects.toMatchObject({
      name: "CalendarProviderLifecycleInvalidatedError",
    });
    await expect(facade.getCalendarPermissionStatus()).resolves.toBe("denied");
    expect(provider.getPermissionStatus).toHaveBeenCalledOnce();
    expect(facade.getCalendarUiState()).toMatchObject({
      phase: "disconnected",
      permission: "denied",
      accountEmail: null,
    });
  });

  it("invalidates permission work started while disconnect is pending", async () => {
    const disconnect = createDeferred<void>();
    const requestPermission = createDeferred<"granted">();
    const provider = {
      ...createProvider(liveResult("during-disconnect")),
      requestPermission: vi.fn(() => requestPermission.promise),
      disconnect: vi.fn(() => disconnect.promise),
    } satisfies CalendarProvider;
    const facade = createCalendarFacade({
      resolveProvider: async () => provider,
      resetProvider: vi.fn(),
    });

    const disconnecting = facade.disconnectCalendar();
    await vi.waitFor(() => expect(provider.disconnect).toHaveBeenCalledOnce());
    const request = facade.requestCalendarPermission();
    await vi.waitFor(() => expect(provider.requestPermission).toHaveBeenCalledOnce());
    disconnect.resolve();
    await disconnecting;
    requestPermission.resolve("granted");

    await expect(request).rejects.toMatchObject({
      name: "CalendarProviderLifecycleInvalidatedError",
    });
    expect(facade.getCalendarUiState()).toMatchObject({
      phase: "disconnected",
      permission: "not-determined",
    });
  });

  it("keeps facade B refreshing when facade A disconnects and cancels its own refresh", async () => {
    const deferredA = createDeferred<CalendarResult>();
    const deferredB = createDeferred<CalendarResult>();
    const providerA = {
      ...createProvider(liveResult("unused-A")),
      getEvents: vi.fn(() => deferredA.promise),
      disconnect: vi.fn().mockResolvedValue(undefined),
    } satisfies CalendarProvider;
    const providerB = createProvider(liveResult("unused-B"));
    providerB.getEvents = vi.fn(() => deferredB.promise);
    const facadeA = createCalendarFacade({
      resolveProvider: async () => providerA,
      resetProvider: vi.fn(),
    });
    const facadeB = createCalendarFacade({ resolveProvider: async () => providerB });

    const refreshA = facadeA.refreshCalendarPublication();
    const refreshB = facadeB.refreshCalendarPublication();
    await vi.waitFor(() => {
      expect(providerA.getEvents).toHaveBeenCalledOnce();
      expect(providerB.getEvents).toHaveBeenCalledOnce();
    });
    await facadeA.disconnectCalendar();
    deferredB.resolve(liveResult("B"));
    deferredA.resolve(liveResult("stale-A"));

    await expect(refreshA).rejects.toBeInstanceOf(CalendarRefreshCancelledError);
    await expect(refreshB).resolves.toMatchObject({
      publicationGeneration: 1,
      result: { kind: "ok", events: [expect.objectContaining({ title: "B" })] },
    });
    await settleAsyncWork();

    expect(facadeA.getCalendarUiState().phase).toBe("disconnected");
    expect(facadeB.getCalendarUiState().phase).toBe("ready");
  });

  it("clears stale cache age when reporting a poll error after an offline snapshot", async () => {
    const cachedAt = Date.now() - 60_000;
    const events = liveResult("cached").events;
    const provider = createProvider({
      kind: "ok",
      source: "offline-cache",
      observedAt: cachedAt - 1_000,
      cachedAt,
      events,
    });
    const facade = createCalendarFacade({ resolveProvider: async () => provider });

    await facade.refreshCalendarPublication();
    expect(facade.getCalendarUiState().cacheAgeMs).toBeGreaterThanOrEqual(60_000);

    facade.reportCalendarPollError("poll failed", events);

    expect(facade.getCalendarUiState()).toMatchObject({
      phase: "offline-cached",
      cacheAgeMs: null,
      darwinPartialRefreshDiagnostics: null,
    });
  });
});
