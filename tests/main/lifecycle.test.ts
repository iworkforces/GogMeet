import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppGraph } from "../../src/main/composition/app-graph.js";
import { createMockSettings } from "../helpers/test-utils.js";

type PowerReason = "battery" | "ac" | "resume" | "unlock";

const {
  displayHorizonListeners,
  powerCallbacks,
  mockGraph,
  mockCreateAppGraph,
  mockRegisterIpcHandlers,
  mockSetupTray,
  mockForceTrayMenuRefresh,
  mockUpdateTrayTitle,
  mockSyncAutoLaunch,
  mockCheckNotificationPermission,
  mockRegisterShortcuts,
  mockUnregisterShortcuts,
  mockInitPowerManagement,
  mockCleanupPowerManagement,
  mockGetPollInterval,
  mockPreventSleep,
  mockAllowSleep,
  mockInitAutoUpdater,
  mockOnDisplayHorizonTick,
  mockUnsubscribeDisplayHorizon,
  mockClearDisplayHorizon,
  mockDestroyAlertWindow,
  mockDestroySettingsWindow,
  mockDestroyAboutWindow,
  mockDestroyUpdateWindow,
} = vi.hoisted(() => {
  const displayHorizonListeners: Array<() => void> = [];
  const powerCallbacks: Array<(reason: PowerReason) => void> = [];
  const mockUnsubscribeDisplayHorizon = vi.fn();
  const mockGraph = {
    calendar: {
      getEvents: vi.fn(),
      getEventsResult: vi.fn(),
      requestPermission: vi.fn(),
      getPermissionStatus: vi.fn(),
      disconnect: vi.fn(),
      getUiState: vi.fn(),
      warmup: vi.fn(),
      invalidatePermissionCache: vi.fn(),
      shouldAutoRequestPermission: vi.fn(),
      reportPollError: vi.fn(),
    },
    settings: {
      load: vi.fn(),
      get: vi.fn(),
      update: vi.fn(),
      save: vi.fn(),
    },
    scheduler: {
      forcePoll: vi.fn(),
      getLastKnownEvents: vi.fn(),
      republishUiForDisplayTick: vi.fn(),
      cancelPendingBrowserOpen: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(),
      restart: vi.fn(),
      setWindow: vi.fn(),
      setTrayTitleCallback: vi.fn(),
      initPowerCallbacks: vi.fn(),
    },
    watcher: {
      start: vi.fn(),
      stop: vi.fn(),
      revive: vi.fn(),
    },
    join: { byId: vi.fn() },
    opener: { open: vi.fn() },
  } satisfies AppGraph;

  return {
    displayHorizonListeners,
    powerCallbacks,
    mockGraph,
    mockCreateAppGraph: vi.fn(() => mockGraph),
    mockRegisterIpcHandlers: vi.fn(),
    mockSetupTray: vi.fn(),
    mockForceTrayMenuRefresh: vi.fn(),
    mockUpdateTrayTitle: vi.fn(),
    mockSyncAutoLaunch: vi.fn(),
    mockCheckNotificationPermission: vi.fn(),
    mockRegisterShortcuts: vi.fn(),
    mockUnregisterShortcuts: vi.fn(),
    mockInitPowerManagement: vi.fn((callback: (reason: PowerReason) => void) => {
      powerCallbacks.push(callback);
    }),
    mockCleanupPowerManagement: vi.fn(),
    mockGetPollInterval: vi.fn(() => 120_000),
    mockPreventSleep: vi.fn(),
    mockAllowSleep: vi.fn(),
    mockInitAutoUpdater: vi.fn(),
    mockOnDisplayHorizonTick: vi.fn((listener: () => void) => {
      displayHorizonListeners.push(listener);
      return mockUnsubscribeDisplayHorizon;
    }),
    mockUnsubscribeDisplayHorizon,
    mockClearDisplayHorizon: vi.fn(),
    mockDestroyAlertWindow: vi.fn(),
    mockDestroySettingsWindow: vi.fn(),
    mockDestroyAboutWindow: vi.fn(),
    mockDestroyUpdateWindow: vi.fn(),
  };
});

vi.mock("../../src/main/composition/app-graph.js", () => ({
  createAppGraph: mockCreateAppGraph,
}));

vi.mock("../../src/main/app/ipc.js", () => ({
  registerIpcHandlers: mockRegisterIpcHandlers,
}));

vi.mock("../../src/main/tray.js", () => ({
  setupTray: mockSetupTray,
  forceTrayMenuRefresh: mockForceTrayMenuRefresh,
  updateTrayTitle: mockUpdateTrayTitle,
}));

vi.mock("../../src/main/system/auto-launch.js", () => ({
  syncAutoLaunch: mockSyncAutoLaunch,
}));

vi.mock("../../src/main/system/notification.js", () => ({
  checkNotificationPermission: mockCheckNotificationPermission,
}));

vi.mock("../../src/main/system/shortcuts.js", () => ({
  registerShortcuts: mockRegisterShortcuts,
  unregisterShortcuts: mockUnregisterShortcuts,
}));

vi.mock("../../src/main/system/power.js", () => ({
  initPowerManagement: mockInitPowerManagement,
  initPowerEvents: vi.fn(),
  cleanupPowerManagement: mockCleanupPowerManagement,
  getPollInterval: mockGetPollInterval,
  preventSleep: mockPreventSleep,
  allowSleep: mockAllowSleep,
}));

vi.mock("../../src/main/system/display-horizon.js", () => ({
  onDisplayHorizonTick: mockOnDisplayHorizonTick,
  clearDisplayHorizon: mockClearDisplayHorizon,
}));

vi.mock("../../src/main/system/auto-updater.js", () => ({
  initAutoUpdater: mockInitAutoUpdater,
}));

vi.mock("../../src/main/windows/alert-window.js", () => ({
  destroyAlertWindow: mockDestroyAlertWindow,
}));

vi.mock("../../src/main/windows/settings-window.js", () => ({
  destroySettingsWindow: mockDestroySettingsWindow,
}));

vi.mock("../../src/main/windows/about-window.js", () => ({
  destroyAboutWindow: mockDestroyAboutWindow,
}));

vi.mock("../../src/main/windows/update-window.js", () => ({
  destroyUpdateWindow: mockDestroyUpdateWindow,
}));

import { initializeApp, shutdownApp } from "../../src/main/app/lifecycle.js";

const mockWindow = {}.As<import("electron").BrowserWindow>();

function latestPowerCallback(): (reason: PowerReason) => void {
  const callback = powerCallbacks.at(-1);
  if (!callback) throw new Error("Expected lifecycle to register a power callback");
  return callback;
}

function latestDisplayHorizonListener(): () => void {
  const listener = displayHorizonListeners.at(-1);
  if (!listener) throw new Error("Expected lifecycle to register a display-horizon listener");
  return listener;
}

describe("lifecycle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    displayHorizonListeners.length = 0;
    powerCallbacks.length = 0;
    mockGraph.calendar.getPermissionStatus.mockResolvedValue("granted");
    mockGraph.calendar.requestPermission.mockResolvedValue("granted");
    mockGraph.calendar.shouldAutoRequestPermission.mockReturnValue(true);
    mockGraph.calendar.warmup.mockResolvedValue(undefined);
    mockGraph.settings.load.mockResolvedValue({ ok: true, value: createMockSettings() });
    mockGraph.settings.get.mockReturnValue(createMockSettings());
    mockGraph.scheduler.forcePoll.mockResolvedValue(null);
  });

  afterEach(() => {
    shutdownApp();
  });

  describe("initializeApp", () => {
    it("initializes every graph-owned subsystem through the created graph", async () => {
      await initializeApp(mockWindow);

      expect(mockCreateAppGraph).toHaveBeenCalledOnce();
      expect(mockGraph.calendar.warmup).toHaveBeenCalledOnce();
      expect(mockRegisterIpcHandlers).toHaveBeenCalledWith(mockWindow, mockGraph);
      expect(mockGraph.settings.load).toHaveBeenCalledOnce();
      expect(mockGraph.calendar.getPermissionStatus).toHaveBeenCalledOnce();
      expect(mockSetupTray).toHaveBeenCalledWith(mockWindow, mockGraph);
      expect(mockGraph.scheduler.setTrayTitleCallback).toHaveBeenCalledWith(mockUpdateTrayTitle);
      expect(mockGraph.scheduler.setWindow).toHaveBeenCalledWith(mockWindow);
      expect(mockGraph.scheduler.initPowerCallbacks).toHaveBeenCalledWith({
        getPollInterval: mockGetPollInterval,
        preventSleep: mockPreventSleep,
        allowSleep: mockAllowSleep,
      });
      expect(mockGraph.scheduler.start).toHaveBeenCalledOnce();
      expect(mockGraph.watcher.start).toHaveBeenCalledOnce();
      expect(mockRegisterShortcuts).toHaveBeenCalledWith(mockGraph);
      expect(mockCheckNotificationPermission).toHaveBeenCalledOnce();
      expect(mockSyncAutoLaunch).toHaveBeenCalledWith(false);
      expect(mockInitAutoUpdater).toHaveBeenCalledOnce();
    });

    it("requests calendar permission when not determined and auto-request is allowed", async () => {
      mockGraph.calendar.getPermissionStatus.mockResolvedValueOnce("not-determined");

      await initializeApp(mockWindow);

      expect(mockGraph.calendar.requestPermission).toHaveBeenCalledOnce();
      expect(mockGraph.scheduler.start).toHaveBeenCalledOnce();
    });

    it("does not auto-request calendar permission when the graph disallows it", async () => {
      mockGraph.calendar.getPermissionStatus.mockResolvedValueOnce("not-determined");
      mockGraph.calendar.shouldAutoRequestPermission.mockReturnValueOnce(false);

      await initializeApp(mockWindow);

      expect(mockGraph.calendar.requestPermission).not.toHaveBeenCalled();
      expect(mockGraph.scheduler.start).toHaveBeenCalledOnce();
    });

    it.each(["granted", "denied"] as const)(
      "does not request calendar permission when status is %s",
      async (permission) => {
        mockGraph.calendar.getPermissionStatus.mockResolvedValueOnce(permission);

        await initializeApp(mockWindow);

        expect(mockGraph.calendar.requestPermission).not.toHaveBeenCalled();
      },
    );

    it("syncs auto-launch with graph settings", async () => {
      mockGraph.settings.get.mockReturnValueOnce(createMockSettings({ launchAtLogin: true }));

      await initializeApp(mockWindow);

      expect(mockSyncAutoLaunch).toHaveBeenCalledWith(true);
    });

    it("republishes through the created graph before forcing the tray refresh", async () => {
      const callOrder: string[] = [];
      mockGraph.scheduler.republishUiForDisplayTick.mockImplementationOnce(() => {
        callOrder.push("republish");
      });
      mockForceTrayMenuRefresh.mockImplementationOnce(() => {
        callOrder.push("tray");
      });
      await initializeApp(mockWindow);

      latestDisplayHorizonListener()();

      expect(mockGraph.scheduler.republishUiForDisplayTick).toHaveBeenCalledOnce();
      expect(mockForceTrayMenuRefresh).toHaveBeenCalledOnce();
      expect(callOrder).toEqual(["republish", "tray"]);
    });
  });

  describe("power callback", () => {
    it("invalidates, revives, and polls the created graph on resume", async () => {
      const callOrder: string[] = [];
      mockGraph.calendar.invalidatePermissionCache.mockImplementationOnce(() => {
        callOrder.push("invalidate");
      });
      mockGraph.watcher.revive.mockImplementationOnce(() => {
        callOrder.push("revive");
      });
      mockGraph.scheduler.forcePoll.mockImplementationOnce(async () => {
        callOrder.push("forcePoll");
        return null;
      });
      await initializeApp(mockWindow);

      latestPowerCallback()("resume");

      expect(mockGraph.scheduler.forcePoll).toHaveBeenCalledWith({ reason: "power" });
      expect(mockGraph.scheduler.restart).not.toHaveBeenCalled();
      expect(callOrder).toEqual(["invalidate", "revive", "forcePoll"]);
    });

    it("polls the created graph on battery changes without invalidating permission", async () => {
      await initializeApp(mockWindow);

      latestPowerCallback()("battery");

      expect(mockGraph.scheduler.forcePoll).toHaveBeenCalledWith({ reason: "power" });
      expect(mockGraph.calendar.invalidatePermissionCache).not.toHaveBeenCalled();
      expect(mockGraph.watcher.revive).not.toHaveBeenCalled();
      expect(mockGraph.scheduler.restart).not.toHaveBeenCalled();
    });
  });

  describe("fail-fast", () => {
    it("aborts before scheduler start when tray setup throws", async () => {
      const electron = await import("electron");
      mockSetupTray.mockImplementationOnce(() => {
        throw new Error("tray boom");
      });

      await initializeApp(mockWindow);

      expect(electron.dialog.showErrorBox).toHaveBeenCalledWith(
        "GogMeet Startup Error",
        expect.stringContaining("setupTray"),
      );
      expect(electron.app.quit).toHaveBeenCalled();
      expect(mockGraph.scheduler.start).not.toHaveBeenCalled();
    });

    it("aborts before scheduler start when settings load throws", async () => {
      const electron = await import("electron");
      mockGraph.settings.load.mockRejectedValueOnce(new Error("fs boom"));

      await initializeApp(mockWindow);

      expect(electron.dialog.showErrorBox).toHaveBeenCalledWith(
        "GogMeet Startup Error",
        expect.stringContaining("loadSettings"),
      );
      expect(electron.app.quit).toHaveBeenCalled();
      expect(mockGraph.scheduler.start).not.toHaveBeenCalled();
    });
  });

  describe("shutdownApp", () => {
    it("stops the same graph after process and window cleanup", async () => {
      const callOrder: string[] = [];
      await initializeApp(mockWindow);
      mockCleanupPowerManagement.mockImplementationOnce(() => callOrder.push("power"));
      mockUnsubscribeDisplayHorizon.mockImplementationOnce(() =>
        callOrder.push("unsubscribe-horizon"),
      );
      mockClearDisplayHorizon.mockImplementationOnce(() => callOrder.push("clear-horizon"));
      mockDestroyAlertWindow.mockImplementationOnce(() => callOrder.push("destroy-alert"));
      mockDestroySettingsWindow.mockImplementationOnce(() => callOrder.push("destroy-settings"));
      mockDestroyAboutWindow.mockImplementationOnce(() => callOrder.push("destroy-about"));
      mockDestroyUpdateWindow.mockImplementationOnce(() => callOrder.push("destroy-update"));
      mockGraph.scheduler.stop.mockImplementationOnce(() => callOrder.push("stop-scheduler"));
      mockGraph.watcher.stop.mockImplementationOnce(() => callOrder.push("stop-watcher"));
      mockUnregisterShortcuts.mockImplementationOnce(() => callOrder.push("unregister-shortcuts"));

      shutdownApp();

      expect(callOrder).toEqual([
        "power",
        "unsubscribe-horizon",
        "clear-horizon",
        "destroy-alert",
        "destroy-settings",
        "destroy-about",
        "destroy-update",
        "stop-scheduler",
        "stop-watcher",
        "unregister-shortcuts",
      ]);
      expect(mockGraph.scheduler.stop).toHaveBeenCalledOnce();
      expect(mockGraph.watcher.stop).toHaveBeenCalledOnce();

      shutdownApp();
      expect(mockGraph.scheduler.stop).toHaveBeenCalledOnce();
      expect(mockGraph.watcher.stop).toHaveBeenCalledOnce();
    });

    it("keeps graph-owned teardown a no-op before initialization", () => {
      shutdownApp();

      expect(mockCleanupPowerManagement).toHaveBeenCalledOnce();
      expect(mockDestroyAlertWindow).toHaveBeenCalledOnce();
      expect(mockDestroySettingsWindow).toHaveBeenCalledOnce();
      expect(mockDestroyAboutWindow).toHaveBeenCalledOnce();
      expect(mockDestroyUpdateWindow).toHaveBeenCalledOnce();
      expect(mockGraph.scheduler.stop).not.toHaveBeenCalled();
      expect(mockGraph.watcher.stop).not.toHaveBeenCalled();
      expect(mockUnregisterShortcuts).toHaveBeenCalledOnce();
    });
  });
});
