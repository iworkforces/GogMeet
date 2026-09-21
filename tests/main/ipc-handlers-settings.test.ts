import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  mockGetSettings,
  mockUpdateSettings,
  mockRestartScheduler,
  mockForcePoll,
  mockSyncAutoLaunch,
  mockForceTrayMenuRefresh,
  mockGetSettingsWindow,
} = vi.hoisted(() => ({
  mockGetSettings: vi.fn(),
  mockUpdateSettings: vi.fn(),
  mockRestartScheduler: vi.fn(),
  mockForcePoll: vi.fn(),
  mockSyncAutoLaunch: vi.fn(),
  mockForceTrayMenuRefresh: vi.fn(),
  mockGetSettingsWindow: vi.fn(),
}));

vi.mock("../../src/main/system/auto-launch.js", () => ({
  syncAutoLaunch: mockSyncAutoLaunch,
}));
vi.mock("../../src/main/tray.js", () => ({
  forceTrayMenuRefresh: mockForceTrayMenuRefresh,
}));
vi.mock("../../src/main/windows/settings-window.js", () => ({
  getSettingsWindow: (...args: unknown[]) => mockGetSettingsWindow(...args),
  destroySettingsWindow: vi.fn(),
  createSettingsWindow: vi.fn(),
}));

import { registerSettingsHandlers } from "../../src/main/ipc-handlers/settings.js";
import { ipcMain } from "electron";
import { authorizedInvokeEvent } from "../helpers/ipc-sender.js";
import { DEFAULT_SETTINGS } from "../../src/domain/entities/settings.js";
import { testAppGraph } from "../helpers/app-graph.js";

const mockIpcMain = vi.mocked(ipcMain);

function settingsGraph() {
  return testAppGraph({
    settings: {
      get: mockGetSettings,
      update: mockUpdateSettings,
    },
    scheduler: {
      restart: mockRestartScheduler,
      forcePoll: mockForcePoll,
    },
  });
}

function getRegisteredHandler(channel: string) {
  const call = mockIpcMain.handle.mock.calls.find((c) => c[0] === channel);
  return call?.[1];
}

const authorizedEvent = authorizedInvokeEvent("index").As<import("electron").IpcMainInvokeEvent>();

describe("registerSettingsHandlers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSettings.mockReset();
    mockUpdateSettings.mockReset();
    mockRestartScheduler.mockReset();
    mockForcePoll.mockReset();
    mockGetSettingsWindow.mockReturnValue(null);
    mockGetSettings.mockReturnValue(DEFAULT_SETTINGS);
    mockUpdateSettings.mockResolvedValue(DEFAULT_SETTINGS);
  });

  it("registers 2 handlers", () => {
    const mockWin = {
      webContents: { send: vi.fn(), isDestroyed: vi.fn(() => false) },
    }.As<import("electron").BrowserWindow>();

    registerSettingsHandlers(mockWin, settingsGraph());
    expect(mockIpcMain.handle).toHaveBeenCalledTimes(2);
  });

  describe("settings:get", () => {
    it("returns current settings for authorized sender", async () => {
      registerSettingsHandlers({}.As<import("electron").BrowserWindow>(), settingsGraph());
      const handler = getRegisteredHandler("settings:get");

      const result = await handler!(authorizedEvent);
      expect(result).toEqual(DEFAULT_SETTINGS);
    });

    it("returns fresh DEFAULT_SETTINGS without calling getSettings for unauthorized sender", async () => {
      registerSettingsHandlers({}.As<import("electron").BrowserWindow>(), settingsGraph());
      const handler = getRegisteredHandler("settings:get");

      const result = await handler!(
        {
          senderFrame: { url: "https://evil.com/" },
        }.As<import("electron").IpcMainInvokeEvent>(),
      );
      expect(mockGetSettings).not.toHaveBeenCalled();
      expect(result).toEqual(DEFAULT_SETTINGS);
      expect(result).not.toBe(DEFAULT_SETTINGS);
    });
  });

  describe("settings:set", () => {
    it("updates settings and restarts scheduler", async () => {
      const updated = { ...DEFAULT_SETTINGS, openBeforeMinutes: 3 };
      mockUpdateSettings.mockResolvedValue(updated);
      const mockWin = {
        webContents: { send: vi.fn(), isDestroyed: vi.fn(() => false) },
      }.As<import("electron").BrowserWindow>();

      registerSettingsHandlers(mockWin, settingsGraph());
      const handler = getRegisteredHandler("settings:set");

      const result = await handler!(authorizedEvent, { openBeforeMinutes: 3 });
      expect(mockUpdateSettings).toHaveBeenCalledWith({ openBeforeMinutes: 3 });
      expect(mockRestartScheduler).toHaveBeenCalledOnce();
      expect(result).toEqual(updated);
    });

    it("syncs auto-launch when launchAtLogin changes", async () => {
      const updated = { ...DEFAULT_SETTINGS, launchAtLogin: true };
      mockUpdateSettings.mockResolvedValue(updated);
      const mockWin = {
        webContents: { send: vi.fn(), isDestroyed: vi.fn(() => false) },
      }.As<import("electron").BrowserWindow>();

      registerSettingsHandlers(mockWin, settingsGraph());
      const handler = getRegisteredHandler("settings:set");

      await handler!(authorizedEvent, { launchAtLogin: true });
      expect(mockSyncAutoLaunch).toHaveBeenCalledWith(true);
    });

    it("does not sync auto-launch when launchAtLogin not changed", async () => {
      const mockWin = {
        webContents: { send: vi.fn(), isDestroyed: vi.fn(() => false) },
      }.As<import("electron").BrowserWindow>();
      registerSettingsHandlers(mockWin, settingsGraph());
      const handler = getRegisteredHandler("settings:set");

      await handler!(authorizedEvent, { openBeforeMinutes: 2 });
      expect(mockSyncAutoLaunch).not.toHaveBeenCalled();
    });

    it("sends settings:changed via webContents for display-affecting changes", async () => {
      const mockWin = {
        webContents: { send: vi.fn(), isDestroyed: vi.fn(() => false) },
      }.As<import("electron").BrowserWindow>();
      const updated = { ...DEFAULT_SETTINGS, showTomorrowMeetings: false };
      mockUpdateSettings.mockResolvedValue(updated);

      registerSettingsHandlers(mockWin, settingsGraph());
      const handler = getRegisteredHandler("settings:set");

      await handler!(authorizedEvent, { showTomorrowMeetings: false });
      expect(mockWin.webContents.send).toHaveBeenCalledWith("settings:changed", updated);
    });

    it("fans out settings:changed to a distinct hide-cached Settings window", async () => {
      const popoverWin = {
        webContents: { send: vi.fn(), isDestroyed: vi.fn(() => false) },
      }.As<import("electron").BrowserWindow>();
      const settingsWin = {
        isDestroyed: vi.fn(() => false),
        webContents: { send: vi.fn(), isDestroyed: vi.fn(() => false) },
      };
      mockGetSettingsWindow.mockReturnValue(settingsWin);
      const updated = { ...DEFAULT_SETTINGS, openBeforeMinutes: 5 };
      mockUpdateSettings.mockResolvedValue(updated);

      registerSettingsHandlers(popoverWin, settingsGraph());
      const handler = getRegisteredHandler("settings:set");
      await handler!(authorizedEvent, { openBeforeMinutes: 5 });

      expect(popoverWin.webContents.send).toHaveBeenCalledWith("settings:changed", updated);
      expect(settingsWin.webContents.send).toHaveBeenCalledWith("settings:changed", updated);
    });

    it("skips settings fan-out when settings webContents is destroyed", async () => {
      const popoverWin = {
        webContents: { send: vi.fn(), isDestroyed: vi.fn(() => false) },
      }.As<import("electron").BrowserWindow>();
      mockGetSettingsWindow.mockReturnValue({
        isDestroyed: vi.fn(() => false),
        webContents: { send: vi.fn(), isDestroyed: vi.fn(() => true) },
      });
      mockUpdateSettings.mockResolvedValue({ ...DEFAULT_SETTINGS });
      registerSettingsHandlers(popoverWin, settingsGraph());
      const handler = getRegisteredHandler("settings:set");
      await handler!(authorizedEvent, { openBeforeMinutes: 1 });
      expect(popoverWin.webContents.send).toHaveBeenCalled();
    });

    it("returns fresh DEFAULT_SETTINGS and performs no side effects for unauthorized sender", async () => {
      const mockWin = {
        webContents: { send: vi.fn(), isDestroyed: vi.fn(() => false) },
      }.As<import("electron").BrowserWindow>();
      registerSettingsHandlers(mockWin, settingsGraph());
      const handler = getRegisteredHandler("settings:set");

      const result = await handler!(
        {
          senderFrame: { url: "https://evil.com/" },
        }.As<import("electron").IpcMainInvokeEvent>(),
        { openBeforeMinutes: 2 },
      );
      expect(mockUpdateSettings).not.toHaveBeenCalled();
      expect(mockRestartScheduler).not.toHaveBeenCalled();
      expect(mockSyncAutoLaunch).not.toHaveBeenCalled();
      expect(mockWin.webContents.send).not.toHaveBeenCalled();
      expect(mockGetSettings).not.toHaveBeenCalled();
      expect(result).toEqual(DEFAULT_SETTINGS);
      expect(result).not.toBe(DEFAULT_SETTINGS);
    });

    it("does not restart scheduler when only launchAtLogin changes", async () => {
      const updated = { ...DEFAULT_SETTINGS, launchAtLogin: true };
      mockUpdateSettings.mockResolvedValue(updated);
      const mockWin = {
        webContents: { send: vi.fn(), isDestroyed: vi.fn(() => false) },
      }.As<import("electron").BrowserWindow>();

      registerSettingsHandlers(mockWin, settingsGraph());
      const handler = getRegisteredHandler("settings:set");

      await handler!(authorizedEvent, { launchAtLogin: true });
      expect(mockRestartScheduler).not.toHaveBeenCalled();
      expect(mockSyncAutoLaunch).toHaveBeenCalledWith(true);
      expect(mockWin.webContents.send).toHaveBeenCalledWith("settings:changed", updated);
    });

    it("force-polls (no restart) when only showTomorrowMeetings changes", async () => {
      const updated = { ...DEFAULT_SETTINGS, showTomorrowMeetings: false };
      mockUpdateSettings.mockResolvedValue(updated);
      const mockWin = {
        webContents: { send: vi.fn(), isDestroyed: vi.fn(() => false) },
      }.As<import("electron").BrowserWindow>();

      registerSettingsHandlers(mockWin, settingsGraph());
      const handler = getRegisteredHandler("settings:set");

      await handler!(authorizedEvent, { showTomorrowMeetings: false });
      expect(mockRestartScheduler).not.toHaveBeenCalled();
      expect(mockForcePoll).toHaveBeenCalledOnce();
    });

    it("persists and broadcasts showCompletedTodayMeetings without scheduler work", async () => {
      const updated = { ...DEFAULT_SETTINGS, showCompletedTodayMeetings: true };
      mockUpdateSettings.mockResolvedValue(updated);
      const mockWin = {
        webContents: { send: vi.fn(), isDestroyed: vi.fn(() => false) },
      }.As<import("electron").BrowserWindow>();

      registerSettingsHandlers(mockWin, settingsGraph());
      const handler = getRegisteredHandler("settings:set");

      const result = await handler!(authorizedEvent, { showCompletedTodayMeetings: true });
      expect(mockUpdateSettings).toHaveBeenCalledWith({ showCompletedTodayMeetings: true });
      expect(result).toEqual(updated);
      expect(mockWin.webContents.send).toHaveBeenCalledWith("settings:changed", updated);
      expect(mockWin.webContents.send).toHaveBeenCalledTimes(1);
      expect(mockRestartScheduler).not.toHaveBeenCalled();
      expect(mockForcePoll).not.toHaveBeenCalled();
      expect(mockSyncAutoLaunch).not.toHaveBeenCalled();
      // Tray is the primary meeting list UI — rebuild immediately so history appears.
      expect(mockForceTrayMenuRefresh).toHaveBeenCalledOnce();
    });

    it("returns current settings when update throws", async () => {
      mockUpdateSettings.mockRejectedValue(new Error("disk full"));
      mockGetSettings.mockReturnValue(DEFAULT_SETTINGS);
      const mockWin = {
        webContents: { send: vi.fn(), isDestroyed: vi.fn(() => false) },
      }.As<import("electron").BrowserWindow>();

      registerSettingsHandlers(mockWin, settingsGraph());
      const handler = getRegisteredHandler("settings:set");

      const result = await handler!(authorizedEvent, { showCompletedTodayMeetings: true });
      expect(result).toEqual(DEFAULT_SETTINGS);
      expect(mockWin.webContents.send).not.toHaveBeenCalled();
      expect(mockForceTrayMenuRefresh).not.toHaveBeenCalled();
    });

    it("restarts scheduler for quiet hours and auto-open timing keys", async () => {
      const mockWin = {
        webContents: { send: vi.fn(), isDestroyed: vi.fn(() => false) },
      }.As<import("electron").BrowserWindow>();
      mockUpdateSettings.mockResolvedValue(DEFAULT_SETTINGS);
      registerSettingsHandlers(mockWin, settingsGraph());
      const handler = getRegisteredHandler("settings:set");

      await handler!(authorizedEvent, { quietHoursEnabled: true });
      expect(mockRestartScheduler).toHaveBeenCalledOnce();
      mockRestartScheduler.mockClear();

      await handler!(authorizedEvent, { autoOpenEnabled: false });
      expect(mockRestartScheduler).toHaveBeenCalledOnce();
    });
  });
});
