import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const { appState, encryptMock, decryptMock, encryptionOn, writeGate } = vi.hoisted(() => ({
  appState: { isPackaged: false, userData: "" },
  encryptMock: vi.fn((s: string) => Buffer.from(`enc:${s}`, "utf-8")),
  decryptMock: vi.fn((b: Buffer) => {
    const s = b.toString("utf-8");
    return s.startsWith("enc:") ? s.slice(4) : s;
  }),
  encryptionOn: { value: true },
  writeGate: {
    entered: undefined as undefined | (() => void),
    release: undefined as undefined | Promise<void>,
  },
}));

vi.mock("../../src/main/utils/secure-fs.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/main/utils/secure-fs.js")>();
  return {
    ...actual,
    writeSecureFile: async (...args: Parameters<typeof actual.writeSecureFile>) => {
      writeGate.entered?.();
      if (writeGate.release) await writeGate.release;
      return actual.writeSecureFile(...args);
    },
  };
});

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

describe("google-token-store", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "gogmeet-tokens-"));
    appState.userData = dir;
    appState.isPackaged = false;
    encryptionOn.value = true;
    writeGate.entered = undefined;
    writeGate.release = undefined;
    encryptMock.mockClear();
    decryptMock.mockClear();
    encryptMock.mockImplementation((s: string) => Buffer.from(`enc:${s}`, "utf-8"));
    decryptMock.mockImplementation((b: Buffer) => {
      const s = b.toString("utf-8");
      return s.startsWith("enc:") ? s.slice(4) : s;
    });
    process.env["GOOGLE_OAUTH_CLIENT_ID"] = "test-client-id.apps.googleusercontent.com";
    process.env["GOGMEET_ALLOW_PLAINTEXT_TOKENS"] = "1";
    vi.resetModules();
  });

  afterEach(async () => {
    delete process.env["GOOGLE_OAUTH_CLIENT_ID"];
    delete process.env["GOGMEET_ALLOW_PLAINTEXT_TOKENS"];
    await rm(dir, { recursive: true, force: true });
  });

  it("round-trips tokens with matching clientId", async () => {
    const { saveGoogleTokens, loadGoogleTokens } =
      await import("../../src/main/calendar/auth/google-token-store.js");
    await saveGoogleTokens({
      accessToken: "access",
      refreshToken: "refresh",
      expiryMs: Date.now() + 3600_000,
      email: "user@example.com",
      scope: "openid",
    });
    const loaded = await loadGoogleTokens();
    expect(loaded).not.toBeNull();
    expect(loaded?.accessToken).toBe("access");
    expect(loaded?.refreshToken).toBe("refresh");
    expect(loaded?.clientId).toBe("test-client-id.apps.googleusercontent.com");
    expect(loaded?.authSchemaVersion).toBe(1);
    expect(loaded?.email).toBe("user@example.com");
    expect(loaded?.scope).toBe("openid");
  });

  it("preserves ciphertext when clientId mismatches", async () => {
    const { readFile } = await import("node:fs/promises");
    const store = await import("../../src/main/calendar/auth/google-token-store.js");
    await store.saveGoogleTokens({
      accessToken: "access",
      refreshToken: "refresh",
      expiryMs: Date.now() + 3600_000,
      clientId: "test-client-id.apps.googleusercontent.com",
    });
    const before = await readFile(store.googleTokenFilePath());
    process.env["GOOGLE_OAUTH_CLIENT_ID"] = "other-client.apps.googleusercontent.com";
    vi.resetModules();
    const reloaded = await import("../../src/main/calendar/auth/google-token-store.js");
    expect(await reloaded.loadGoogleTokens()).toBeNull();
    const after = await readFile(reloaded.googleTokenFilePath());
    expect(Buffer.compare(before, after)).toBe(0);
    const typed = await reloaded.loadGoogleTokensResult();
    expect(typed).toMatchObject({
      kind: "err",
      reason: "client-mismatch",
      preservedCiphertext: true,
    });
  });

  it("clearGoogleTokens removes file", async () => {
    const store = await import("../../src/main/calendar/auth/google-token-store.js");
    await store.saveGoogleTokens({
      accessToken: "a",
      refreshToken: "r",
      expiryMs: Date.now() + 1000,
    });
    await store.clearGoogleTokens();
    expect(await store.loadGoogleTokens()).toBeNull();
    await store.clearGoogleTokens(); // missing file ok
  });

  it("rejects a failed unlink and permits later token mutations", async () => {
    const store = await import("../../src/main/calendar/auth/google-token-store.js");
    const path = store.googleTokenFilePath();
    await mkdir(path, { recursive: true });

    await expect(store.clearGoogleTokens()).rejects.toMatchObject({
      code: expect.stringMatching(/^(EISDIR|EPERM)$/),
    });

    await rm(path, { recursive: true });
    await store.saveGoogleTokens({ accessToken: "next", refreshToken: "refresh", expiryMs: 1 });
    expect(await store.loadGoogleTokensResult()).toMatchObject({
      kind: "ok",
      tokens: { accessToken: "next" },
    });
    await store.clearGoogleTokens();
    expect(await store.loadGoogleTokensResult()).toMatchObject({ kind: "err", reason: "missing" });
  });

  it("clear wins over a write already started for the same token path", async () => {
    const store = await import("../../src/main/calendar/auth/google-token-store.js");
    let enteredWrite: () => void = () => {};
    const started = new Promise<void>((resolve) => {
      enteredWrite = resolve;
    });
    let releaseWrite: () => void = () => {};
    writeGate.release = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    writeGate.entered = enteredWrite;

    const save = store.saveGoogleTokens({
      accessToken: "late",
      refreshToken: "refresh",
      expiryMs: 1,
    });
    await started;
    const clear = store.clearGoogleTokens();
    releaseWrite();
    await Promise.all([save, clear]);

    expect(await store.loadGoogleTokensResult()).toMatchObject({ kind: "err", reason: "missing" });
  });

  it("serializes queued writes and clear in invocation order", async () => {
    const store = await import("../../src/main/calendar/auth/google-token-store.js");
    let enteredWrite: () => void = () => {};
    const started = new Promise<void>((resolve) => {
      enteredWrite = resolve;
    });
    let releaseWrite: () => void = () => {};
    writeGate.release = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    const writes: string[] = [];
    writeGate.entered = () => {
      writes.push("write");
      enteredWrite();
    };

    const first = store.saveGoogleTokens({
      accessToken: "first",
      refreshToken: "refresh",
      expiryMs: 1,
    });
    await started;
    const second = store.saveGoogleTokens({
      accessToken: "second",
      refreshToken: "refresh",
      expiryMs: 1,
    });
    const clear = store.clearGoogleTokens();
    await Promise.resolve();
    expect(writes).toHaveLength(1);
    releaseWrite();
    await Promise.all([first, second, clear]);

    expect(writes).toHaveLength(2);
    expect(await store.loadGoogleTokensResult()).toMatchObject({ kind: "err", reason: "missing" });
  });

  it("skips a queued refresh write when its lifecycle was invalidated", async () => {
    const store = await import("../../src/main/calendar/auth/google-token-store.js");
    let enteredWrite: () => void = () => {};
    const started = new Promise<void>((resolve) => {
      enteredWrite = resolve;
    });
    let releaseWrite: () => void = () => {};
    writeGate.release = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    const writes: string[] = [];
    writeGate.entered = () => {
      writes.push("write");
      enteredWrite();
    };

    const first = store.saveGoogleTokens({
      accessToken: "first",
      refreshToken: "refresh",
      expiryMs: 1,
    });
    await started;
    let active = true;
    const stale = store.saveGoogleTokens(
      { accessToken: "stale", refreshToken: "refresh", expiryMs: 1 },
      () => active,
    );
    active = false;
    const clear = store.clearGoogleTokens();
    releaseWrite();
    await Promise.all([first, stale, clear]);

    expect(writes).toHaveLength(1);
    expect(await store.loadGoogleTokensResult()).toMatchObject({ kind: "err", reason: "missing" });
  });

  it("preserves ciphertext on a failed save and allows the next queued save", async () => {
    const { readFile } = await import("node:fs/promises");
    const store = await import("../../src/main/calendar/auth/google-token-store.js");
    await store.saveGoogleTokens({ accessToken: "original", refreshToken: "refresh", expiryMs: 1 });
    const before = await readFile(store.googleTokenFilePath());

    encryptionOn.value = false;
    appState.isPackaged = true;
    const failed = store.saveGoogleTokens({
      accessToken: "failed",
      refreshToken: "refresh",
      expiryMs: 1,
    });
    await expect(failed).rejects.toThrow(/secure storage/);
    expect(await readFile(store.googleTokenFilePath())).toEqual(before);

    encryptionOn.value = true;
    await store.saveGoogleTokens({ accessToken: "next", refreshToken: "refresh", expiryMs: 1 });
    expect(await store.loadGoogleTokensResult()).toMatchObject({
      kind: "ok",
      tokens: { accessToken: "next" },
    });
  });

  it("load returns null for corrupt JSON but preserves ciphertext", async () => {
    const { readFile } = await import("node:fs/promises");
    const store = await import("../../src/main/calendar/auth/google-token-store.js");
    await store.saveGoogleTokens({
      accessToken: "a",
      refreshToken: "r",
      expiryMs: Date.now() + 99999,
    });
    const before = await readFile(store.googleTokenFilePath());
    decryptMock.mockReturnValueOnce("not-json");
    expect(await store.loadGoogleTokens()).toBeNull();
    const after = await readFile(store.googleTokenFilePath());
    expect(Buffer.compare(before, after)).toBe(0);
    decryptMock.mockReturnValueOnce("not-json");
    const typed = await store.loadGoogleTokensResult();
    expect(typed).toMatchObject({
      kind: "err",
      reason: "malformed",
      preservedCiphertext: true,
    });
  });

  it("preserves ciphertext when decrypt throws", async () => {
    const { readFile } = await import("node:fs/promises");
    const store = await import("../../src/main/calendar/auth/google-token-store.js");
    await store.saveGoogleTokens({
      accessToken: "a",
      refreshToken: "r",
      expiryMs: Date.now() + 99999,
    });
    const before = await readFile(store.googleTokenFilePath());
    decryptMock.mockImplementationOnce(() => {
      throw new Error("decrypt failed");
    });
    expect(await store.loadGoogleTokens()).toBeNull();
    const after = await readFile(store.googleTokenFilePath());
    expect(Buffer.compare(before, after)).toBe(0);
  });

  it("preserves ciphertext when secure storage is temporarily unavailable", async () => {
    const { readFile } = await import("node:fs/promises");
    const store = await import("../../src/main/calendar/auth/google-token-store.js");
    await store.saveGoogleTokens({
      accessToken: "a",
      refreshToken: "r",
      expiryMs: Date.now() + 99999,
    });
    const before = await readFile(store.googleTokenFilePath());
    encryptionOn.value = false;
    delete process.env["GOGMEET_ALLOW_PLAINTEXT_TOKENS"];
    appState.isPackaged = true;
    const typed = await store.loadGoogleTokensResult();
    expect(typed).toMatchObject({
      kind: "err",
      reason: "secure-storage-unavailable",
      preservedCiphertext: true,
    });
    const after = await readFile(store.googleTokenFilePath());
    expect(Buffer.compare(before, after)).toBe(0);
  });

  it("save throws when client id missing", async () => {
    delete process.env["GOOGLE_OAUTH_CLIENT_ID"];
    vi.resetModules();
    const store = await import("../../src/main/calendar/auth/google-token-store.js");
    await expect(
      store.saveGoogleTokens({
        accessToken: "a",
        refreshToken: "r",
        expiryMs: Date.now() + 1000,
      }),
    ).rejects.toThrow(/GOOGLE_OAUTH_CLIENT_ID/);
  });

  it("uses plaintext when encryption off and dev flag set", async () => {
    encryptionOn.value = false;
    process.env["GOGMEET_ALLOW_PLAINTEXT_TOKENS"] = "1";
    vi.resetModules();
    const store = await import("../../src/main/calendar/auth/google-token-store.js");
    await store.saveGoogleTokens({
      accessToken: "plain",
      refreshToken: "r",
      expiryMs: Date.now() + 1000,
    });
    expect(encryptMock).not.toHaveBeenCalled();
    const loaded = await store.loadGoogleTokens();
    expect(loaded?.accessToken).toBe("plain");
  });

  it("save fails closed when packaged without encryption", async () => {
    encryptionOn.value = false;
    appState.isPackaged = true;
    delete process.env["GOGMEET_ALLOW_PLAINTEXT_TOKENS"];
    vi.resetModules();
    const store = await import("../../src/main/calendar/auth/google-token-store.js");
    await expect(
      store.saveGoogleTokens({
        accessToken: "a",
        refreshToken: "r",
        expiryMs: Date.now() + 1000,
      }),
    ).rejects.toThrow(/secure storage/);
  });

  it("does not let queued refresh of A overwrite newly connected B", async () => {
    const store = await import("../../src/main/calendar/auth/google-token-store.js");
    await store.saveGoogleTokens({ accessToken: "A", refreshToken: "A-refresh", expiryMs: 1 });
    const original = await store.loadGoogleTokens();
    expect(original).not.toBeNull();
    if (!original) throw new Error("Expected original tokens");

    let enteredWrite: () => void = () => {};
    const started = new Promise<void>((resolve) => {
      enteredWrite = resolve;
    });
    let releaseWrite: () => void = () => {};
    writeGate.release = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    writeGate.entered = enteredWrite;
    const connectB = store.saveGoogleTokens({
      accessToken: "B",
      refreshToken: "B-refresh",
      expiryMs: 2,
    });
    await started;
    const staleRefresh = store.saveGoogleTokensIfCurrent(original, {
      ...original,
      accessToken: "A-new",
      expiryMs: 3,
    });
    releaseWrite();
    expect(await staleRefresh).toBe(false);
    await connectB;
    expect(await store.loadGoogleTokens()).toMatchObject({
      accessToken: "B",
      refreshToken: "B-refresh",
    });
  });

  it("does not let queued invalid_grant from A clear newly connected B", async () => {
    const store = await import("../../src/main/calendar/auth/google-token-store.js");
    await store.saveGoogleTokens({ accessToken: "A", refreshToken: "A-refresh", expiryMs: 1 });
    const original = await store.loadGoogleTokens();
    expect(original).not.toBeNull();
    if (!original) throw new Error("Expected original tokens");

    let enteredWrite: () => void = () => {};
    const started = new Promise<void>((resolve) => {
      enteredWrite = resolve;
    });
    let releaseWrite: () => void = () => {};
    writeGate.release = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    writeGate.entered = enteredWrite;
    const connectB = store.saveGoogleTokens({
      accessToken: "B",
      refreshToken: "B-refresh",
      expiryMs: 2,
    });
    await started;
    const staleClear = store.clearGoogleTokensIfCurrent(original);
    releaseWrite();
    expect(await staleClear).toBe(false);
    await connectB;
    expect(await store.loadGoogleTokens()).toMatchObject({
      accessToken: "B",
      refreshToken: "B-refresh",
    });
  });

  it("compares every credential field even when the account stays the same", async () => {
    const store = await import("../../src/main/calendar/auth/google-token-store.js");
    await store.saveGoogleTokens({
      accessToken: "A",
      refreshToken: "R",
      expiryMs: 1,
      email: "same@domain.test",
      scope: "openid",
    });
    const original = await store.loadGoogleTokens();
    expect(original).not.toBeNull();
    if (!original) throw new Error("Expected original tokens");

    for (const changed of [
      { ...original, accessToken: "new-access" },
      { ...original, refreshToken: "new-refresh" },
      { ...original, expiryMs: 2 },
      { ...original, email: "other@domain.test" },
      { ...original, scope: "calendar" },
    ]) {
      await store.saveGoogleTokens(changed);
      expect(
        await store.saveGoogleTokensIfCurrent(original, {
          ...original,
          accessToken: "stale",
          expiryMs: 3,
        }),
      ).toBe(false);
      expect(await store.clearGoogleTokensIfCurrent(original)).toBe(false);
      expect(await store.loadGoogleTokens()).toEqual(changed);
    }
  });

  it("preserves unreadable ciphertext rather than conditionally overwriting or deleting it", async () => {
    const { readFile, writeFile } = await import("node:fs/promises");
    const store = await import("../../src/main/calendar/auth/google-token-store.js");
    await store.saveGoogleTokens({ accessToken: "A", refreshToken: "R", expiryMs: 1 });
    const original = await store.loadGoogleTokens();
    expect(original).not.toBeNull();
    if (!original) throw new Error("Expected original tokens");
    const ciphertext = Buffer.from("unreadable ciphertext");
    await writeFile(store.googleTokenFilePath(), ciphertext);
    decryptMock.mockImplementation(() => {
      throw new Error("decrypt failed");
    });

    expect(
      await store.saveGoogleTokensIfCurrent(original, {
        ...original,
        accessToken: "new",
        expiryMs: 2,
      }),
    ).toBe(false);
    expect(await store.clearGoogleTokensIfCurrent(original)).toBe(false);
    expect(await readFile(store.googleTokenFilePath())).toEqual(ciphertext);
  });

  it("propagates a genuine read failure without mutating credentials", async () => {
    const store = await import("../../src/main/calendar/auth/google-token-store.js");
    await mkdir(join(dir, "calendar-auth"), { recursive: true });
    await mkdir(store.googleTokenFilePath());
    const expected = {
      authSchemaVersion: 1,
      clientId: "test-client-id.apps.googleusercontent.com",
      accessToken: "A",
      refreshToken: "R",
      expiryMs: 1,
    } as const;

    await expect(store.saveGoogleTokensIfCurrent(expected, expected)).rejects.toMatchObject({
      code: "EISDIR",
    });
    await expect(store.clearGoogleTokensIfCurrent(expected)).rejects.toMatchObject({
      code: "EISDIR",
    });
  });

  it("reports applied mutations and skips a queued operation when liveness turns false", async () => {
    const store = await import("../../src/main/calendar/auth/google-token-store.js");
    await store.saveGoogleTokens({ accessToken: "A", refreshToken: "R", expiryMs: 1 });
    const original = await store.loadGoogleTokens();
    expect(original).not.toBeNull();
    if (!original) throw new Error("Expected original tokens");
    expect(
      await store.saveGoogleTokensIfCurrent(original, {
        ...original,
        accessToken: "fresh",
        expiryMs: 2,
      }),
    ).toBe(true);
    const fresh = await store.loadGoogleTokens();
    expect(fresh).not.toBeNull();
    if (!fresh) throw new Error("Expected refreshed tokens");

    let enteredWrite: () => void = () => {};
    const started = new Promise<void>((resolve) => {
      enteredWrite = resolve;
    });
    let releaseWrite: () => void = () => {};
    writeGate.release = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    writeGate.entered = enteredWrite;
    const busy = store.saveGoogleTokens(fresh);
    await started;
    let active = true;
    const staleSave = store.saveGoogleTokensIfCurrent(
      fresh,
      { ...fresh, accessToken: "stale", expiryMs: 3 },
      () => active,
    );
    const staleClear = store.clearGoogleTokensIfCurrent(fresh, () => active);
    active = false;
    releaseWrite();
    expect(await staleSave).toBe(false);
    expect(await staleClear).toBe(false);
    await busy;
    expect(await store.loadGoogleTokens()).toEqual(fresh);
    expect(await store.clearGoogleTokensIfCurrent(fresh)).toBe(true);
    expect(await store.clearGoogleTokensIfCurrent(fresh)).toBe(false);
  });
});
