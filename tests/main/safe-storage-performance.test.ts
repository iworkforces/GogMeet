import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, access } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { constants as fsConstants } from "node:fs";

const { appState, encryptMock, decryptMock, encryptionOn } = vi.hoisted(() => ({
  appState: { isPackaged: false, userData: "" },
  encryptMock: vi.fn((s: string) => Buffer.from(`enc:${s}`, "utf-8")),
  decryptMock: vi.fn((b: Buffer) => {
    const s = b.toString("utf-8");
    return s.startsWith("enc:") ? s.slice(4) : s;
  }),
  encryptionOn: { value: true },
}));

vi.mock("electron", () => ({
  app: {
    get isPackaged() {
      return appState.isPackaged;
    },
    getPath: (name: string) => {
      if (name === "userData") return appState.userData;
      return "/tmp";
    },
  },
  safeStorage: {
    isEncryptionAvailable: () => encryptionOn.value,
    encryptString: encryptMock,
    decryptString: decryptMock,
  },
}));

describe("safeStorage temporary unavailability", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "gogmeet-safe-perf-"));
    appState.userData = dir;
    appState.isPackaged = true;
    encryptionOn.value = true;
    encryptMock.mockClear();
    decryptMock.mockClear();
    encryptMock.mockImplementation((s: string) => Buffer.from(`enc:${s}`, "utf-8"));
    decryptMock.mockImplementation((b: Buffer) => {
      const s = b.toString("utf-8");
      return s.startsWith("enc:") ? s.slice(4) : s;
    });
    process.env["GOOGLE_OAUTH_CLIENT_ID"] = "test-client-id.apps.googleusercontent.com";
    delete process.env["GOGMEET_ALLOW_PLAINTEXT_TOKENS"];
    vi.resetModules();
  });

  afterEach(async () => {
    delete process.env["GOOGLE_OAUTH_CLIENT_ID"];
    await rm(dir, { recursive: true, force: true });
  });

  it("preserves token ciphertext when secure storage becomes unavailable", async () => {
    const { saveGoogleTokens, loadGoogleTokensResult, googleTokenFilePath } = await import(
      "../../src/main/calendar/auth/google-token-store.js"
    );
    await saveGoogleTokens({
      accessToken: "access",
      refreshToken: "refresh",
      expiryMs: Date.now() + 3600_000,
    });
    const path = googleTokenFilePath();
    const before = await readFile(path);

    encryptionOn.value = false;
    const loaded = await loadGoogleTokensResult();
    expect(loaded.kind).toBe("err");
    if (loaded.kind === "err") {
      expect(loaded.reason).toBe("secure-storage-unavailable");
      expect(loaded.preservedCiphertext).toBe(true);
    }
    await access(path, fsConstants.F_OK);
    const after = await readFile(path);
    expect(Buffer.compare(before, after)).toBe(0);
  });

  it("preserves token ciphertext on decrypt throw", async () => {
    const { saveGoogleTokens, loadGoogleTokensResult, googleTokenFilePath } = await import(
      "../../src/main/calendar/auth/google-token-store.js"
    );
    await saveGoogleTokens({
      accessToken: "access",
      refreshToken: "refresh",
      expiryMs: Date.now() + 3600_000,
    });
    const path = googleTokenFilePath();
    decryptMock.mockImplementation(() => {
      throw new Error("decrypt failed");
    });
    const loaded = await loadGoogleTokensResult();
    expect(loaded.kind).toBe("err");
    if (loaded.kind === "err") {
      expect(loaded.reason).toBe("decrypt");
      expect(loaded.preservedCiphertext).toBe(true);
    }
    await access(path, fsConstants.F_OK);
  });

  it("missing file is explicit and does not invent plaintext", async () => {
    const { loadGoogleTokensResult } = await import(
      "../../src/main/calendar/auth/google-token-store.js"
    );
    const loaded = await loadGoogleTokensResult();
    expect(loaded).toEqual({ kind: "err", reason: "missing", preservedCiphertext: false });
  });

  it("offline cache load does not unlink when encryption unavailable", async () => {
    encryptionOn.value = true;
    process.env["GOGMEET_ALLOW_PLAINTEXT_TOKENS"] = "1";
    appState.isPackaged = false;
    vi.resetModules();
    const { saveOfflineCache, offlineCacheFilePath, loadOfflineCache } = await import(
      "../../src/main/calendar/offline-cache.js"
    );
    const now = Date.now();
    await saveOfflineCache([], now);
    const path = offlineCacheFilePath();
    await access(path, fsConstants.F_OK);

    encryptionOn.value = false;
    delete process.env["GOGMEET_ALLOW_PLAINTEXT_TOKENS"];
    appState.isPackaged = true;
    // load may return null but must not delete
    await loadOfflineCache(now);
    await access(path, fsConstants.F_OK);
  });
});
