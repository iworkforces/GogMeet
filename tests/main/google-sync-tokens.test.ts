import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const { appState, encryptMock, decryptMock, encryptionOn, encryptionThrows } = vi.hoisted(
  () => ({
    appState: { isPackaged: false, userData: "" },
    encryptMock: vi.fn((s: string) => Buffer.from(`enc:${s}`, "utf-8")),
    decryptMock: vi.fn((b: Buffer) => {
      const s = b.toString("utf-8");
      return s.startsWith("enc:") ? s.slice(4) : s;
    }),
    encryptionOn: { value: true },
    encryptionThrows: { value: false },
  }),
);

vi.mock("electron", () => ({
  app: {
    get isPackaged() {
      return appState.isPackaged;
    },
    getPath: (name: string) => (name === "userData" ? appState.userData : "/tmp"),
  },
  safeStorage: {
    isEncryptionAvailable: () => {
      if (encryptionThrows.value) throw new Error("safeStorage boom");
      return encryptionOn.value;
    },
    encryptString: encryptMock,
    decryptString: decryptMock,
  },
}));

describe("google-sync-tokens", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "gogmeet-sync-"));
    appState.userData = dir;
    appState.isPackaged = false;
    encryptionOn.value = true;
    encryptionThrows.value = false;
    encryptMock.mockClear();
    decryptMock.mockClear();
    encryptMock.mockImplementation((s: string) => Buffer.from(`enc:${s}`, "utf-8"));
    decryptMock.mockImplementation((b: Buffer) => {
      const s = b.toString("utf-8");
      return s.startsWith("enc:") ? s.slice(4) : s;
    });
    process.env["GOGMEET_ALLOW_PLAINTEXT_TOKENS"] = "1";
    vi.resetModules();
  });

  afterEach(async () => {
    delete process.env["GOGMEET_ALLOW_PLAINTEXT_TOKENS"];
    await rm(dir, { recursive: true, force: true });
  });

  it("round-trips per-calendar tokens and supports clear", async () => {
    const {
      loadGoogleSyncTokens,
      saveGoogleSyncTokens,
      clearGoogleSyncToken,
      clearAllGoogleSyncTokens,
      googleSyncTokenFilePath,
    } = await import("../../src/main/calendar/auth/google-sync-tokens.js");

    expect(await loadGoogleSyncTokens()).toEqual({});
    expect(googleSyncTokenFilePath()).toContain("google-sync.enc");
    await saveGoogleSyncTokens({ primary: "sync-1", work: "sync-2" });
    expect(await loadGoogleSyncTokens()).toEqual({ primary: "sync-1", work: "sync-2" });
    expect(encryptMock).toHaveBeenCalled();
    await clearGoogleSyncToken("primary");
    expect(await loadGoogleSyncTokens()).toEqual({ work: "sync-2" });
    // No-op when calendar id is absent
    await clearGoogleSyncToken("missing");
    expect(await loadGoogleSyncTokens()).toEqual({ work: "sync-2" });
    await clearAllGoogleSyncTokens();
    expect(await loadGoogleSyncTokens()).toEqual({});
    // clearAll is idempotent when file already gone
    await clearAllGoogleSyncTokens();
  });

  it("rejects invalid schema / non-object tokens and filters empty values", async () => {
    const { loadGoogleSyncTokens, googleSyncTokenFilePath } = await import(
      "../../src/main/calendar/auth/google-sync-tokens.js"
    );
    const path = googleSyncTokenFilePath();
    await mkdir(join(dir, "calendar-auth"), { recursive: true });

    await writeFile(path, encryptMock(JSON.stringify({ version: 99, tokens: { a: "x" } })));
    expect(await loadGoogleSyncTokens()).toEqual({});

    await writeFile(path, encryptMock(JSON.stringify({ version: 1, tokens: "nope" })));
    expect(await loadGoogleSyncTokens()).toEqual({});

    await writeFile(
      path,
      encryptMock(JSON.stringify({ version: 1, tokens: { ok: "tok", bad: "", num: 1 } })),
    );
    expect(await loadGoogleSyncTokens()).toEqual({ ok: "tok" });
  });

  it("uses plaintext in unpackaged dev when encryption is unavailable", async () => {
    encryptionOn.value = false;
    process.env["GOGMEET_ALLOW_PLAINTEXT_TOKENS"] = "1";
    const { saveGoogleSyncTokens, loadGoogleSyncTokens } = await import(
      "../../src/main/calendar/auth/google-sync-tokens.js"
    );
    await saveGoogleSyncTokens({ primary: "plain-tok" });
    expect(encryptMock).not.toHaveBeenCalled();
    expect(await loadGoogleSyncTokens()).toEqual({ primary: "plain-tok" });
  });

  it("reports save failures when encryption is unavailable in packaged builds", async () => {
    appState.isPackaged = true;
    encryptionOn.value = false;
    delete process.env["GOGMEET_ALLOW_PLAINTEXT_TOKENS"];
    const { saveGoogleSyncTokens, loadGoogleSyncTokens } = await import(
      "../../src/main/calendar/auth/google-sync-tokens.js"
    );
    await expect(saveGoogleSyncTokens({ primary: "x" })).rejects.toThrow(
      "OS secure storage unavailable",
    );
    expect(await loadGoogleSyncTokens()).toEqual({});
  });

  it("treats encryptionAvailable throw as unavailable", async () => {
    encryptionThrows.value = true;
    process.env["GOGMEET_ALLOW_PLAINTEXT_TOKENS"] = "1";
    const { saveGoogleSyncTokens, loadGoogleSyncTokens } = await import(
      "../../src/main/calendar/auth/google-sync-tokens.js"
    );
    await saveGoogleSyncTokens({ primary: "via-catch" });
    expect(await loadGoogleSyncTokens()).toEqual({ primary: "via-catch" });
  });

  it("returns empty map for corrupt JSON payloads", async () => {
    const { loadGoogleSyncTokens, googleSyncTokenFilePath } = await import(
      "../../src/main/calendar/auth/google-sync-tokens.js"
    );
    const path = googleSyncTokenFilePath();
    await mkdir(join(dir, "calendar-auth"), { recursive: true });
    await writeFile(path, encryptMock("not-json{"));
    expect(await loadGoogleSyncTokens()).toEqual({});
  });

  it("returns empty map when decrypt fails", async () => {
    decryptMock.mockImplementation(() => {
      throw new Error("decrypt fail");
    });
    const { saveGoogleSyncTokens, loadGoogleSyncTokens } = await import(
      "../../src/main/calendar/auth/google-sync-tokens.js"
    );
    await saveGoogleSyncTokens({ primary: "x" });
    expect(await loadGoogleSyncTokens()).toEqual({});
  });
});
