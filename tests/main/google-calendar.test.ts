import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { isCalendarAutomationEligible } from "../../src/domain/entities/calendar-result.js";
import { createMockEvent, asTestMeetUrl, asTestIsoUtc } from "../helpers/test-utils.js";

const {
  ensureFreshGoogleAccessToken,
  refreshGoogleAccessToken,
  abortGoogleTokenRefreshLifecycle,
  isGoogleOAuthInFlight,
  runGooglePkceLogin,
  loadGoogleTokens,
  clearGoogleTokens,
  isGoogleOAuthConfigured,
  loadOfflineCache,
  saveOfflineCache,
  clearOfflineCache,
  loadGoogleSyncTokens,
  updateGoogleSyncToken,
  clearGoogleSyncToken,
  clearAllGoogleSyncTokens,
} = vi.hoisted(() => ({
  ensureFreshGoogleAccessToken: vi.fn(),
  refreshGoogleAccessToken: vi.fn(),
  abortGoogleTokenRefreshLifecycle: vi.fn(),
  isGoogleOAuthInFlight: vi.fn(),
  runGooglePkceLogin: vi.fn(),
  loadGoogleTokens: vi.fn(),
  clearGoogleTokens: vi.fn(),
  isGoogleOAuthConfigured: vi.fn(),
  loadOfflineCache: vi.fn(),
  saveOfflineCache: vi.fn(),
  clearOfflineCache: vi.fn(),
  loadGoogleSyncTokens: vi.fn(),
  updateGoogleSyncToken: vi.fn(),
  clearGoogleSyncToken: vi.fn(),
  clearAllGoogleSyncTokens: vi.fn(),
}));

vi.mock("../../src/main/calendar/auth/google-oauth.js", () => ({
  ensureFreshGoogleAccessToken,
  refreshGoogleAccessToken,
  abortGoogleTokenRefreshLifecycle,
  isGoogleOAuthInFlight,
  runGooglePkceLogin,
}));
vi.mock("../../src/main/calendar/auth/google-token-store.js", () => ({
  loadGoogleTokens,
  clearGoogleTokens,
}));
vi.mock("../../src/main/calendar/auth/google-client-id.js", () => ({
  isGoogleOAuthConfigured,
  getGoogleOAuthClientId: () => "test-client",
}));
vi.mock("../../src/main/calendar/offline-cache.js", () => ({
  loadOfflineCache,
  saveOfflineCache,
  clearOfflineCache,
}));
vi.mock("../../src/main/calendar/auth/google-sync-tokens.js", () => ({
  loadGoogleSyncTokens,
  updateGoogleSyncToken,
  clearGoogleSyncToken,
  clearAllGoogleSyncTokens,
}));

import { createGoogleCalendarProvider } from "../../src/main/calendar/providers/google-calendar.js";

const tokens = {
  authSchemaVersion: 1 as const,
  clientId: "test-client",
  accessToken: "access",
  refreshToken: "refresh",
  expiryMs: Date.now() + 3_600_000,
  email: "user@example.com",
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("createGoogleCalendarProvider", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-07-27T12:00:00.000Z"));
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    ensureFreshGoogleAccessToken.mockReset();
    refreshGoogleAccessToken.mockReset();
    isGoogleOAuthInFlight.mockReset().mockReturnValue(false);
    runGooglePkceLogin.mockReset();
    loadGoogleTokens.mockReset();
    clearGoogleTokens.mockReset().mockResolvedValue(undefined);
    isGoogleOAuthConfigured.mockReset().mockReturnValue(true);
    loadOfflineCache.mockReset().mockResolvedValue(null);
    saveOfflineCache.mockReset().mockResolvedValue(undefined);
    clearOfflineCache.mockReset().mockResolvedValue(undefined);
    loadGoogleSyncTokens.mockReset().mockResolvedValue({});
    updateGoogleSyncToken.mockReset().mockResolvedValue(true);
    abortGoogleTokenRefreshLifecycle.mockReset();
    clearGoogleSyncToken.mockReset().mockResolvedValue(undefined);
    clearAllGoogleSyncTokens.mockReset().mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("returns permission-denied when no tokens", async () => {
    ensureFreshGoogleAccessToken.mockResolvedValue(null);
    const provider = createGoogleCalendarProvider();
    const result = await provider.getEvents(new AbortController().signal);
    expect(result.kind).toBe("err");
    if (result.kind === "err") expect(result.code).toBe("permission-denied");
  });

  it("fetches calendars and events then caches", async () => {
    ensureFreshGoogleAccessToken.mockResolvedValue(tokens);
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes("calendarList")) {
        return jsonResponse({
          items: [
            { id: "primary", primary: true, summary: "Primary" },
            { id: "work", selected: true },
          ],
        });
      }
      if (url.includes("/events")) {
        return jsonResponse({
          items: [
            {
              id: "e1",
              summary: "Standup",
              status: "confirmed",
              hangoutLink: "https://meet.google.com/aaa-bbbb-ccc",
              start: { dateTime: "2026-07-27T15:00:00.000Z" },
              end: { dateTime: "2026-07-27T15:30:00.000Z" },
            },
            {
              id: "e2",
              status: "cancelled",
              start: { dateTime: "2026-07-27T16:00:00.000Z" },
              end: { dateTime: "2026-07-27T16:30:00.000Z" },
            },
            {
              id: "e3",
              summary: "All day",
              start: { date: "2026-07-28" },
              end: { date: "2026-07-29" },
            },
            {
              id: "e4",
              summary: "Declined",
              attendees: [{ self: true, responseStatus: "declined" }],
              start: { dateTime: "2026-07-27T17:00:00.000Z" },
              end: { dateTime: "2026-07-27T18:00:00.000Z" },
            },
            {
              id: "e5",
              summary: "Zoom from conf",
              conferenceData: {
                entryPoints: [{ uri: "https://zoom.us/j/12345678901" }],
              },
              start: { dateTime: "2026-07-27T19:00:00.000Z" },
              end: { dateTime: "2026-07-27T20:00:00.000Z" },
            },
          ],
        });
      }
      return jsonResponse({}, 404);
    });

    const provider = createGoogleCalendarProvider();
    const result = await provider.getEvents(new AbortController().signal);
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    // cancelled + declined filtered; all-day + meet + zoom kept
    expect(result.events.length).toBeGreaterThanOrEqual(3);
    expect(result.events.some((e) => e.title === "Standup")).toBe(true);
    expect(result.events.some((e) => e.isAllDay)).toBe(true);
    expect(result.events.some((e) => e.meetUrl?.includes("zoom.us"))).toBe(true);
    expect(saveOfflineCache).toHaveBeenCalled();
  });

  it.each([
    {
      name: "invalid timed start",
      start: { dateTime: "not-a-date" },
      end: { dateTime: "2026-03-02T16:30:00.000Z" },
    },
    {
      name: "invalid timed end",
      start: { dateTime: "2026-03-02T16:00:00.000Z" },
      end: { dateTime: "not-a-date" },
    },
    {
      name: "rolled-over timed start",
      start: { dateTime: "2026-02-30T15:00:00.000Z" },
      end: { dateTime: "2026-03-02T15:30:00.000Z" },
    },
    { name: "invalid all-day start", start: { date: "not-a-date" }, end: { date: "2026-03-03" } },
    { name: "invalid all-day end", start: { date: "2026-03-02" }, end: { date: "not-a-date" } },
    {
      name: "rolled-over all-day start",
      start: { date: "2026-02-30" },
      end: { date: "2026-03-03" },
    },
    { name: "rolled-over all-day end", start: { date: "2026-03-02" }, end: { date: "2026-02-31" } },
  ])("keeps the valid sibling and full cursor after a $name", async ({ start, end }) => {
    vi.setSystemTime(new Date("2026-03-02T12:00:00.000Z"));
    ensureFreshGoogleAccessToken.mockResolvedValue(tokens);
    fetchMock.mockImplementation(async (url: string) =>
      url.includes("calendarList")
        ? jsonResponse({ items: [{ id: "primary", primary: true }] })
        : jsonResponse({
            items: [
              { id: "broken", summary: "Broken", start, end },
              {
                id: "valid",
                summary: "Valid",
                start: { dateTime: "2026-03-02T15:00:00.000Z" },
                end: { dateTime: "2026-03-02T15:30:00.000Z" },
              },
            ],
            nextSyncToken: "full-after-broken",
          }),
    );

    const result = await createGoogleCalendarProvider().getEvents(new AbortController().signal);

    expect(result.kind).toBe("ok");
    if (result.kind !== "ok" || result.source !== "live") return;
    expect(result.completeness).toBe("complete");
    expect(result.events.map((event) => event.id)).toEqual(["primary:valid"]);
    expect(updateGoogleSyncToken).toHaveBeenCalledWith(
      "primary",
      "full-after-broken",
      expect.any(Function),
    );
  });

  it("projects date-only meetings by their local calendar dates across DST", async () => {
    const previousTimezone = process.env.TZ;
    process.env.TZ = "America/New_York";
    vi.setSystemTime(new Date("2026-03-08T12:00:00.000Z"));
    ensureFreshGoogleAccessToken.mockResolvedValue(tokens);
    fetchMock.mockImplementation(async (url: string) =>
      url.includes("calendarList")
        ? jsonResponse({ items: [{ id: "primary", primary: true }] })
        : jsonResponse({
            items: [
              {
                id: "today",
                summary: "Today",
                start: { date: "2026-03-08" },
                end: { date: "2026-03-09" },
              },
              {
                id: "tomorrow",
                summary: "Tomorrow",
                start: { date: "2026-03-09" },
                end: { date: "2026-03-10" },
              },
              {
                id: "later",
                summary: "Later",
                start: { date: "2026-03-10" },
                end: { date: "2026-03-11" },
              },
            ],
          }),
    );

    try {
      const result = await createGoogleCalendarProvider().getEvents(new AbortController().signal);
      expect(result.kind === "ok" ? result.events.map((event) => event.title) : []).toEqual([
        "Today",
        "Tomorrow",
      ]);
    } finally {
      if (previousTimezone === undefined) delete process.env.TZ;
      else process.env.TZ = previousTimezone;
    }
  });

  it("falls back to offline cache on network error", async () => {
    ensureFreshGoogleAccessToken.mockResolvedValue(tokens);
    fetchMock.mockRejectedValue(new Error("network down"));
    // listSelected will fail via fetch throw → outer catch network
    // Actually fetch rejection isn't handled as NetworkError in googleFetch - it will throw
    const cached = {
      version: 1 as const,
      observedAt: Date.now() - 1_000,
      cachedAt: Date.now(),
      events: [createMockEvent({ title: "Cached" })],
    };
    // First failure path: ensureFresh works, fetchAllEvents throws from fetch
    fetchMock.mockImplementation(async () => {
      throw new Error("ECONNRESET");
    });
    loadOfflineCache.mockResolvedValue(cached);

    const provider = createGoogleCalendarProvider();
    const result = await provider.getEvents(new AbortController().signal);
    // outer catch may return runtime or network via cache
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      expect(result.events[0]?.title).toBe("Cached");
    }
  });

  it("returns network error when no cache", async () => {
    ensureFreshGoogleAccessToken.mockResolvedValue(tokens);
    fetchMock.mockImplementation(async () => {
      throw new Error("offline");
    });
    loadOfflineCache.mockResolvedValue(null);

    const provider = createGoogleCalendarProvider();
    const result = await provider.getEvents(new AbortController().signal);
    expect(result.kind).toBe("err");
  });

  it("retries once on AuthError then succeeds with a different access token", async () => {
    ensureFreshGoogleAccessToken.mockResolvedValue(tokens);
    refreshGoogleAccessToken.mockResolvedValue({
      kind: "ok",
      tokens: { ...tokens, accessToken: "new-access" },
      didRefresh: true,
    });

    let call = 0;
    const tokensSeen: string[] = [];
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      const auth = (init?.headers as Record<string, string> | undefined)?.["Authorization"];
      if (typeof auth === "string") tokensSeen.push(auth);
      if (url.includes("calendarList")) {
        call++;
        if (call === 1) return new Response("unauthorized", { status: 401 });
        return jsonResponse({ items: [{ id: "primary", primary: true }] });
      }
      return jsonResponse({
        items: [
          {
            id: "ok",
            summary: "After retry",
            start: { dateTime: "2026-07-27T15:00:00.000Z" },
            end: { dateTime: "2026-07-27T16:00:00.000Z" },
          },
        ],
      });
    });

    const provider = createGoogleCalendarProvider();
    const result = await provider.getEvents(new AbortController().signal);
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      expect(result.events[0]?.title).toBe("After retry");
    }
    expect(refreshGoogleAccessToken).toHaveBeenCalledWith("force", expect.any(AbortSignal));
    expect(tokensSeen.some((h) => h.includes("new-access"))).toBe(true);
  });

  it("clears tokens when auth fails after forced refresh retry", async () => {
    ensureFreshGoogleAccessToken.mockResolvedValue(tokens);
    refreshGoogleAccessToken.mockResolvedValue({
      kind: "ok",
      tokens: { ...tokens, accessToken: "new-access" },
      didRefresh: true,
    });
    fetchMock.mockImplementation(async () => new Response("nope", { status: 401 }));

    const provider = createGoogleCalendarProvider();
    const result = await provider.getEvents(new AbortController().signal);
    expect(result.kind).toBe("err");
    if (result.kind === "err") {
      expect(result.code).toBe("permission-denied");
    }
    expect(refreshGoogleAccessToken).toHaveBeenCalledWith("force", expect.any(AbortSignal));
    expect(clearGoogleTokens).toHaveBeenCalled();
  });

  it("skips 403 calendars and defaults to primary when list empty", async () => {
    ensureFreshGoogleAccessToken.mockResolvedValue(tokens);
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes("calendarList")) {
        return jsonResponse({ items: [] });
      }
      if (url.includes("/events") && url.includes("primary")) {
        return new Response("forbidden", { status: 403 });
      }
      return jsonResponse({ items: [] });
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const provider = createGoogleCalendarProvider();
    const result = await provider.getEvents(new AbortController().signal);
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      expect(result.events).toEqual([]);
      expect(result.completeness).toBe("complete");
    }
    warn.mockRestore();
  });

  it.each([
    { name: "first page missing items", later: false, body: {} },
    { name: "first page with non-array items", later: false, body: { items: {} } },
    { name: "later page missing items", later: true, body: {} },
    { name: "later page with non-array items", later: true, body: { items: {} } },
  ])("treats malformed calendarList $name as partial without caching", async ({ later, body }) => {
    ensureFreshGoogleAccessToken.mockResolvedValue(tokens);
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes("calendarList")) {
        if (later && !url.includes("pageToken=")) {
          return jsonResponse({ items: [{ id: "primary", primary: true }], nextPageToken: "p2" });
        }
        return jsonResponse(body);
      }
      return jsonResponse({
        items: [
          {
            id: "meeting",
            summary: "Joinable",
            hangoutLink: "https://meet.google.com/aaa-bbbb-ccc",
            start: { dateTime: "2026-07-27T15:00:00.000Z" },
            end: { dateTime: "2026-07-27T15:30:00.000Z" },
          },
        ],
        nextSyncToken: "seed-token",
      });
    });

    const result = await createGoogleCalendarProvider().getEvents(new AbortController().signal);

    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.completeness).toBe("partial");
    expect(result.events.map((event) => event.title)).toEqual(["Joinable"]);
    expect(saveOfflineCache).not.toHaveBeenCalled();
  });

  it("permission helpers and disconnect", async () => {
    const provider = createGoogleCalendarProvider();
    isGoogleOAuthInFlight.mockReturnValue(true);
    expect(await provider.getPermissionStatus()).toBe("not-determined");
    isGoogleOAuthInFlight.mockReturnValue(false);
    isGoogleOAuthConfigured.mockReturnValue(false);
    expect(await provider.getPermissionStatus()).toBe("denied");
    isGoogleOAuthConfigured.mockReturnValue(true);
    loadGoogleTokens.mockResolvedValue(tokens);
    expect(await provider.getPermissionStatus()).toBe("granted");
    loadGoogleTokens.mockResolvedValue(null);
    expect(await provider.getPermissionStatus()).toBe("not-determined");

    isGoogleOAuthConfigured.mockReturnValue(false);
    expect(await provider.requestPermission()).toBe("denied");
    isGoogleOAuthConfigured.mockReturnValue(true);
    runGooglePkceLogin.mockResolvedValue("granted");
    expect(await provider.requestPermission()).toBe("granted");
    runGooglePkceLogin.mockResolvedValue("denied");
    expect(await provider.requestPermission()).toBe("denied");
    runGooglePkceLogin.mockResolvedValue("not-determined");
    expect(await provider.requestPermission()).toBe("not-determined");

    loadGoogleTokens.mockResolvedValue(tokens);
    expect(await provider.getAccountLabel?.()).toBe("user@example.com");
    expect(provider.isOAuthConfigured?.()).toBe(true);
    isGoogleOAuthInFlight.mockReturnValue(true);
    expect(provider.isOAuthInFlight?.()).toBe(true);

    await provider.disconnect?.();
    expect(clearGoogleTokens).toHaveBeenCalled();
    expect(clearOfflineCache).toHaveBeenCalled();
    expect(clearAllGoogleSyncTokens).toHaveBeenCalled();
    expect(abortGoogleTokenRefreshLifecycle).toHaveBeenCalled();

    ensureFreshGoogleAccessToken.mockResolvedValue(tokens);
    await provider.warmup?.();
    expect(ensureFreshGoogleAccessToken).toHaveBeenCalled();
  });

  it("maps event without summary and invalid JSON body", async () => {
    ensureFreshGoogleAccessToken.mockResolvedValue(tokens);
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes("calendarList")) {
        return jsonResponse({ items: [{ id: "primary", primary: true }] });
      }
      // 200 with non-JSON body → googleFetch ok:false → NetworkError → no offline cache
      return new Response("not-json", { status: 200 });
    });
    const provider = createGoogleCalendarProvider();
    loadOfflineCache.mockResolvedValue(null);
    const result = await provider.getEvents(new AbortController().signal);
    expect(result.kind).toBe("err");
    if (result.kind === "err") {
      expect(result.code).toBe("runtime");
      expect(result.error).toMatch(/events\.list failed|network|invalid/i);
    }
  });

  it("maps conference location description and empty calendar list to primary", async () => {
    ensureFreshGoogleAccessToken.mockResolvedValue(tokens);
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes("calendarList")) {
        return jsonResponse({ items: [{ id: "work", selected: false, primary: false }] });
      }
      return jsonResponse({
        items: [
          {
            id: "loc",
            summary: "Room",
            location: "https://meet.google.com/loc-meet-url",
            description: "See https://zoom.us/j/11111111111",
            start: { dateTime: "2026-07-27T10:00:00.000Z" },
            end: { dateTime: "2026-07-27T11:00:00.000Z" },
          },
          {
            // missing id
            summary: "Bad",
            start: { dateTime: "2026-07-27T10:00:00.000Z" },
            end: { dateTime: "2026-07-27T11:00:00.000Z" },
          },
          {
            id: "bad-time",
            start: { foo: 1 },
            end: { bar: 2 },
          },
          null,
          "skip",
        ],
        nextPageToken: "",
      });
    });
    const provider = createGoogleCalendarProvider();
    const result = await provider.getEvents(new AbortController().signal);
    expect(result.kind).toBe("ok");
  });

  it("paginates calendarList and events", async () => {
    ensureFreshGoogleAccessToken.mockResolvedValue(tokens);
    let listPages = 0;
    let eventPages = 0;
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes("calendarList")) {
        listPages++;
        if (listPages === 1) {
          return jsonResponse({
            items: [{ id: "c1", selected: true }],
            nextPageToken: "p2",
          });
        }
        return jsonResponse({ items: [{ id: "c2", primary: true }] });
      }
      eventPages++;
      if (eventPages === 1 && url.includes("c1")) {
        return jsonResponse({
          items: [
            {
              id: "e1",
              summary: "P1",
              start: { dateTime: "2026-07-27T10:00:00.000Z" },
              end: { dateTime: "2026-07-27T11:00:00.000Z" },
            },
          ],
          nextPageToken: "ep2",
        });
      }
      return jsonResponse({
        items: [
          {
            id: "e2",
            summary: "P2",
            start: { dateTime: "2026-07-27T12:00:00.000Z" },
            end: { dateTime: "2026-07-27T13:00:00.000Z" },
          },
        ],
      });
    });
    const provider = createGoogleCalendarProvider();
    const result = await provider.getEvents(new AbortController().signal);
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      expect(result.events.length).toBeGreaterThanOrEqual(2);
    }
  });

  it("auth retry fails when force refresh returns no-tokens without clearing again", async () => {
    ensureFreshGoogleAccessToken.mockResolvedValue(tokens);
    refreshGoogleAccessToken.mockResolvedValue({ kind: "no-tokens" });
    fetchMock.mockResolvedValue(new Response("nope", { status: 401 }));
    const provider = createGoogleCalendarProvider();
    const result = await provider.getEvents(new AbortController().signal);
    expect(result.kind).toBe("err");
    if (result.kind === "err") expect(result.code).toBe("permission-denied");
    // no-tokens path does not call clear again (nothing to clear / already gone)
    expect(clearGoogleTokens).not.toHaveBeenCalled();
  });

  it("transient force refresh preserves credentials and uses offline cache", async () => {
    ensureFreshGoogleAccessToken.mockResolvedValue(tokens);
    refreshGoogleAccessToken.mockResolvedValue({
      kind: "transient",
      reason: "timeout",
    });
    fetchMock.mockResolvedValue(new Response("nope", { status: 401 }));
    loadOfflineCache.mockResolvedValue({
      version: 1 as const,
      observedAt: Date.now() - 1_000,
      cachedAt: Date.now(),
      events: [
        createMockEvent({
          id: "cached",
          title: "Cached",
          meetUrl: asTestMeetUrl("https://meet.google.com/aaa-bbb-ccc"),
          startDate: asTestIsoUtc("2026-07-27T15:00:00.000Z"),
          endDate: asTestIsoUtc("2026-07-27T16:00:00.000Z"),
        }),
      ],
    });
    const provider = createGoogleCalendarProvider();
    const result = await provider.getEvents(new AbortController().signal);
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      expect(result.source).toBe("offline-cache");
    }
    expect(clearGoogleTokens).not.toHaveBeenCalled();
  });

  it("persists nextSyncToken after full window fetch", async () => {
    ensureFreshGoogleAccessToken.mockResolvedValue(tokens);
    const start = new Date();
    start.setHours(15, 0, 0, 0);
    const end = new Date(start.getTime() + 30 * 60_000);
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes("calendarList")) {
        return jsonResponse({ items: [{ id: "primary", primary: true }] });
      }
      if (url.includes("/events")) {
        return jsonResponse({
          items: [
            {
              id: "e1",
              summary: "Full",
              start: { dateTime: start.toISOString() },
              end: { dateTime: end.toISOString() },
            },
          ],
          nextSyncToken: "sync-token-1",
        });
      }
      return jsonResponse({}, 404);
    });

    const provider = createGoogleCalendarProvider();
    const result = await provider.getEvents(new AbortController().signal);
    expect(result.kind).toBe("ok");
    expect(updateGoogleSyncToken).toHaveBeenCalledWith(
      "primary",
      "sync-token-1",
      expect.any(Function),
    );
  });

  it("uses incremental syncToken on later poll and handles 410 full resync", async () => {
    ensureFreshGoogleAccessToken.mockResolvedValue(tokens);
    const start = new Date();
    start.setHours(14, 0, 0, 0);
    const end = new Date(start.getTime() + 30 * 60_000);
    const start2 = new Date(start.getTime() + 60 * 60_000);
    const end2 = new Date(start2.getTime() + 30 * 60_000);

    // In-memory token map for this provider instance sequence
    let stored: Record<string, string> = {};
    loadGoogleSyncTokens.mockImplementation(async () => ({ ...stored }));
    updateGoogleSyncToken.mockImplementation(async (id: string, token: string | null) => {
      if (token === null) delete stored[id];
      else stored[id] = token;
      return true;
    });
    clearGoogleSyncToken.mockImplementation(async (id: string) => {
      const next = { ...stored };
      delete next[id];
      stored = next;
    });

    let phase: "full" | "inc" | "gone" | "full2" = "full";
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes("calendarList")) {
        return jsonResponse({ items: [{ id: "primary", primary: true }] });
      }
      if (url.includes("/events")) {
        if (phase === "full") {
          phase = "inc";
          return jsonResponse({
            items: [
              {
                id: "e1",
                summary: "Original",
                start: { dateTime: start.toISOString() },
                end: { dateTime: end.toISOString() },
              },
            ],
            nextSyncToken: "tok-a",
          });
        }
        if (phase === "inc") {
          // Must request with syncToken
          expect(url).toContain("syncToken=");
          phase = "gone";
          return jsonResponse({
            items: [
              {
                id: "e2",
                summary: "Added",
                start: { dateTime: start2.toISOString() },
                end: { dateTime: end2.toISOString() },
              },
            ],
            nextSyncToken: "tok-b",
          });
        }
        if (phase === "gone") {
          expect(url).toContain("syncToken=");
          phase = "full2";
          return new Response("gone", { status: 410 });
        }
        // full resync after 410
        expect(url).not.toContain("syncToken=");
        return jsonResponse({
          items: [
            {
              id: "e3",
              summary: "AfterGone",
              start: { dateTime: start.toISOString() },
              end: { dateTime: end.toISOString() },
            },
          ],
          nextSyncToken: "tok-c",
        });
      }
      return jsonResponse({}, 404);
    });

    const provider = createGoogleCalendarProvider();
    const r1 = await provider.getEvents(new AbortController().signal);
    expect(r1.kind).toBe("ok");
    if (r1.kind === "ok") {
      expect(r1.events.some((e) => e.title === "Original")).toBe(true);
    }
    expect(stored["primary"]).toBe("tok-a");

    const r2 = await provider.getEvents(new AbortController().signal);
    expect(r2.kind).toBe("ok");
    if (r2.kind === "ok") {
      expect(r2.events.some((e) => e.title === "Original")).toBe(true);
      expect(r2.events.some((e) => e.title === "Added")).toBe(true);
    }
    expect(stored["primary"]).toBe("tok-b");

    const r3 = await provider.getEvents(new AbortController().signal);
    expect(r3.kind).toBe("ok");
    if (r3.kind === "ok") {
      expect(r3.events.some((e) => e.title === "AfterGone")).toBe(true);
      // index cleared on 410 — original/added not retained unless returned
      expect(r3.events.some((e) => e.title === "Added")).toBe(false);
    }
    expect(updateGoogleSyncToken).toHaveBeenCalledWith("primary", null, expect.any(Function));
    expect(stored["primary"]).toBe("tok-c");
  });

  it("removes declined and unmappable delta updates after a completed cursor", async () => {
    ensureFreshGoogleAccessToken.mockResolvedValue(tokens);
    let stored: Record<string, string> = {};
    loadGoogleSyncTokens.mockImplementation(async () => ({ ...stored }));
    updateGoogleSyncToken.mockImplementation(async (calendarId: string, token: string | null) => {
      if (token === null) delete stored[calendarId];
      else stored[calendarId] = token;
      return true;
    });
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes("calendarList")) {
        return jsonResponse({ items: [{ id: "primary", primary: true }] });
      }
      if (url.includes("syncToken=seed-token")) {
        return jsonResponse({
          items: [
            { id: "declined", attendees: [{ self: true, responseStatus: "declined" }] },
            { id: "unmappable", summary: "No dates" },
          ],
          nextSyncToken: "next-token",
        });
      }
      return jsonResponse({
        items: ["declined", "unmappable", "sibling"].map((id) => ({
          id,
          summary: id,
          hangoutLink: "https://meet.google.com/aaa-bbbb-ccc",
          start: { dateTime: "2026-07-27T15:00:00.000Z" },
          end: { dateTime: "2026-07-27T15:30:00.000Z" },
        })),
        nextSyncToken: "seed-token",
      });
    });
    const provider = createGoogleCalendarProvider();
    const initial = await provider.getEvents(new AbortController().signal);
    expect(initial.kind === "ok" ? initial.events.map((event) => event.title) : []).toEqual([
      "declined",
      "unmappable",
      "sibling",
    ]);

    const result = await provider.getEvents(new AbortController().signal);

    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.events.map((event) => event.title)).toEqual(["sibling"]);
    expect(result.completeness).toBe("complete");
    expect(stored["primary"]).toBe("next-token");
  });

  it.each([
    {
      name: "invalid timed update",
      start: { dateTime: "not-a-date" },
      end: { dateTime: "2026-03-02T15:30:00.000Z" },
    },
    {
      name: "rolled-over all-day update",
      start: { date: "2026-02-30" },
      end: { date: "2026-03-03" },
    },
  ])("deletes a $name without losing its incremental sibling or cursor", async ({ start, end }) => {
    vi.setSystemTime(new Date("2026-03-02T12:00:00.000Z"));
    ensureFreshGoogleAccessToken.mockResolvedValue(tokens);
    let stored: Record<string, string> = {};
    loadGoogleSyncTokens.mockImplementation(async () => ({ ...stored }));
    updateGoogleSyncToken.mockImplementation(async (calendarId: string, token: string | null) => {
      if (token === null) delete stored[calendarId];
      else stored[calendarId] = token;
      return true;
    });
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes("calendarList")) {
        return jsonResponse({ items: [{ id: "primary", primary: true }] });
      }
      if (url.includes("syncToken=seed-token")) {
        return jsonResponse({
          items: [
            { id: "replace", summary: "Broken update", start, end },
            {
              id: "added",
              summary: "Added sibling",
              start: { dateTime: "2026-03-02T16:00:00.000Z" },
              end: { dateTime: "2026-03-02T16:30:00.000Z" },
            },
          ],
          nextSyncToken: "next-token",
        });
      }
      return jsonResponse({
        items: ["replace", "keep"].map((id) => ({
          id,
          summary: id,
          start: { dateTime: "2026-03-02T15:00:00.000Z" },
          end: { dateTime: "2026-03-02T15:30:00.000Z" },
        })),
        nextSyncToken: "seed-token",
      });
    });

    const provider = createGoogleCalendarProvider();
    const seed = await provider.getEvents(new AbortController().signal);
    expect(seed.kind === "ok" ? seed.events.map((event) => event.title) : []).toEqual([
      "replace",
      "keep",
    ]);
    expect(stored["primary"]).toBe("seed-token");

    const result = await provider.getEvents(new AbortController().signal);

    expect(result.kind).toBe("ok");
    if (result.kind !== "ok" || result.source !== "live") return;
    expect(result.completeness).toBe("complete");
    expect(result.events.map((event) => event.title)).toEqual(["keep", "Added sibling"]);
    expect(stored["primary"]).toBe("next-token");
  });

  it("incremental sync applies cancelled deletions and falls back on non-410 transport errors", async () => {
    ensureFreshGoogleAccessToken.mockResolvedValue(tokens);
    const start = new Date();
    start.setHours(11, 0, 0, 0);
    const end = new Date(start.getTime() + 30 * 60_000);

    let stored: Record<string, string> = {};
    loadGoogleSyncTokens.mockImplementation(async () => ({ ...stored }));
    updateGoogleSyncToken.mockImplementation(async (id: string, token: string | null) => {
      if (token === null) delete stored[id];
      else stored[id] = token;
      return true;
    });

    let phase: "full" | "inc-cancel" | "inc-fail" | "full-fallback" = "full";
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes("calendarList")) {
        return jsonResponse({ items: [{ id: "primary", primary: true }] });
      }
      if (url.includes("/events")) {
        if (phase === "full") {
          phase = "inc-cancel";
          return jsonResponse({
            items: [
              {
                id: "keep",
                summary: "Keep",
                start: { dateTime: start.toISOString() },
                end: { dateTime: end.toISOString() },
              },
              {
                id: "drop",
                summary: "Drop",
                start: { dateTime: start.toISOString() },
                end: { dateTime: end.toISOString() },
              },
            ],
            nextSyncToken: "s1",
          });
        }
        if (phase === "inc-cancel") {
          phase = "inc-fail";
          return jsonResponse({
            items: [{ id: "drop", status: "cancelled" }],
            nextSyncToken: "s2",
          });
        }
        if (phase === "inc-fail") {
          phase = "full-fallback";
          return new Response("nope", { status: 500 });
        }
        // full window fallback after incremental transport failure
        return jsonResponse({
          items: [
            {
              id: "keep",
              summary: "Keep",
              start: { dateTime: start.toISOString() },
              end: { dateTime: end.toISOString() },
            },
          ],
          nextSyncToken: "s3",
        });
      }
      return jsonResponse({}, 404);
    });

    const provider = createGoogleCalendarProvider();
    const r1 = await provider.getEvents(new AbortController().signal);
    expect(r1.kind).toBe("ok");
    if (r1.kind === "ok") {
      expect(r1.events.map((e) => e.title).sort()).toEqual(["Drop", "Keep"]);
    }

    const r2 = await provider.getEvents(new AbortController().signal);
    expect(r2.kind).toBe("ok");
    if (r2.kind === "ok") {
      expect(r2.events.some((e) => e.title === "Drop")).toBe(false);
      expect(r2.events.some((e) => e.title === "Keep")).toBe(true);
    }

    const r3 = await provider.getEvents(new AbortController().signal);
    expect(r3.kind).toBe("ok");
    if (r3.kind === "ok") {
      expect(r3.events.some((e) => e.title === "Keep")).toBe(true);
    }
    expect(stored["primary"]).toBe("s3");
  });

  it("calendarList non-auth failure surfaces as error when no offline cache", async () => {
    ensureFreshGoogleAccessToken.mockResolvedValue(tokens);
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes("calendarList")) {
        return new Response("nope", { status: 503 });
      }
      return jsonResponse({}, 404);
    });
    loadOfflineCache.mockResolvedValue(null);
    const provider = createGoogleCalendarProvider();
    const result = await provider.getEvents(new AbortController().signal);
    expect(result.kind).toBe("err");
  });

  it("skips unselected calendars and defaults to primary when none selected", async () => {
    ensureFreshGoogleAccessToken.mockResolvedValue(tokens);
    const start = new Date();
    start.setHours(12, 0, 0, 0);
    const end = new Date(start.getTime() + 30 * 60_000);
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes("calendarList")) {
        return jsonResponse({
          items: [
            { id: "ignored", selected: false },
            { id: "not-an-id" }, // missing id
            "bad-item",
          ],
        });
      }
      if (url.includes("/calendars/primary/events") || url.includes("/calendars/primary%2F")) {
        return jsonResponse({
          items: [
            {
              id: "e1",
              summary: "Primary only",
              start: { dateTime: start.toISOString() },
              end: { dateTime: end.toISOString() },
            },
          ],
          nextSyncToken: "p1",
        });
      }
      // encodeURIComponent("primary") path
      if (url.includes("/events")) {
        return jsonResponse({
          items: [
            {
              id: "e1",
              summary: "Primary only",
              start: { dateTime: start.toISOString() },
              end: { dateTime: end.toISOString() },
            },
          ],
          nextSyncToken: "p1",
        });
      }
      return jsonResponse({}, 404);
    });
    const provider = createGoogleCalendarProvider();
    const result = await provider.getEvents(new AbortController().signal);
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      expect(result.events.some((e) => e.title === "Primary only")).toBe(true);
    }
  });

  it("incremental pageToken repeats the original syncToken param", async () => {
    ensureFreshGoogleAccessToken.mockResolvedValue(tokens);
    const start = new Date();
    start.setHours(13, 0, 0, 0);
    const end = new Date(start.getTime() + 30 * 60_000);
    let stored: Record<string, string> = {};
    loadGoogleSyncTokens.mockImplementation(async () => ({ ...stored }));
    updateGoogleSyncToken.mockImplementation(async (id: string, token: string | null) => {
      if (token === null) delete stored[id];
      else stored[id] = token;
      return true;
    });
    clearAllGoogleSyncTokens.mockImplementation(async () => {
      stored = {};
    });

    // Seed index via full then incremental with pagination
    let phase: "full" | "inc1" | "inc2" = "full";
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes("calendarList")) {
        return jsonResponse({ items: [{ id: "primary", primary: true }] });
      }
      if (url.includes("/events")) {
        if (phase === "full") {
          phase = "inc1";
          return jsonResponse({
            items: [
              {
                id: "a",
                summary: "A",
                start: { dateTime: start.toISOString() },
                end: { dateTime: end.toISOString() },
              },
            ],
            nextSyncToken: "sync-start",
          });
        }
        if (phase === "inc1") {
          phase = "inc2";
          expect(url).toContain("syncToken=");
          return jsonResponse({
            items: [
              {
                id: "b",
                summary: "B",
                start: { dateTime: start.toISOString() },
                end: { dateTime: end.toISOString() },
              },
            ],
            nextPageToken: "page-2",
          });
        }
        expect(url).toContain("pageToken=");
        expect(new URL(url).searchParams.get("syncToken")).toBe("sync-start");
        return jsonResponse({
          items: [
            {
              id: "c",
              summary: "C",
              start: { dateTime: start.toISOString() },
              end: { dateTime: end.toISOString() },
            },
          ],
          nextSyncToken: "sync-end",
        });
      }
      return jsonResponse({}, 404);
    });

    const provider = createGoogleCalendarProvider();
    // Clear process-local index left by prior tests in this file
    await provider.disconnect?.();
    clearGoogleTokens.mockClear();
    clearOfflineCache.mockClear();

    await provider.getEvents(new AbortController().signal); // full seed
    const r2 = await provider.getEvents(new AbortController().signal);
    expect(r2.kind).toBe("ok");
    if (r2.kind === "ok") {
      expect(r2.events.map((e) => e.title).sort()).toEqual(["A", "B", "C"]);
    }
    expect(stored["primary"]).toBe("sync-end");
  });

  it("incremental AuthError (401) propagates as permission-denied", async () => {
    ensureFreshGoogleAccessToken.mockResolvedValue(tokens);
    refreshGoogleAccessToken.mockResolvedValue({ kind: "no-tokens" });
    const start = new Date();
    start.setHours(10, 0, 0, 0);
    const end = new Date(start.getTime() + 30 * 60_000);
    let stored: Record<string, string> = {};
    loadGoogleSyncTokens.mockImplementation(async () => ({ ...stored }));
    updateGoogleSyncToken.mockImplementation(async (id: string, token: string | null) => {
      if (token === null) delete stored[id];
      else stored[id] = token;
      return true;
    });
    let phase: "full" | "inc" = "full";
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes("calendarList")) {
        return jsonResponse({ items: [{ id: "primary", primary: true }] });
      }
      if (url.includes("/events")) {
        if (phase === "full") {
          phase = "inc";
          return jsonResponse({
            items: [
              {
                id: "e1",
                summary: "X",
                start: { dateTime: start.toISOString() },
                end: { dateTime: end.toISOString() },
              },
            ],
            nextSyncToken: "t1",
          });
        }
        return new Response("auth", { status: 401 });
      }
      return jsonResponse({}, 404);
    });
    const provider = createGoogleCalendarProvider();
    await provider.getEvents(new AbortController().signal);
    const r2 = await provider.getEvents(new AbortController().signal);
    expect(r2.kind).toBe("err");
    if (r2.kind === "err") expect(r2.code).toBe("permission-denied");
  });

  it("incremental 429 does not full-window retry and preserves token/index/cache", async () => {
    ensureFreshGoogleAccessToken.mockResolvedValue(tokens);
    const start = new Date();
    start.setHours(12, 0, 0, 0);
    const end = new Date(start.getTime() + 30 * 60_000);
    let stored: Record<string, string> = {};
    loadGoogleSyncTokens.mockImplementation(async () => ({ ...stored }));
    updateGoogleSyncToken.mockImplementation(async (id: string, token: string | null) => {
      if (token === null) delete stored[id];
      else stored[id] = token;
      return true;
    });

    const offlineEvents = [
      createMockEvent({
        id: "cached",
        title: "Cached",
        startDate: asTestIsoUtc(start.toISOString()),
        endDate: asTestIsoUtc(end.toISOString()),
      }),
    ];
    loadOfflineCache.mockResolvedValue({
      version: 1 as const,
      observedAt: Date.now() - 1_000,
      cachedAt: Date.now(),
      events: offlineEvents,
    });

    let phase: "full" | "inc-429" = "full";
    let eventRequestCount = 0;
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes("calendarList")) {
        return jsonResponse({ items: [{ id: "primary", primary: true }] });
      }
      if (url.includes("/events")) {
        eventRequestCount++;
        if (phase === "full") {
          phase = "inc-429";
          return jsonResponse({
            items: [
              {
                id: "keep",
                summary: "Keep",
                start: { dateTime: start.toISOString() },
                end: { dateTime: end.toISOString() },
              },
            ],
            nextSyncToken: "tok-keep",
          });
        }
        // Incremental poll — rate limited. Must not be followed by a full-window request.
        expect(url).toContain("syncToken=");
        return new Response("rate limited", { status: 429 });
      }
      return jsonResponse({}, 404);
    });

    const provider = createGoogleCalendarProvider();
    await provider.disconnect?.();
    clearGoogleTokens.mockClear();
    clearOfflineCache.mockClear();
    stored = {};

    const r1 = await provider.getEvents(new AbortController().signal);
    expect(r1.kind).toBe("ok");
    if (r1.kind === "ok") {
      expect(r1.completeness).toBe("complete");
    }
    expect(stored["primary"]).toBe("tok-keep");
    const requestsAfterSeed = eventRequestCount;
    const tokenSnapshot = { ...stored };
    saveOfflineCache.mockClear();
    updateGoogleSyncToken.mockClear();
    refreshGoogleAccessToken.mockClear();

    const r2 = await provider.getEvents(new AbortController().signal);
    // Exactly one events request for the incremental 429 (no full fallback).
    expect(eventRequestCount).toBe(requestsAfterSeed + 1);
    expect(refreshGoogleAccessToken).not.toHaveBeenCalled();
    expect(clearGoogleTokens).not.toHaveBeenCalled();
    expect(stored).toEqual(tokenSnapshot);
    expect(updateGoogleSyncToken).not.toHaveBeenCalled();
    expect(saveOfflineCache).not.toHaveBeenCalled();
    // Zero complete calendars → offline display path.
    expect(r2.kind).toBe("ok");
    if (r2.kind === "ok") {
      expect(r2.source).toBe("offline-cache");
      expect(isCalendarAutomationEligible(r2)).toBe(false);
    }
  });

  it("multi-cal full pagination-limit yields live partial from complete siblings only", async () => {
    ensureFreshGoogleAccessToken.mockResolvedValue(tokens);
    const start = new Date();
    start.setHours(15, 0, 0, 0);
    const end = new Date(start.getTime() + 30 * 60_000);
    let fullPagesB = 0;
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes("calendarList")) {
        return jsonResponse({
          items: [
            { id: "a", selected: true },
            { id: "b", selected: true },
          ],
        });
      }
      if (
        url.includes("/calendars/a/") ||
        url.includes("/calendars/a%2F") ||
        url.includes("calendars/a/")
      ) {
        return jsonResponse({
          items: [
            {
              id: "ea",
              summary: "FromA",
              start: { dateTime: start.toISOString() },
              end: { dateTime: end.toISOString() },
            },
          ],
          nextSyncToken: "tok-a",
        });
      }
      if (url.includes("/events")) {
        // calendar b exhausts
        fullPagesB++;
        return jsonResponse({
          items: [
            {
              id: `eb-${fullPagesB}`,
              summary: `PartialB${fullPagesB}`,
              start: { dateTime: start.toISOString() },
              end: { dateTime: end.toISOString() },
            },
          ],
          nextPageToken: `b-page-${fullPagesB + 1}`,
        });
      }
      return jsonResponse({}, 404);
    });

    const provider = createGoogleCalendarProvider();
    await provider.disconnect?.();
    clearGoogleTokens.mockClear();
    clearOfflineCache.mockClear();
    saveOfflineCache.mockClear();
    updateGoogleSyncToken.mockClear();

    const result = await provider.getEvents(new AbortController().signal);
    expect(fullPagesB).toBe(100);
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      expect(result.source).toBe("live");
      expect(result.completeness).toBe("partial");
      expect(result.events.some((e) => e.title === "FromA")).toBe(true);
      expect(result.events.some((e) => e.title.startsWith("PartialB"))).toBe(false);
      expect(isCalendarAutomationEligible(result)).toBe(false);
    }
    expect(saveOfflineCache).not.toHaveBeenCalled();
    expect(updateGoogleSyncToken).toHaveBeenCalledWith("a", "tok-a", expect.any(Function));
  });

  it("calendarList pagination exhaustion yields live partial and skips aggregate cache write", async () => {
    ensureFreshGoogleAccessToken.mockResolvedValue(tokens);
    const start = new Date();
    start.setHours(15, 0, 0, 0);
    const end = new Date(start.getTime() + 30 * 60_000);
    let listPages = 0;
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes("calendarList")) {
        listPages++;
        // 50 pages each advertising another page — last response still has nextPageToken.
        return jsonResponse({
          items: listPages === 1 ? [{ id: "c1", selected: true }] : [],
          nextPageToken: `list-page-${listPages + 1}`,
        });
      }
      if (url.includes("/events")) {
        return jsonResponse({
          items: [
            {
              id: "e1",
              summary: "KnownCal",
              start: { dateTime: start.toISOString() },
              end: { dateTime: end.toISOString() },
            },
          ],
          nextSyncToken: "sync-c1",
        });
      }
      return jsonResponse({}, 404);
    });

    const provider = createGoogleCalendarProvider();
    await provider.disconnect?.();
    clearGoogleTokens.mockClear();
    clearOfflineCache.mockClear();
    saveOfflineCache.mockClear();
    updateGoogleSyncToken.mockClear();

    const result = await provider.getEvents(new AbortController().signal);
    expect(listPages).toBe(50);
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      expect(result.source).toBe("live");
      expect(result.completeness).toBe("partial");
      expect(result.events.some((e) => e.title === "KnownCal")).toBe(true);
      expect(isCalendarAutomationEligible(result)).toBe(false);
    }
    // Incomplete calendar-list must not authorize aggregate offline cache.
    expect(saveOfflineCache).not.toHaveBeenCalled();
    // Complete known calendars may still commit their own sync token.
    expect(updateGoogleSyncToken).toHaveBeenCalledWith("c1", "sync-c1", expect.any(Function));
  });

  it("uses a complete bounded fetch after 50 unbounded pages without adopting its cursor", async () => {
    ensureFreshGoogleAccessToken.mockResolvedValue(tokens);
    const start = new Date();
    start.setHours(15, 0, 0, 0);
    const end = new Date(start.getTime() + 30 * 60_000);
    let unboundedPages = 0;
    let boundedPages = 0;
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes("calendarList")) {
        return jsonResponse({ items: [{ id: "primary", primary: true }] });
      }
      const params = new URL(url).searchParams;
      expect(params.has("syncToken")).toBe(false);
      if (params.has("timeMin")) {
        boundedPages++;
        expect(params.has("timeMax")).toBe(true);
        expect(params.get("orderBy")).toBe("startTime");
        return jsonResponse({
          items: [
            {
              id: "bounded",
              summary: "Bounded",
              start: { dateTime: start.toISOString() },
              end: { dateTime: end.toISOString() },
            },
          ],
          nextSyncToken: "bounded-token-must-not-persist",
        });
      }
      expect(params.has("orderBy")).toBe(false);
      unboundedPages++;
      return jsonResponse({ items: [], nextPageToken: `page-${unboundedPages + 1}` });
    });

    const provider = createGoogleCalendarProvider();
    const first = await provider.getEvents(new AbortController().signal);
    const second = await provider.getEvents(new AbortController().signal);

    for (const result of [first, second]) {
      expect(result.kind).toBe("ok");
      if (result.kind === "ok") {
        expect(result.source).toBe("live");
        expect(result.events.map((event) => event.title)).toEqual(["Bounded"]);
      }
    }
    expect(unboundedPages).toBe(100);
    expect(boundedPages).toBe(2);
    expect(updateGoogleSyncToken).toHaveBeenCalledTimes(2);
    expect(updateGoogleSyncToken).toHaveBeenCalledWith("primary", null, expect.any(Function));
    expect(saveOfflineCache).toHaveBeenCalledTimes(2);
  });

  it("discards an old cursor after a complete unbounded full with no terminal token", async () => {
    ensureFreshGoogleAccessToken.mockResolvedValue(tokens);
    let fullCalls = 0;
    let stored: Record<string, string> = {};
    loadGoogleSyncTokens.mockImplementation(async () => ({ ...stored }));
    updateGoogleSyncToken.mockImplementation(async (id: string, token: string | null) => {
      if (token === null) delete stored[id];
      else stored[id] = token;
      return true;
    });
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes("calendarList")) {
        return jsonResponse({ items: [{ id: "primary", primary: true }] });
      }
      expect(new URL(url).searchParams.has("syncToken")).toBe(false);
      fullCalls++;
      return jsonResponse({
        items: [],
        ...(fullCalls === 2 ? {} : { nextSyncToken: fullCalls === 1 ? "old" : "new" }),
      });
    });

    const provider = createGoogleCalendarProvider();
    const seed = await provider.getEvents(new AbortController().signal);
    expect(seed.kind).toBe("ok");
    expect(stored["primary"]).toBe("old");
    vi.setSystemTime(new Date("2026-07-28T12:00:00.000Z"));
    const noToken = await provider.getEvents(new AbortController().signal);
    const reseed = await provider.getEvents(new AbortController().signal);

    expect(noToken.kind).toBe("ok");
    expect(reseed.kind).toBe("ok");
    expect(fullCalls).toBe(3);
    expect(updateGoogleSyncToken).toHaveBeenNthCalledWith(2, "primary", null, expect.any(Function));
    expect(updateGoogleSyncToken).toHaveBeenNthCalledWith(
      3,
      "primary",
      "new",
      expect.any(Function),
    );
    expect(stored["primary"]).toBe("new");
    expect(saveOfflineCache).toHaveBeenCalledTimes(3);
  });

  it("full-event pagination exhaustion discards both incomplete batches and reseeds", async () => {
    ensureFreshGoogleAccessToken.mockResolvedValue(tokens);
    const start = new Date();
    start.setHours(14, 0, 0, 0);
    const end = new Date(start.getTime() + 30 * 60_000);
    let stored: Record<string, string> = {};
    loadGoogleSyncTokens.mockImplementation(async () => ({ ...stored }));
    updateGoogleSyncToken.mockImplementation(async (id: string, token: string | null) => {
      if (token === null) delete stored[id];
      else stored[id] = token;
      return true;
    });

    let phase: "seed" | "exhaust-full" | "reseed" = "seed";
    let fullExhaustPages = 0;
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes("calendarList")) {
        return jsonResponse({ items: [{ id: "primary", primary: true }] });
      }
      if (url.includes("/events")) {
        if (phase === "seed") {
          phase = "exhaust-full";
          return jsonResponse({
            items: [
              {
                id: "seeded",
                summary: "Seeded",
                start: { dateTime: start.toISOString() },
                end: { dateTime: end.toISOString() },
              },
            ],
            nextSyncToken: "tok-seed",
          });
        }
        if (phase === "exhaust-full") {
          expect(url).not.toContain("syncToken=");
          fullExhaustPages++;
          return jsonResponse({
            items: [
              {
                id: `partial-${fullExhaustPages}`,
                summary: `Partial${fullExhaustPages}`,
                start: { dateTime: start.toISOString() },
                end: { dateTime: end.toISOString() },
              },
            ],
            nextPageToken: `full-page-${fullExhaustPages + 1}`,
            // Incomplete chain must not authorize this nextSyncToken.
            nextSyncToken: "tok-should-not-commit",
          });
        }
        expect(url).not.toContain("syncToken=");
        return jsonResponse({
          items: [
            {
              id: "seeded",
              summary: "Reseeded",
              start: { dateTime: start.toISOString() },
              end: { dateTime: end.toISOString() },
            },
          ],
          nextSyncToken: "tok-reseed",
        });
      }
      return jsonResponse({}, 404);
    });

    const provider = createGoogleCalendarProvider();
    await provider.disconnect?.();
    clearGoogleTokens.mockClear();
    clearOfflineCache.mockClear();
    stored = {};

    const r1 = await provider.getEvents(new AbortController().signal);
    expect(r1.kind).toBe("ok");
    if (r1.kind === "ok") {
      expect(r1.completeness).toBe("complete");
      expect(r1.events.some((e) => e.title === "Seeded")).toBe(true);
    }
    expect(stored["primary"]).toBe("tok-seed");

    // Clear sync token so next poll takes full-window path while process index remains.
    stored = {};
    saveOfflineCache.mockClear();
    updateGoogleSyncToken.mockClear();

    const r2 = await provider.getEvents(new AbortController().signal);
    expect(fullExhaustPages).toBe(100);
    // Single calendar incomplete → no complete success → error/offline path (no offline here).
    expect(r2.kind).toBe("err");
    // Prior token not replaced with incomplete-chain token; still empty after our clear.
    expect(stored["primary"]).toBeUndefined();
    expect(updateGoogleSyncToken).not.toHaveBeenCalled();
    expect(saveOfflineCache).not.toHaveBeenCalled();

    phase = "reseed";
    const r3 = await provider.getEvents(new AbortController().signal);
    expect(r3.kind).toBe("ok");
    if (r3.kind === "ok") {
      expect(r3.events.some((e) => e.title === "Reseeded")).toBe(true);
      expect(r3.events.some((e) => e.title.startsWith("Partial"))).toBe(false);
    }
    expect(stored["primary"]).toBe("tok-reseed");
  });

  it("incremental pagination exhaustion applies no upserts and preserves token/index", async () => {
    ensureFreshGoogleAccessToken.mockResolvedValue(tokens);
    const start = new Date();
    start.setHours(13, 0, 0, 0);
    const end = new Date(start.getTime() + 30 * 60_000);
    let stored: Record<string, string> = {};
    loadGoogleSyncTokens.mockImplementation(async () => ({ ...stored }));
    updateGoogleSyncToken.mockImplementation(async (id: string, token: string | null) => {
      if (token === null) delete stored[id];
      else stored[id] = token;
      return true;
    });

    let phase: "seed" | "inc-exhaust" = "seed";
    let incPages = 0;
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes("calendarList")) {
        return jsonResponse({ items: [{ id: "primary", primary: true }] });
      }
      if (url.includes("/events")) {
        if (phase === "seed") {
          phase = "inc-exhaust";
          return jsonResponse({
            items: [
              {
                id: "keep",
                summary: "Keep",
                start: { dateTime: start.toISOString() },
                end: { dateTime: end.toISOString() },
              },
            ],
            nextSyncToken: "tok-keep",
          });
        }
        incPages++;
        expect(new URL(url).searchParams.get("syncToken")).toBe("tok-keep");
        return jsonResponse({
          items: [
            {
              id: `new-${incPages}`,
              summary: `New${incPages}`,
              start: { dateTime: start.toISOString() },
              end: { dateTime: end.toISOString() },
            },
          ],
          nextPageToken: `inc-page-${incPages + 1}`,
          nextSyncToken: "tok-must-not-commit",
        });
      }
      return jsonResponse({}, 404);
    });

    const provider = createGoogleCalendarProvider();
    await provider.disconnect?.();
    clearGoogleTokens.mockClear();
    clearOfflineCache.mockClear();
    stored = {};

    const r1 = await provider.getEvents(new AbortController().signal);
    expect(r1.kind).toBe("ok");
    if (r1.kind === "ok") {
      expect(r1.completeness).toBe("complete");
      expect(r1.events.map((e) => e.title)).toEqual(["Keep"]);
    }
    expect(stored["primary"]).toBe("tok-keep");

    saveOfflineCache.mockClear();
    updateGoogleSyncToken.mockClear();
    const tokenSnapshot = { ...stored };

    const r2 = await provider.getEvents(new AbortController().signal);
    expect(incPages).toBe(50);
    // Incomplete incremental calendar → not live complete; no offline fixture → error.
    expect(r2.kind).toBe("err");
    expect(stored).toEqual(tokenSnapshot);
    expect(updateGoogleSyncToken).not.toHaveBeenCalled();
    expect(saveOfflineCache).not.toHaveBeenCalled();
    if (r2.kind === "err") {
      expect(isCalendarAutomationEligible(r2)).toBe(false);
    }

    // Process index must still be the seed (no incomplete upserts applied).
    // Re-seed path: empty incremental complete proves Keep remains.
    phase = "seed"; // not used; force complete empty incremental by re-mock
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes("calendarList")) {
        return jsonResponse({ items: [{ id: "primary", primary: true }] });
      }
      if (url.includes("/events")) {
        expect(url).toContain("syncToken=");
        return jsonResponse({ items: [], nextSyncToken: "tok-keep" });
      }
      return jsonResponse({}, 404);
    });
    const r3 = await provider.getEvents(new AbortController().signal);
    expect(r3.kind).toBe("ok");
    if (r3.kind === "ok") {
      expect(r3.events.map((e) => e.title)).toEqual(["Keep"]);
      expect(r3.events.some((e) => e.title.startsWith("New"))).toBe(false);
    }
  });
});
