import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deferred, meeting, response, serialized } from "./google-sync-fixtures.js";

const mocks = vi.hoisted(() => ({
  ensureFreshGoogleAccessToken: vi.fn(),
  refreshGoogleAccessToken: vi.fn(),
  abortGoogleTokenRefreshLifecycle: vi.fn(),
  loadGoogleSyncTokens: vi.fn(),
  saveGoogleSyncTokens: vi.fn(),
  updateGoogleSyncToken: vi.fn(),
  clearGoogleSyncToken: vi.fn(),
  clearAllGoogleSyncTokens: vi.fn(),
  clearGoogleTokens: vi.fn(),
  loadOfflineCache: vi.fn(),
  saveOfflineCache: vi.fn(),
  clearOfflineCache: vi.fn(),
}));

vi.mock("../../src/main/calendar/auth/google-oauth.js", () => ({
  ensureFreshGoogleAccessToken: mocks.ensureFreshGoogleAccessToken,
  refreshGoogleAccessToken: mocks.refreshGoogleAccessToken,
  abortGoogleTokenRefreshLifecycle: mocks.abortGoogleTokenRefreshLifecycle,
}));
vi.mock("../../src/main/calendar/auth/google-token-store.js", () => ({
  clearGoogleTokens: mocks.clearGoogleTokens,
}));
vi.mock("../../src/main/calendar/auth/google-sync-tokens.js", () => ({
  loadGoogleSyncTokens: mocks.loadGoogleSyncTokens,
  saveGoogleSyncTokens: mocks.saveGoogleSyncTokens,
  updateGoogleSyncToken: mocks.updateGoogleSyncToken,
  clearGoogleSyncToken: mocks.clearGoogleSyncToken,
  clearAllGoogleSyncTokens: mocks.clearAllGoogleSyncTokens,
}));
vi.mock("../../src/main/calendar/offline-cache.js", () => ({
  loadOfflineCache: mocks.loadOfflineCache,
  saveOfflineCache: mocks.saveOfflineCache,
  clearOfflineCache: mocks.clearOfflineCache,
}));

import { createGoogleCalendarProvider } from "../../src/main/calendar/providers/google-calendar.js";

const provider = createGoogleCalendarProvider();
let stored: Record<string, string>;
let cachedTitles: string[];
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-03-08T12:00:00.000Z"));
  vi.resetAllMocks();
  mocks.clearGoogleTokens.mockResolvedValue(undefined);
  mocks.clearAllGoogleSyncTokens.mockImplementation(async () => {
    stored = {};
  });
  mocks.clearOfflineCache.mockImplementation(async () => {
    cachedTitles = [];
  });
  await provider.disconnect?.();
  stored = {};
  cachedTitles = [];
  const serializeTokens = serialized();
  const serializeCache = serialized();
  mocks.loadGoogleSyncTokens.mockImplementation(() => serializeTokens(async () => ({ ...stored })));
  mocks.saveGoogleSyncTokens.mockImplementation((tokens: Record<string, string>) =>
    serializeTokens(async () => {
      stored = { ...tokens };
    }),
  );
  mocks.updateGoogleSyncToken.mockImplementation(
    (id: string, token: string | null, isCurrent?: () => boolean) =>
      serializeTokens(async () => {
        if (isCurrent?.() === false) return false;
        if (token === null) delete stored[id];
        else stored[id] = token;
        return true;
      }),
  );
  mocks.clearGoogleSyncToken.mockImplementation((id: string) =>
    serializeTokens(async () => {
      delete stored[id];
    }),
  );
  mocks.ensureFreshGoogleAccessToken.mockResolvedValue({ accessToken: "access" });
  mocks.loadOfflineCache.mockResolvedValue(null);
  mocks.saveOfflineCache.mockImplementation(
    (events: { title: string }[], _observedAt: number, isCurrent?: () => boolean) =>
      serializeCache(async () => {
        if (isCurrent?.() === false) return;
        cachedTitles = events.map((event) => event.title);
      }),
  );
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("Google sync lifecycle cancellation", () => {
  it("does not commit an old HTTP response after cancellation and a newer refresh", async () => {
    // Given an old request held at the transport boundary.
    const entered = deferred<void>();
    const release = deferred<Response>();
    let eventCalls = 0;
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes("calendarList"))
        return response({ items: [{ id: "primary", primary: true }] });
      eventCalls++;
      if (eventCalls === 1) {
        entered.resolve(undefined);
        return release.promise;
      }
      return response({ items: [meeting("new", "New")], nextSyncToken: "new-token" });
    });
    const controller = new AbortController();
    const old = provider.getEvents(controller.signal);
    await entered.promise;

    // When the old generation is cancelled and its replacement completes first.
    controller.abort();
    const newest = await provider.getEvents(new AbortController().signal);
    release.resolve(response({ items: [meeting("old", "Old")], nextSyncToken: "old-token" }));
    await old;

    // Then the old response cannot replace any new published data.
    expect(newest.kind === "ok" ? newest.events.map((event) => event.title) : []).toEqual(["New"]);
    expect(stored["primary"]).toBe("new-token");
    expect(cachedTitles).toEqual(["New"]);
    const observed = await provider.getEvents(new AbortController().signal);
    expect(observed.kind === "ok" ? observed.events.map((event) => event.title) : []).toEqual([
      "New",
    ]);
  });

  it("does not commit an old pending token save after a newer refresh", async () => {
    // Given a full response whose token persistence is paused before writing.
    const entered = deferred<void>();
    const release = deferred<void>();
    let eventCalls = 0;
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes("calendarList"))
        return response({ items: [{ id: "primary", primary: true }] });
      eventCalls++;
      return eventCalls === 1
        ? response({ items: [meeting("old", "Old")], nextSyncToken: "old-token" })
        : response({
            items: [
              ...(new URL(url).searchParams.has("syncToken")
                ? [{ id: "old", status: "cancelled" }]
                : []),
              meeting("new", "New"),
            ],
            nextSyncToken: "new-token",
          });
    });
    const serializeTokens = serialized();
    let saves = 0;
    const committed: string[] = [];
    const write = (id: string, token: string | null, isCurrent?: () => boolean) =>
      serializeTokens(async () => {
        saves++;
        if (saves === 1) {
          entered.resolve(undefined);
          await release.promise;
        }
        if (isCurrent?.() === false) return false;
        if (token === null) delete stored[id];
        else {
          stored[id] = token;
          committed.push(token);
        }
        return true;
      });
    mocks.loadGoogleSyncTokens.mockImplementation(() =>
      serializeTokens(async () => ({ ...stored })),
    );
    mocks.updateGoogleSyncToken.mockImplementation(write);
    mocks.saveGoogleSyncTokens.mockImplementation((tokens: Record<string, string>) =>
      write("primary", tokens["primary"] ?? null),
    );
    const controller = new AbortController();
    const old = provider.getEvents(controller.signal);
    await entered.promise;

    // When the old poll is aborted while storage awaits, start its replacement.
    controller.abort();
    const newestPromise = provider.getEvents(new AbortController().signal);
    release.resolve(undefined);
    const [, newest] = await Promise.all([old, newestPromise]);

    // Then the resumed stale save does not roll token or cache back.
    expect(newest.kind === "ok" ? newest.events.map((event) => event.title) : []).toEqual(["New"]);
    expect(stored["primary"]).toBe("new-token");
    expect(cachedTitles).toEqual(["New"]);
    expect(committed).toEqual(["new-token"]);
  });

  it("does not write an old cache snapshot after cancellation and a newer refresh", async () => {
    // Given an old poll held at cache persistence after its network response.
    const entered = deferred<void>();
    const release = deferred<void>();
    let eventCalls = 0;
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes("calendarList"))
        return response({ items: [{ id: "primary", primary: true }] });
      eventCalls++;
      return eventCalls === 1
        ? response({ items: [meeting("old", "Old")] })
        : response({ items: [meeting("new", "New")] });
    });
    const serializeCache = serialized();
    let saves = 0;
    const committed: string[][] = [];
    mocks.saveOfflineCache.mockImplementation(
      (events: { title: string }[], _observedAt: number, isCurrent?: () => boolean) =>
        serializeCache(async () => {
          saves++;
          if (saves === 1) {
            entered.resolve(undefined);
            await release.promise;
          }
          if (isCurrent?.() === false) return;
          cachedTitles = events.map((event) => event.title);
          committed.push(cachedTitles);
        }),
    );
    const controller = new AbortController();
    const old = provider.getEvents(controller.signal);
    await entered.promise;

    // When it is cancelled, queue its replacement before releasing the old write.
    controller.abort();
    const newestPromise = provider.getEvents(new AbortController().signal);
    release.resolve(undefined);
    const [, newest] = await Promise.all([old, newestPromise]);

    // Then the durable cache remains the new complete snapshot.
    expect(newest.kind === "ok" ? newest.events.map((event) => event.title) : []).toEqual(["New"]);
    expect(cachedTitles).toEqual(["New"]);
    expect(committed).toEqual([["New"]]);
  });

  it("does not resurrect token, index or cache after disconnect during HTTP", async () => {
    // Given a deferred event response from a poll already in progress.
    const entered = deferred<void>();
    const release = deferred<Response>();
    let eventCalls = 0;
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes("calendarList"))
        return response({ items: [{ id: "primary", primary: true }] });
      eventCalls++;
      if (eventCalls === 1) {
        entered.resolve(undefined);
        return release.promise;
      }
      return response({ items: [], nextSyncToken: "fresh-token" });
    });
    const pending = provider.getEvents(new AbortController().signal);
    await entered.promise;

    // When the account disconnects before that HTTP response resolves.
    await provider.disconnect?.();
    release.resolve(response({ items: [meeting("old", "Old")], nextSyncToken: "old-token" }));
    await pending;

    // Then disconnected data must stay cleared and cannot reappear in a later session.
    expect(stored).toEqual({});
    expect(cachedTitles).toEqual([]);
    const refreshed = await provider.getEvents(new AbortController().signal);
    expect(refreshed.kind === "ok" ? refreshed.events : []).toEqual([]);
  });
});
