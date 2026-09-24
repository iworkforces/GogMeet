import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createMockEvent } from "../helpers/test-utils.js";

const { appState, gate } = vi.hoisted(() => ({
  appState: { userData: "" },
  gate: {
    entered: undefined as (() => void) | undefined,
    release: undefined as Promise<void> | undefined,
    dirEntered: undefined as (() => void) | undefined,
    dirRelease: undefined as Promise<void> | undefined,
    failNext: false,
  },
}));

vi.mock("electron", () => ({
  app: { isPackaged: false, getPath: () => appState.userData },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(`enc:${value}`),
    decryptString: (value: Buffer) => value.toString().slice(4),
  },
}));

vi.mock("../../src/main/utils/secure-fs.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/main/utils/secure-fs.js")>();
  return {
    ...original,
    ensureSecureDir: async (path: string): Promise<void> => {
      if (gate.dirRelease) {
        gate.dirEntered?.();
        await gate.dirRelease;
      }
      await original.ensureSecureDir(path);
    },
    writeSecureFile: async (path: string, data: Buffer | string): Promise<void> => {
      if (gate.release) {
        gate.entered?.();
        await gate.release;
      }
      if (gate.failNext) {
        gate.failNext = false;
        throw new Error("injected write failure");
      }
      await original.writeSecureFile(path, data);
    },
  };
});

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function pauseNextWrite(): Promise<() => void> {
  const entered = deferred();
  const release = deferred();
  gate.entered = entered.resolve;
  gate.release = release.promise;
  return async () => {
    await entered.promise;
    release.resolve();
    gate.release = undefined;
  };
}

function pauseNextDirectory(): { entered: Promise<void>; release: () => void } {
  const entered = deferred();
  const release = deferred();
  gate.dirEntered = entered.resolve;
  gate.dirRelease = release.promise;
  return {
    entered: entered.promise,
    release: () => {
      gate.dirRelease = undefined;
      release.resolve();
    },
  };
}

describe("serialized calendar stores", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "gogmeet-store-race-"));
    appState.userData = dir;
    gate.failNext = false;
    vi.resetModules();
  });

  afterEach(async () => {
    gate.release = undefined;
    gate.entered = undefined;
    gate.dirRelease = undefined;
    gate.dirEntered = undefined;
    await rm(dir, { recursive: true, force: true });
  });

  it("drains a started token write before clear and does not resurrect it", async () => {
    const { saveGoogleSyncTokens, clearAllGoogleSyncTokens, loadGoogleSyncTokens } =
      await import("../../src/main/calendar/auth/google-sync-tokens.js");
    const waitForWrite = await pauseNextWrite();
    const save = saveGoogleSyncTokens({ primary: "old" });
    const clear = clearAllGoogleSyncTokens();
    await waitForWrite();
    await Promise.all([save, clear]);
    expect(await loadGoogleSyncTokens()).toEqual({});
  });

  it("preserves sibling tokens across simultaneous per-calendar updates", async () => {
    const { updateGoogleSyncToken, loadGoogleSyncTokens } =
      await import("../../src/main/calendar/auth/google-sync-tokens.js");
    const waitForWrite = await pauseNextWrite();
    const first = updateGoogleSyncToken("primary", "one");
    const second = updateGoogleSyncToken("work", "two");
    await waitForWrite();
    expect(await Promise.all([first, second])).toEqual([true, true]);
    expect(await loadGoogleSyncTokens()).toEqual({ primary: "one", work: "two" });
  });

  it("skips queued stale token updates and recovers after a rejected save", async () => {
    const { updateGoogleSyncToken, saveGoogleSyncTokens, loadGoogleSyncTokens } =
      await import("../../src/main/calendar/auth/google-sync-tokens.js");
    const waitForWrite = await pauseNextWrite();
    const first = updateGoogleSyncToken("primary", "one");
    let current = true;
    const stale = updateGoogleSyncToken("work", "obsolete", () => current);
    current = false;
    await waitForWrite();
    expect(await Promise.all([first, stale])).toEqual([true, false]);
    expect(await loadGoogleSyncTokens()).toEqual({ primary: "one" });
    gate.failNext = true;
    await expect(saveGoogleSyncTokens({ primary: "two" })).rejects.toThrow(
      "injected write failure",
    );
    expect(await updateGoogleSyncToken("work", "three")).toBe(true);
    expect(await loadGoogleSyncTokens()).toEqual({ primary: "one", work: "three" });
  });

  it("skips a token write when its guard expires during directory I/O", async () => {
    const { updateGoogleSyncToken, googleSyncTokenFilePath } =
      await import("../../src/main/calendar/auth/google-sync-tokens.js");
    await updateGoogleSyncToken("primary", "original");
    const before = await readFile(googleSyncTokenFilePath());
    const directory = pauseNextDirectory();
    let current = true;
    const update = updateGoogleSyncToken("primary", "stale", () => current);

    await directory.entered;
    current = false;
    directory.release();
    expect(await update).toBe(false);
    expect(await readFile(googleSyncTokenFilePath())).toEqual(before);
  });

  it("reports token clear failure and permits a later operation", async () => {
    const { clearAllGoogleSyncTokens, googleSyncTokenFilePath, updateGoogleSyncToken } =
      await import("../../src/main/calendar/auth/google-sync-tokens.js");
    await mkdir(googleSyncTokenFilePath(), { recursive: true });
    await expect(clearAllGoogleSyncTokens()).rejects.toThrow();
    await rm(googleSyncTokenFilePath(), { recursive: true });
    await expect(updateGoogleSyncToken("primary", "fresh")).resolves.toBe(true);
  });

  it("drains cache writes before clear and keeps load ordered", async () => {
    const { saveOfflineCache, clearOfflineCache, loadOfflineCache } =
      await import("../../src/main/calendar/offline-cache.js");
    const waitForWrite = await pauseNextWrite();
    const save = saveOfflineCache([createMockEvent()]);
    const clear = clearOfflineCache();
    const load = loadOfflineCache();
    await waitForWrite();
    await Promise.all([save, clear]);
    expect(await load).toBeNull();
    expect(await loadOfflineCache()).toBeNull();
  });

  it("skips a queued stale cache save after clear", async () => {
    const { saveOfflineCache, clearOfflineCache, loadOfflineCache } =
      await import("../../src/main/calendar/offline-cache.js");
    const waitForWrite = await pauseNextWrite();
    const first = saveOfflineCache([createMockEvent()]);
    const clear = clearOfflineCache();
    let current = true;
    const stale = saveOfflineCache([createMockEvent()], Date.now(), () => current);
    current = false;
    await waitForWrite();
    await Promise.all([first, clear, stale]);
    expect(await loadOfflineCache()).toBeNull();
  });

  it("skips a cache write when its guard expires during directory I/O", async () => {
    const { saveOfflineCache, offlineCacheFilePath } =
      await import("../../src/main/calendar/offline-cache.js");
    await saveOfflineCache([createMockEvent()]);
    const before = await readFile(offlineCacheFilePath());
    const directory = pauseNextDirectory();
    let current = true;
    const save = saveOfflineCache([createMockEvent({ title: "stale" })], Date.now(), () => current);

    await directory.entered;
    current = false;
    directory.release();
    await save;
    expect(await readFile(offlineCacheFilePath())).toEqual(before);
  });

  it("keeps cache save best-effort and reports clear failure without poisoning the lane", async () => {
    const { saveOfflineCache, clearOfflineCache, loadOfflineCache, offlineCacheFilePath } =
      await import("../../src/main/calendar/offline-cache.js");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      gate.failNext = true;
      await expect(saveOfflineCache([createMockEvent()])).resolves.toBeUndefined();
      expect(warn).toHaveBeenCalled();
      await mkdir(offlineCacheFilePath(), { recursive: true });
      await expect(clearOfflineCache()).rejects.toThrow();
      await rm(offlineCacheFilePath(), { recursive: true });
      await saveOfflineCache([createMockEvent()]);
      expect(await loadOfflineCache()).not.toBeNull();
    } finally {
      warn.mockRestore();
    }
  });
});
