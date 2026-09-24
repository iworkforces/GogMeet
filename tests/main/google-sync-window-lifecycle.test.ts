import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { meeting, response } from "./google-sync-fixtures.js";

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
const signal = new AbortController().signal;
let stored: Record<string, string>;
let fetchMock: ReturnType<typeof vi.fn>;
let originalTimezone: string | undefined;

beforeEach(async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-03-08T04:59:00.000Z"));
  originalTimezone = process.env.TZ;
  process.env.TZ = "America/New_York";
  vi.resetAllMocks();
  mocks.clearGoogleTokens.mockResolvedValue(undefined);
  mocks.clearAllGoogleSyncTokens.mockImplementation(async () => {
    stored = {};
  });
  mocks.clearOfflineCache.mockResolvedValue(undefined);
  await provider.disconnect?.();
  stored = {};
  mocks.loadGoogleSyncTokens.mockImplementation(async () => ({ ...stored }));
  mocks.saveGoogleSyncTokens.mockImplementation(async (next: Record<string, string>) => {
    stored = { ...next };
  });
  mocks.updateGoogleSyncToken.mockImplementation(
    async (id: string, token: string | null, isCurrent?: () => boolean) => {
      if (isCurrent?.() === false) return false;
      if (token === null) delete stored[id];
      else stored[id] = token;
      return true;
    },
  );
  mocks.clearGoogleSyncToken.mockImplementation(async (id: string) => {
    delete stored[id];
  });
  mocks.ensureFreshGoogleAccessToken.mockResolvedValue({
    accessToken: "access",
    email: "user@example.com",
  });
  mocks.loadOfflineCache.mockResolvedValue(null);
  mocks.saveOfflineCache.mockResolvedValue(undefined);
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  if (originalTimezone === undefined) delete process.env.TZ;
  else process.env.TZ = originalTimezone;
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function requests(): URL[] {
  return fetchMock.mock.calls
    .map((call: unknown[]) => new URL(String(call[0])))
    .filter((url: URL) => url.pathname.endsWith("/events"));
}

describe("Google sync window", () => {
  it("seeds the new local-day window instead of advancing an old paired token", async () => {
    // Given a full unbounded snapshot whose terminal page issues a valid token.
    fetchMock.mockImplementation(async (url: string) =>
      url.includes("calendarList")
        ? response({ items: [{ id: "primary", primary: true }] })
        : response({
            items: [meeting("old", "Old", "2026-03-07T16:00:00.000Z")],
            nextSyncToken: "old-day",
          }),
    );
    const seed = await provider.getEvents(signal);
    expect(seed.kind === "ok" ? seed.events.map((event) => event.title) : []).toEqual(["Old"]);
    fetchMock.mockClear();
    fetchMock.mockImplementation(async (url: string) =>
      url.includes("calendarList")
        ? response({ items: [{ id: "primary", primary: true }] })
        : response({
            items: [
              meeting("old", "Old", "2026-03-07T16:00:00.000Z"),
              meeting("new", "New", "2026-03-09T16:00:00.000Z"),
            ],
            nextSyncToken: "new-day",
          }),
    );

    // When local midnight moves the two-day window across the DST boundary.
    vi.setSystemTime(new Date("2026-03-08T05:01:00.000Z"));
    const result = await provider.getEvents(signal);

    // Then a new unbounded seed is locally projected to the entered two-day window.
    const eventRequest = requests()[0];
    expect(eventRequest?.searchParams.has("timeMin")).toBe(false);
    expect(eventRequest?.searchParams.has("timeMax")).toBe(false);
    expect(eventRequest?.searchParams.has("orderBy")).toBe(false);
    expect(eventRequest?.searchParams.has("syncToken")).toBe(false);
    expect(result.kind === "ok" ? result.events.map((event) => event.title) : []).toEqual(["New"]);
    expect(stored["primary"]).toBe("new-day");
  });

  it("seeds again when timezone changes the bounds without changing the instant", async () => {
    // Given a full snapshot with a terminal cursor and an event in the eastern window.
    fetchMock.mockImplementation(async (url: string) =>
      url.includes("calendarList")
        ? response({ items: [{ id: "primary", primary: true }] })
        : response({
            items: [meeting("east", "East", "2026-03-07T06:00:00.000Z")],
            nextSyncToken: "east-token",
          }),
    );
    const seed = await provider.getEvents(signal);
    expect(seed.kind === "ok" ? seed.events.map((event) => event.title) : []).toEqual(["East"]);
    fetchMock.mockClear();
    fetchMock.mockImplementation(async (url: string) =>
      url.includes("calendarList")
        ? response({ items: [{ id: "primary", primary: true }] })
        : response({
            items: [
              meeting("east", "East", "2026-03-07T06:00:00.000Z"),
              meeting("west", "West", "2026-03-09T06:00:00.000Z"),
            ],
            nextSyncToken: "west-token",
          }),
    );

    // When the local timezone changes at the same instant.
    process.env.TZ = "America/Los_Angeles";
    const result = await provider.getEvents(signal);

    // Then a new unbounded seed projects the western two-day window.
    expect(requests()[0]?.searchParams.has("timeMin")).toBe(false);
    expect(requests()[0]?.searchParams.has("timeMax")).toBe(false);
    expect(requests()[0]?.searchParams.has("orderBy")).toBe(false);
    expect(requests()[0]?.searchParams.has("syncToken")).toBe(false);
    expect(result.kind === "ok" ? result.events.map((event) => event.title) : []).toEqual(["West"]);
  });

  it("advances a valid empty seed within unchanged bounds", async () => {
    // Given an empty unbounded full snapshot with a genuine terminal cursor.
    fetchMock.mockImplementation(async (url: string) =>
      url.includes("calendarList")
        ? response({ items: [{ id: "primary", primary: true }] })
        : response({ items: [], nextSyncToken: "empty-token" }),
    );
    const seed = await provider.getEvents(signal);
    expect(seed.kind).toBe("ok");
    expect(stored["primary"]).toBe("empty-token");
    const seedRequest = requests()[0];
    fetchMock.mockClear();

    // When another poll occurs before the window changes.
    await provider.getEvents(signal);

    // Then emptiness does not invalidate an otherwise paired cursor.
    expect(requests()[0]?.searchParams.get("syncToken")).toBe("empty-token");
    expect(requests()[0]?.searchParams.has("timeMin")).toBe(false);
    expect(requests()[0]?.searchParams.has("timeMax")).toBe(false);
    expect(requests()[0]?.searchParams.has("orderBy")).toBe(false);
    expect(seedRequest?.searchParams.has("timeMin")).toBe(false);
    expect(seedRequest?.searchParams.has("orderBy")).toBe(false);
  });
});

describe("Google delta traversal", () => {
  beforeEach(async () => {
    fetchMock.mockImplementation(async (url: string) =>
      url.includes("calendarList")
        ? response({ items: [{ id: "primary", primary: true }] })
        : response({ items: [meeting("seed", "Seed")], nextSyncToken: "seed-token" }),
    );
    await provider.getEvents(signal);
    expect(stored["primary"]).toBe("seed-token");
    fetchMock.mockClear();
  });

  it("carries the original sync token and invariant parameters on every page, committing only the terminal token", async () => {
    // Given a two-page delta, with a nonterminal token that must not be committed.
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes("calendarList"))
        return response({ items: [{ id: "primary", primary: true }] });
      return new URL(url).searchParams.has("pageToken")
        ? response({ items: [meeting("last", "Last")], nextSyncToken: "terminal" })
        : response({
            items: [meeting("first", "First")],
            nextPageToken: "page-2",
            nextSyncToken: "premature",
          });
    });

    // When the delta is traversed.
    const result = await provider.getEvents(signal);

    // Then both pages use the same sync configuration, and only the final token persists.
    expect(requests()).toHaveLength(2);
    for (const [index, url] of requests().entries()) {
      expect(url.searchParams.get("syncToken")).toBe("seed-token");
      expect(url.searchParams.get("pageToken")).toBe(index === 0 ? null : "page-2");
      expect(url.searchParams.get("singleEvents")).toBe("true");
      expect(url.searchParams.get("conferenceDataVersion")).toBe("1");
      expect(url.searchParams.get("maxResults")).toBe("250");
      expect(url.searchParams.has("timeMin")).toBe(false);
      expect(url.searchParams.has("timeMax")).toBe(false);
      expect(url.searchParams.has("orderBy")).toBe(false);
    }
    expect(result.kind === "ok" ? result.events.map((event) => event.title).sort() : []).toEqual([
      "First",
      "Last",
      "Seed",
    ]);
    expect(stored["primary"]).toBe("terminal");
    expect(
      mocks.updateGoogleSyncToken.mock.calls.filter((call: unknown[]) => call[1] === "premature"),
    ).toHaveLength(0);
  });

  it.each([{}, { items: null }, { items: "not an array" }])(
    "discards a delta with malformed items %j rather than publishing a partial batch",
    async (malformed) => {
      // Given a first page with a deletion and a malformed second page.
      fetchMock.mockImplementation(async (url: string) => {
        if (url.includes("calendarList"))
          return response({ items: [{ id: "primary", primary: true }] });
        return new URL(url).searchParams.has("pageToken")
          ? response(malformed)
          : response({ items: [{ id: "seed", status: "cancelled" }], nextPageToken: "page-2" });
      });
      mocks.saveOfflineCache.mockClear();

      // When the delta is read.
      const result = await provider.getEvents(signal);

      // Then the incomplete chain neither authorizes live complete nor changes durable state.
      expect(
        result.kind === "ok" && result.source === "live" && result.completeness === "complete",
      ).toBe(false);
      expect(stored["primary"]).toBe("seed-token");
      expect(mocks.saveOfflineCache).not.toHaveBeenCalled();
    },
  );

  it("accepts an explicit empty delta and preserves the seeded meeting", async () => {
    // Given a well-formed empty delta.
    fetchMock.mockImplementation(async (url: string) =>
      url.includes("calendarList")
        ? response({ items: [{ id: "primary", primary: true }] })
        : response({ items: [], nextSyncToken: "after-empty" }),
    );

    // When the provider advances it.
    const result = await provider.getEvents(signal);

    // Then it remains a complete snapshot with its prior event and terminal token.
    expect(result.kind === "ok" ? result.events.map((event) => event.title) : []).toEqual(["Seed"]);
    expect(stored["primary"]).toBe("after-empty");
  });
});
