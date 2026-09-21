import { BrowserWindow } from "electron";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PERF_PROBE_USER_DATA_PREFIX } from "../../src/main/app/performance-probe-contract.js";

const {
  mockSetupTray,
  mockDestroyTray,
  mockRequestTrayRebuild,
  mockShowAlert,
  mockDestroyAlert,
  mockSaveTokens,
  mockLoadTokensResult,
  mockClearTokens,
  mockSaveCache,
  mockLoadCache,
  mockClearCache,
  mockCreateAppGraph,
  mockFlush,
  mockMainBusEmit,
} = vi.hoisted(() => ({
  mockSetupTray: vi.fn(),
  mockDestroyTray: vi.fn(),
  mockRequestTrayRebuild: vi.fn(),
  mockShowAlert: vi.fn(),
  mockDestroyAlert: vi.fn(),
  mockSaveTokens: vi.fn().mockResolvedValue(undefined),
  mockLoadTokensResult: vi.fn(),
  mockClearTokens: vi.fn().mockResolvedValue(undefined),
  mockSaveCache: vi.fn().mockResolvedValue(undefined),
  mockLoadCache: vi.fn(),
  mockClearCache: vi.fn().mockResolvedValue(undefined),
  mockCreateAppGraph: vi.fn(() => ({
    calendar: {},
    settings: { get: () => ({ showTomorrowMeetings: true, showCompletedTodayMeetings: false }) },
    scheduler: {},
    watcher: {},
    join: {},
    opener: {},
  })),
  mockFlush: vi.fn(() => ({ ok: true, path: null })),
  mockMainBusEmit: vi.fn(),
}));

vi.mock("electron", () => {
  function MockBrowserWindow(this: Record<string, unknown>) {
    this.isDestroyed = vi.fn(() => false);
    this.destroy = vi.fn();
    this.webContents = { send: vi.fn(), executeJavaScript: vi.fn().mockResolvedValue(true) };
    this.on = vi.fn();
    this.once = vi.fn();
  }
  return {
    BrowserWindow: vi.fn(MockBrowserWindow),
    app: {
      isPackaged: true,
      getPath: () => "/tmp",
      once: vi.fn(),
    },
    Menu: { buildFromTemplate: vi.fn(() => ({})) },
    Tray: vi.fn(),
    nativeImage: { createFromPath: vi.fn() },
    nativeTheme: { shouldUseDarkColors: false, on: vi.fn() },
  };
});

vi.mock("../../src/main/tray.js", () => ({
  setupTray: mockSetupTray,
  destroyTray: mockDestroyTray,
  requestTrayRebuild: mockRequestTrayRebuild,
}));

vi.mock("../../src/main/windows/alert-window.js", () => ({
  showAlert: mockShowAlert,
  destroyAlertWindow: mockDestroyAlert,
}));

vi.mock("../../src/main/calendar/auth/google-token-store.js", () => ({
  saveGoogleTokens: mockSaveTokens,
  loadGoogleTokensResult: mockLoadTokensResult,
  clearGoogleTokens: mockClearTokens,
}));

vi.mock("../../src/main/calendar/offline-cache.js", () => ({
  saveOfflineCache: mockSaveCache,
  loadOfflineCache: mockLoadCache,
  clearOfflineCache: mockClearCache,
}));

vi.mock("../../src/main/composition/app-graph.js", () => ({
  createAppGraph: mockCreateAppGraph,
}));

vi.mock("../../src/main/events.js", () => ({
  mainBus: { emit: mockMainBusEmit, on: vi.fn() },
}));

vi.mock("../../src/main/utils/browser-window.js", () => ({
  SECURE_WEB_PREFERENCES: { sandbox: true, contextIsolation: true, nodeIntegration: false },
  getPreloadPath: () => "/preload",
  loadWindowContent: vi.fn(),
}));

vi.mock("../../src/main/utils/performance-trace-file.js", () => ({
  flushPerfTraceToUserData: mockFlush,
  registerPerfTraceBeforeQuitFlush: vi.fn(),
  PERF_TRACE_FILENAME: "gogmeet-perf-trace-v1.jsonl",
}));

vi.mock("../../src/main/utils/performance-trace.js", () => ({
  isPerfTraceEnabled: () => true,
  perfTrace: vi.fn(),
  _resetPerfTraceForTests: vi.fn(),
}));

describe("performance probe drivers", () => {
  let userData: string;
  const prev = process.env["GOGMEET_PERF_TRACE"];

  beforeEach(() => {
    process.env["GOGMEET_PERF_TRACE"] = "1";
    userData = mkdtempSync(join(tmpdir(), PERF_PROBE_USER_DATA_PREFIX));
    mockSetupTray.mockClear();
    mockDestroyTray.mockClear();
    mockRequestTrayRebuild.mockClear();
    mockShowAlert.mockClear();
    mockDestroyAlert.mockClear();
    mockSaveTokens.mockClear().mockResolvedValue(undefined);
    mockLoadTokensResult.mockReset().mockResolvedValue({
      kind: "ok",
      tokens: {
        authSchemaVersion: 1,
        clientId: "c",
        accessToken: "a",
        refreshToken: "r",
        expiryMs: Date.now() + 1000,
      },
    });
    mockClearTokens.mockClear().mockResolvedValue(undefined);
    mockSaveCache.mockClear().mockResolvedValue(undefined);
    mockLoadCache.mockReset().mockResolvedValue({
      version: 1,
      observedAt: Date.now(),
      cachedAt: Date.now(),
      events: [],
    });
    mockClearCache.mockClear().mockResolvedValue(undefined);
    mockFlush.mockClear().mockReturnValue({ ok: true, path: null });
    mockMainBusEmit.mockClear();
    mockCreateAppGraph.mockClear();
  });

  afterEach(() => {
    if (prev === undefined) delete process.env["GOGMEET_PERF_TRACE"];
    else process.env["GOGMEET_PERF_TRACE"] = prev;
    try {
      rmSync(userData, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it("runTrayProbe sets up tray with its single local graph and destroys tray", async () => {
    const localGraph = {
      calendar: {},
      settings: { get: () => ({ showTomorrowMeetings: true, showCompletedTodayMeetings: false }) },
      scheduler: { start: vi.fn(), stop: vi.fn(), restart: vi.fn() },
      watcher: { start: vi.fn(), stop: vi.fn(), revive: vi.fn() },
      join: {},
      opener: {},
    };
    mockCreateAppGraph.mockReturnValueOnce(localGraph);
    const { runTrayProbe } = await import("../../src/main/app/performance-probes/tray-probe.js");
    // Shrink loops by mocking sizes path — driver still runs full sizes; keep timeout ok
    await runTrayProbe(userData);
    expect(mockCreateAppGraph).toHaveBeenCalledOnce();
    expect(BrowserWindow).toHaveBeenCalledOnce();
    expect(mockSetupTray).toHaveBeenCalledTimes(1);
    expect(mockSetupTray).toHaveBeenCalledWith(
      vi.mocked(BrowserWindow).mock.instances[0],
      localGraph,
    );
    expect(localGraph.scheduler.start).not.toHaveBeenCalled();
    expect(localGraph.scheduler.stop).not.toHaveBeenCalled();
    expect(localGraph.scheduler.restart).not.toHaveBeenCalled();
    expect(localGraph.watcher.start).not.toHaveBeenCalled();
    expect(localGraph.watcher.stop).not.toHaveBeenCalled();
    expect(localGraph.watcher.revive).not.toHaveBeenCalled();
    expect(mockMainBusEmit).toHaveBeenCalled();
    expect(mockRequestTrayRebuild).toHaveBeenCalled();
    expect(mockDestroyTray).toHaveBeenCalled();
    expect(mockFlush).toHaveBeenCalled();
  }, 30_000);

  it("runAlertProbe presents synthetic alerts and force-destroys", async () => {
    const { runAlertProbe } = await import("../../src/main/app/performance-probes/alert-probe.js");
    await runAlertProbe(userData);
    expect(mockShowAlert.mock.calls.length).toBeGreaterThan(100);
    expect(mockDestroyAlert).toHaveBeenCalled();
    expect(mockFlush).toHaveBeenCalled();
  }, 30_000);

  it("runSafeStorageProbe round-trips adapters and flushes", async () => {
    const { runSafeStorageProbe } =
      await import("../../src/main/app/performance-probes/safe-storage-probe.js");
    // No enc files on disk → corrupt path skipped; cycles still run
    await runSafeStorageProbe(userData);
    expect(mockSaveTokens).toHaveBeenCalled();
    expect(mockLoadTokensResult).toHaveBeenCalled();
    expect(mockSaveCache).toHaveBeenCalled();
    expect(mockLoadCache).toHaveBeenCalled();
    expect(mockClearTokens).toHaveBeenCalled();
    expect(mockClearCache).toHaveBeenCalled();
    expect(mockFlush).toHaveBeenCalled();
  });

  it("runNamedProbeSurface dispatches tray mode", async () => {
    vi.resetModules();
    // Re-apply env after resetModules
    process.env["GOGMEET_PERF_TRACE"] = "1";
    const { runNamedProbeSurface } = await import("../../src/main/app/performance-probe.js");
    const result = await runNamedProbeSurface("tray", userData);
    expect(result.status).toBe("ok");
    expect(result).toMatchObject({ mode: "tray" });
  }, 30_000);
});
