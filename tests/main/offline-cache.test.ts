import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createMockEvent,
  asTestMeetUrl,
  asTestIsoUtc,
  asTestEventId,
} from "../helpers/test-utils.js";

const { appState, encryptMock, decryptMock, encryptionAvailable } = vi.hoisted(() => ({
  appState: { isPackaged: false, userData: "" },
  encryptMock: vi.fn((s: string) => Buffer.from(`enc:${s}`, "utf-8")),
  decryptMock: vi.fn((b: Buffer) => {
    const s = b.toString("utf-8");
    return s.startsWith("enc:") ? s.slice(4) : s;
  }),
  encryptionAvailable: { value: true },
}));

vi.mock("electron", () => ({
  app: {
    get isPackaged() {
      return appState.isPackaged;
    },
    getPath: (name: string) => (name === "userData" ? appState.userData : "/tmp"),
  },
  safeStorage: {
    isEncryptionAvailable: () => encryptionAvailable.value,
    encryptString: encryptMock,
    decryptString: decryptMock,
  },
}));

describe("offline-cache", () => {
  let dir: string;
  let originalTimezone: string | undefined;

  beforeEach(async () => {
    originalTimezone = process.env["TZ"];
    dir = await mkdtemp(join(tmpdir(), "gogmeet-cache-"));
    appState.userData = dir;
    appState.isPackaged = false;
    encryptionAvailable.value = true;
    encryptMock.mockClear();
    decryptMock.mockClear();
    encryptMock.mockImplementation((s: string) => Buffer.from(`enc:${s}`, "utf-8"));
    decryptMock.mockImplementation((b: Buffer) => {
      const s = b.toString("utf-8");
      return s.startsWith("enc:") ? s.slice(4) : s;
    });
    delete process.env["GOGMEET_ALLOW_PLAINTEXT_TOKENS"];
    vi.resetModules();
  });

  afterEach(async () => {
    if (originalTimezone === undefined) delete process.env["TZ"];
    else process.env["TZ"] = originalTimezone;
    delete process.env["GOGMEET_ALLOW_PLAINTEXT_TOKENS"];
    await rm(dir, { recursive: true, force: true });
  });

  it("round-trips v1 complete snapshot with encryption", async () => {
    const { saveOfflineCache, loadOfflineCache, OFFLINE_CACHE_SCHEMA_VERSION } = await import(
      "../../src/main/calendar/offline-cache.js"
    );
    const e = createMockEvent({
      meetUrl: asTestMeetUrl("https://meet.google.com/abc-defg-hij"),
      userEmail: "u@example.com",
      description: "notes",
      startDate: asTestIsoUtc(new Date(Date.now() + 60_000).toISOString()),
      endDate: asTestIsoUtc(new Date(Date.now() + 3_600_000).toISOString()),
    });
    const observedAt = Date.now() - 1_000;
    await saveOfflineCache([e], observedAt);
    expect(encryptMock).toHaveBeenCalled();
    const loaded = await loadOfflineCache();
    expect(loaded).not.toBeNull();
    expect(loaded!.version).toBe(OFFLINE_CACHE_SCHEMA_VERSION);
    expect(loaded!.observedAt).toBe(observedAt);
    expect(typeof loaded!.cachedAt).toBe("number");
    expect(loaded!.events).toHaveLength(1);
    expect(loaded!.events[0]!.title).toBe(e.title);
    expect(loaded!.events[0]!.meetUrl).toBe(e.meetUrl);
  });

  it("returns null when file missing", async () => {
    const { loadOfflineCache } = await import("../../src/main/calendar/offline-cache.js");
    expect(await loadOfflineCache()).toBeNull();
  });

  it("rejects unversioned legacy payload", async () => {
    encryptionAvailable.value = false;
    process.env["GOGMEET_ALLOW_PLAINTEXT_TOKENS"] = "1";
    const { loadOfflineCache, offlineCacheFilePath } = await import(
      "../../src/main/calendar/offline-cache.js"
    );
    const { writeFile } = await import("node:fs/promises");
    const e = createMockEvent({
      startDate: asTestIsoUtc(new Date(Date.now() + 60_000).toISOString()),
      endDate: asTestIsoUtc(new Date(Date.now() + 3_600_000).toISOString()),
    });
    await writeFile(
      offlineCacheFilePath(),
      JSON.stringify({ savedAt: Date.now(), events: [e] }),
      "utf-8",
    );
    expect(await loadOfflineCache()).toBeNull();
  });

  it("rejects unknown version and future timestamps", async () => {
    encryptionAvailable.value = false;
    process.env["GOGMEET_ALLOW_PLAINTEXT_TOKENS"] = "1";
    const { loadOfflineCache, offlineCacheFilePath } = await import(
      "../../src/main/calendar/offline-cache.js"
    );
    const { writeFile } = await import("node:fs/promises");
    const e = createMockEvent({
      startDate: asTestIsoUtc(new Date(Date.now() + 60_000).toISOString()),
      endDate: asTestIsoUtc(new Date(Date.now() + 3_600_000).toISOString()),
    });
    await writeFile(
      offlineCacheFilePath(),
      JSON.stringify({
        version: 99,
        observedAt: Date.now(),
        cachedAt: Date.now(),
        events: [e],
      }),
      "utf-8",
    );
    expect(await loadOfflineCache()).toBeNull();

    await writeFile(
      offlineCacheFilePath(),
      JSON.stringify({
        version: 1,
        observedAt: Date.now() + 10 * 60_000,
        cachedAt: Date.now(),
        events: [e],
      }),
      "utf-8",
    );
    expect(await loadOfflineCache()).toBeNull();
  });

  it("filters ended events and allows empty offline success", async () => {
    encryptionAvailable.value = false;
    process.env["GOGMEET_ALLOW_PLAINTEXT_TOKENS"] = "1";
    const { saveOfflineCache, loadOfflineCache } = await import(
      "../../src/main/calendar/offline-cache.js"
    );
    const past = createMockEvent({
      id: asTestEventId("past"),
      startDate: asTestIsoUtc(new Date(Date.now() - 3_600_000).toISOString()),
      endDate: asTestIsoUtc(new Date(Date.now() - 1_800_000).toISOString()),
    });
    await saveOfflineCache([past], Date.now() - 5_000);
    const loaded = await loadOfflineCache();
    expect(loaded).not.toBeNull();
    expect(loaded!.events).toEqual([]);
  });

  it("keeps date-only events through the final local day while timed events end at their UTC instant", async () => {
    process.env["TZ"] = "America/Los_Angeles";
    const { saveOfflineCache, loadOfflineCache } =
      await import("../../src/main/calendar/offline-cache.js");
    const exclusiveEnd = asTestIsoUtc("2026-07-28T00:00:00.000Z");
    const allDay = createMockEvent({
      id: asTestEventId("all-day"),
      isAllDay: true,
      startDate: asTestIsoUtc("2026-07-27T00:00:00.000Z"),
      endDate: exclusiveEnd,
    });
    const timed = createMockEvent({
      id: asTestEventId("timed"),
      startDate: asTestIsoUtc("2026-07-27T23:00:00.000Z"),
      endDate: exclusiveEnd,
    });
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-07-27T00:00:00.000Z"));
    await saveOfflineCache([allDay, timed]);
    clock.mockRestore();

    expect((await loadOfflineCache(Date.parse("2026-07-28T00:00:00.000Z")))?.events).toEqual([
      allDay,
    ]);
    expect((await loadOfflineCache(Date.parse("2026-07-28T07:00:00.000Z")))?.events).toEqual([]);
  });

  it("expires date-only events at local midnight after the DST fall-back day", async () => {
    process.env["TZ"] = "America/Los_Angeles";
    const { saveOfflineCache, loadOfflineCache } =
      await import("../../src/main/calendar/offline-cache.js");
    const allDay = createMockEvent({
      isAllDay: true,
      startDate: asTestIsoUtc("2026-11-01T00:00:00.000Z"),
      endDate: asTestIsoUtc("2026-11-02T00:00:00.000Z"),
    });
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-11-01T00:00:00.000Z"));
    await saveOfflineCache([allDay]);
    clock.mockRestore();

    expect((await loadOfflineCache(Date.parse("2026-11-02T07:59:59.999Z")))?.events).toEqual([
      allDay,
    ]);
    expect((await loadOfflineCache(Date.parse("2026-11-02T08:00:00.000Z")))?.events).toEqual([]);
  });

  it("returns null for corrupt payload", async () => {
    const { loadOfflineCache, offlineCacheFilePath } = await import(
      "../../src/main/calendar/offline-cache.js"
    );
    const { writeFile, mkdir } = await import("node:fs/promises");
    const path = offlineCacheFilePath();
    await mkdir(dir, { recursive: true });
    await writeFile(path, Buffer.from("enc:not-json", "utf-8"));
    expect(await loadOfflineCache()).toBeNull();
  });

  it("uses plaintext when encryption unavailable and dev flag set", async () => {
    encryptionAvailable.value = false;
    process.env["GOGMEET_ALLOW_PLAINTEXT_TOKENS"] = "1";
    const { saveOfflineCache, loadOfflineCache } = await import(
      "../../src/main/calendar/offline-cache.js"
    );
    const e = createMockEvent({
      startDate: asTestIsoUtc(new Date(Date.now() + 60_000).toISOString()),
      endDate: asTestIsoUtc(new Date(Date.now() + 3_600_000).toISOString()),
    });
    await saveOfflineCache([e]);
    expect(encryptMock).not.toHaveBeenCalled();
    const loaded = await loadOfflineCache();
    expect(loaded!.events).toHaveLength(1);
  });

  it("fails save quietly when encryption unavailable without plaintext flag", async () => {
    encryptionAvailable.value = false;
    appState.isPackaged = true;
    const { saveOfflineCache, loadOfflineCache } = await import(
      "../../src/main/calendar/offline-cache.js"
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await saveOfflineCache([createMockEvent()]);
    expect(warn).toHaveBeenCalled();
    expect(await loadOfflineCache()).toBeNull();
    warn.mockRestore();
  });

  it("clearOfflineCache removes file and ignores missing", async () => {
    const { saveOfflineCache, clearOfflineCache, loadOfflineCache } = await import(
      "../../src/main/calendar/offline-cache.js"
    );
    const e = createMockEvent({
      startDate: asTestIsoUtc(new Date(Date.now() + 60_000).toISOString()),
      endDate: asTestIsoUtc(new Date(Date.now() + 3_600_000).toISOString()),
    });
    await saveOfflineCache([e]);
    expect(await loadOfflineCache()).not.toBeNull();
    await clearOfflineCache();
    expect(await loadOfflineCache()).toBeNull();
    await clearOfflineCache();
  });

  it("drops invalid meetUrl but keeps event", async () => {
    encryptionAvailable.value = false;
    process.env["GOGMEET_ALLOW_PLAINTEXT_TOKENS"] = "1";
    const { loadOfflineCache, offlineCacheFilePath } = await import(
      "../../src/main/calendar/offline-cache.js"
    );
    const { writeFile } = await import("node:fs/promises");
    const e = createMockEvent({
      startDate: asTestIsoUtc(new Date(Date.now() + 60_000).toISOString()),
      endDate: asTestIsoUtc(new Date(Date.now() + 3_600_000).toISOString()),
    });
    await writeFile(
      offlineCacheFilePath(),
      JSON.stringify({
        version: 1,
        observedAt: Date.now() - 100,
        cachedAt: Date.now() - 50,
        events: [
          {
            id: e.id,
            title: e.title,
            startDate: e.startDate,
            endDate: e.endDate,
            calendarName: e.calendarName,
            isAllDay: false,
            meetUrl: "http://evil.example/not-allowed",
          },
        ],
      }),
      "utf-8",
    );
    const loaded = await loadOfflineCache();
    expect(loaded!.events).toHaveLength(1);
    expect(loaded!.events[0]!.meetUrl).toBeUndefined();
  });

  it("refuses save when observedAt is non-finite or far in the future", async () => {
    const { saveOfflineCache, loadOfflineCache } = await import(
      "../../src/main/calendar/offline-cache.js"
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await saveOfflineCache([createMockEvent()], Number.NaN);
    await saveOfflineCache([createMockEvent()], Date.now() + 60 * 60_000);
    expect(warn).toHaveBeenCalled();
    expect(await loadOfflineCache()).toBeNull();
    warn.mockRestore();
  });

  it("treats encryptionAvailable throw as unavailable", async () => {
    const { safeStorage } = await import("electron");
    vi.spyOn(safeStorage, "isEncryptionAvailable").mockImplementation(() => {
      throw new Error("secure storage probe failed");
    });
    process.env["GOGMEET_ALLOW_PLAINTEXT_TOKENS"] = "1";
    appState.isPackaged = false;
    const { saveOfflineCache, loadOfflineCache } = await import(
      "../../src/main/calendar/offline-cache.js"
    );
    const e = createMockEvent({
      startDate: asTestIsoUtc(new Date(Date.now() + 60_000).toISOString()),
      endDate: asTestIsoUtc(new Date(Date.now() + 3_600_000).toISOString()),
    });
    await saveOfflineCache([e]);
    expect(await loadOfflineCache()).not.toBeNull();
  });

  it("drops malformed event rows and rejects non-array events", async () => {
    encryptionAvailable.value = false;
    process.env["GOGMEET_ALLOW_PLAINTEXT_TOKENS"] = "1";
    const { loadOfflineCache, offlineCacheFilePath } = await import(
      "../../src/main/calendar/offline-cache.js"
    );
    const { writeFile } = await import("node:fs/promises");
    const good = createMockEvent({
      startDate: asTestIsoUtc(new Date(Date.now() + 60_000).toISOString()),
      endDate: asTestIsoUtc(new Date(Date.now() + 3_600_000).toISOString()),
    });
    await writeFile(
      offlineCacheFilePath(),
      JSON.stringify({
        version: 1,
        observedAt: Date.now() - 100,
        cachedAt: Date.now() - 50,
        events: [
          null,
          { id: 1, title: "bad" },
          {
            id: good.id,
            title: good.title,
            startDate: good.startDate,
            endDate: good.endDate,
            calendarName: good.calendarName,
            isAllDay: false,
            userEmail: "a@b.com",
            description: "x",
          },
        ],
      }),
      "utf-8",
    );
    const loaded = await loadOfflineCache();
    expect(loaded!.events).toHaveLength(1);
    expect(loaded!.events[0]!.userEmail).toBe("a@b.com");

    await writeFile(
      offlineCacheFilePath(),
      JSON.stringify({
        version: 1,
        observedAt: Date.now() - 100,
        cachedAt: Date.now() - 50,
        events: "nope",
      }),
      "utf-8",
    );
    expect(await loadOfflineCache()).toBeNull();
  });
});
