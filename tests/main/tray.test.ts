import { describe, it, expect, vi, beforeEach } from "vitest";
import type { MeetingEvent } from "../../src/domain/entities/meeting-event.js";
import { DEFAULT_SETTINGS } from "../../src/domain/entities/settings.js";
import type { AppGraphOverrides } from "../../src/main/composition/app-graph.js";
import { createMockEvent as createSharedMockEvent, asTestIsoUtc } from "../helpers/test-utils.js";
import { testAppGraph } from "../helpers/app-graph.js";

type MockTrayInstance = {
  setToolTip: ReturnType<typeof vi.fn>;
  setTitle: ReturnType<typeof vi.fn>;
  setImage: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  getBounds: ReturnType<typeof vi.fn>;
  popUpContextMenu: ReturnType<typeof vi.fn>;
  setContextMenu: ReturnType<typeof vi.fn>;
  destroy: ReturnType<typeof vi.fn>;
};

vi.mock("electron", () => ({
  Tray: vi.fn().mockImplementation(function (this: MockTrayInstance) {
    this.setToolTip = vi.fn();
    this.setTitle = vi.fn();
    this.setImage = vi.fn();
    this.on = vi.fn();
    this.getBounds = vi.fn().mockReturnValue({ x: 100, y: 0, width: 22, height: 22 });
    this.popUpContextMenu = vi.fn();
    this.setContextMenu = vi.fn();
    this.destroy = vi.fn();
  }),
  Menu: { buildFromTemplate: vi.fn().mockReturnValue({}) },
  shell: { openExternal: vi.fn().mockResolvedValue(undefined) },
  app: { quit: vi.fn(), showAboutPanel: vi.fn(), once: vi.fn() },
  nativeImage: {
    createFromPath: vi.fn().mockReturnValue({
      toPNG: vi.fn().mockReturnValue(Buffer.alloc(0)),
      isEmpty: vi.fn().mockReturnValue(false),
    }),
    createEmpty: vi
      .fn()
      .mockReturnValue({ addRepresentation: vi.fn(), isEmpty: vi.fn().mockReturnValue(true) }),
  },
  nativeTheme: { shouldUseDarkColors: false, on: vi.fn(), removeListener: vi.fn() },
  BrowserWindow: vi.fn().mockImplementation(function (this: { on: ReturnType<typeof vi.fn> }) {
    this.on = vi.fn();
  }),
}));

vi.mock("../../src/domain/services/build-meet-url.js", () => ({
  buildMeetUrl: vi.fn((event: MeetingEvent) => event.meetUrl || ""),
}));

vi.mock("../../src/main/windows/about-window.js", () => ({
  showAbout: vi.fn(),
}));

const platformState = vi.hoisted(() => ({ darwin: true }));

vi.mock("../../src/main/platform/os.js", () => ({
  isDarwin: () => platformState.darwin,
  isWin32: () => !platformState.darwin,
}));

// Helper to create mock event
function createMockEvent(overrides: Partial<MeetingEvent> = {}): MeetingEvent {
  const now = new Date();
  const in1Hour = new Date(now.getTime() + 60 * 60 * 1000);
  return createSharedMockEvent({
    startDate: asTestIsoUtc(now.toISOString()),
    endDate: asTestIsoUtc(in1Hour.toISOString()),
    ...overrides,
  });
}

function createTrayGraph(overrides: AppGraphOverrides = {}) {
  return testAppGraph({
    ...overrides,
    calendar: {
      getEvents: vi.fn().mockResolvedValue({
        publicationGeneration: 1,
        result: {
          kind: "ok",
          source: "live",
          completeness: "complete",
          observedAt: Date.now(),
          events: [],
        },
      }),
      requestPermission: vi.fn().mockResolvedValue("granted"),
      getPermissionStatus: vi.fn().mockResolvedValue("not-determined"),
      disconnect: vi.fn().mockResolvedValue(undefined),
      getUiState: vi.fn().mockReturnValue({
        permission: "not-determined",
        phase: "disconnected",
        lastError: null,
        accountEmail: null,
        events: null,
        offline: false,
        oauthConfigured: false,
        darwinPartialRefreshDiagnostics: null,
        cacheAgeMs: null,
      }),
      ...overrides.calendar,
    },
    settings: {
      get: vi.fn().mockReturnValue({ ...DEFAULT_SETTINGS }),
      ...overrides.settings,
    },
    scheduler: {
      forcePoll: vi.fn().mockResolvedValue(null),
      ...overrides.scheduler,
    },
  });
}

function isMockTrayInstance(value: unknown): value is MockTrayInstance {
  if (typeof value !== "object" || value === null) return false;
  return "setToolTip" in value && "setContextMenu" in value;
}

function getLatestTrayInstance(Tray: typeof import("electron").Tray): MockTrayInstance {
  const results = vi.mocked(Tray).mock.results;
  const latestResult = results[results.length - 1];
  if (!latestResult || latestResult.type === "throw" || !isMockTrayInstance(latestResult.value)) {
    throw new Error("Tray was not constructed by the test setup");
  }
  return latestResult.value;
}

// Pure function tests - formatRemainingTime
describe("formatRemainingTime", () => {
  let formatRemainingTime: (totalMins: number) => string;

  beforeEach(async () => {
    vi.resetModules();
    const timeModule = await import("../../src/domain/services/time.js");
    formatRemainingTime = timeModule.formatRemainingTime;
  });

  it("returns '0m' for zero or negative minutes", () => {
    expect(formatRemainingTime(0)).toBe("0m");
    expect(formatRemainingTime(-1)).toBe("0m");
    expect(formatRemainingTime(-100)).toBe("0m");
  });

  it("formats minutes only when < 60", () => {
    expect(formatRemainingTime(1)).toBe("1m");
    expect(formatRemainingTime(30)).toBe("30m");
    expect(formatRemainingTime(59)).toBe("59m");
  });

  it("formats hours only when exactly on the hour", () => {
    expect(formatRemainingTime(60)).toBe("1h");
    expect(formatRemainingTime(120)).toBe("2h");
    expect(formatRemainingTime(180)).toBe("3h");
  });

  it("formats hours and minutes when both present", () => {
    expect(formatRemainingTime(61)).toBe("1h 1m");
    expect(formatRemainingTime(90)).toBe("1h 30m");
    expect(formatRemainingTime(125)).toBe("2h 5m");
    expect(formatRemainingTime(3665)).toBe("61h 5m");
  });

  it("formats 0 as '0m'", () => {
    expect(formatRemainingTime(0)).toBe("0m");
  });
});

/** Flush the microtask-coalesced tray rebuild scheduled by requestTrayRebuild. */
async function flushTrayRebuild(): Promise<void> {
  await Promise.resolve();
}

// Tray module exports
describe("tray module exports", () => {
  beforeEach(() => {
    vi.resetModules();
    platformState.darwin = true;
  });

  it("exports setupTray and updateTrayTitle functions", async () => {
    const trayModule = await import("../../src/main/tray.js");

    expect(typeof trayModule.setupTray).toBe("function");
    expect(typeof trayModule.updateTrayTitle).toBe("function");
    expect(typeof trayModule.truncateTrayTooltip).toBe("function");
    expect(typeof trayModule.buildWindowsTrayTooltip).toBe("function");
    expect(typeof trayModule.formatTrayCountdownLabel).toBe("function");
  });

  it("truncateTrayTooltip caps length with ellipsis", async () => {
    const { truncateTrayTooltip } = await import("../../src/main/tray.js");
    expect(truncateTrayTooltip("short")).toBe("short");
    expect(truncateTrayTooltip("a".repeat(70), 10)).toBe("aaaaaaaaa\u2026");
  });

  it("formatTrayCountdownLabel covers 1-min, plural, and in-meeting remaining", async () => {
    const { formatTrayCountdownLabel } = await import("../../src/main/tray.js");
    expect(formatTrayCountdownLabel("Standup", 1)).toBe("Standup in 1 min");
    expect(formatTrayCountdownLabel("Standup", 3)).toBe("Standup in 3 mins");
    expect(formatTrayCountdownLabel("Standup", 5, true)).toMatch(/Standup/);
    expect(formatTrayCountdownLabel("Standup", 5, true)).not.toContain("in 5 min");
    const longTitle = "A".repeat(20);
    expect(formatTrayCountdownLabel(longTitle, 2).startsWith("A".repeat(12) + "\u2026")).toBe(true);
  });

  it("buildWindowsTrayTooltip formats idle, offline, and countdown", async () => {
    const { buildWindowsTrayTooltip, TRAY_TOOLTIP_MAX_CHARS } =
      await import("../../src/main/tray.js");
    expect(buildWindowsTrayTooltip(null)).toBe("GogMeet");
    expect(buildWindowsTrayTooltip(null, undefined, undefined, true)).toBe("GogMeet — Offline");
    expect(buildWindowsTrayTooltip("Standup", 15)).toBe("GogMeet — Standup in 15 mins");
    expect(buildWindowsTrayTooltip("Standup", 5, true)).toMatch(/GogMeet — Standup/);
    const long = buildWindowsTrayTooltip("A".repeat(80), 5);
    expect(long.length).toBeLessThanOrEqual(TRAY_TOOLTIP_MAX_CHARS);
  });

  it("setupTray creates a Tray instance", async () => {
    const { setupTray } = await import("../../src/main/tray.js");
    const { Tray } = await import("electron");

    const mockWindow = {} as Parameters<typeof setupTray>[0];
    setupTray(mockWindow, createTrayGraph());

    expect(Tray).toHaveBeenCalled();
  });

  it("setupTray sets tooltip to 'Google Meet'", async () => {
    const { setupTray } = await import("../../src/main/tray.js");
    const { Tray } = await import("electron");

    const mockWindow = {} as Parameters<typeof setupTray>[0];
    setupTray(mockWindow, createTrayGraph());

    const trayInstance = getLatestTrayInstance(Tray);
    expect(trayInstance.setToolTip).toHaveBeenCalledWith("GogMeet");
  });

  it("setupTray registers nativeTheme.on('updated') handler", async () => {
    const { setupTray } = await import("../../src/main/tray.js");
    const { nativeTheme } = await import("electron");

    const mockWindow = {} as Parameters<typeof setupTray>[0];
    setupTray(mockWindow, createTrayGraph());

    expect(nativeTheme.on).toHaveBeenCalledWith("updated", expect.any(Function));
  });

  it("registers before-quit handler only once even when setupTray is called multiple times", async () => {
    const { setupTray } = await import("../../src/main/tray.js");
    const { app } = await import("electron");

    // Clear accumulated calls from prior tests in this file before counting
    vi.mocked(app.once).mockClear();

    const mockWindow = {} as Parameters<typeof setupTray>[0];
    setupTray(mockWindow, createTrayGraph()); // First call: registers before-quit
    setupTray(mockWindow, createTrayGraph()); // Second call: should skip

    const beforeQuitCalls = vi
      .mocked(app.once)
      .mock.calls.filter((c: unknown[]) => c[0] === "before-quit");
    expect(beforeQuitCalls).toHaveLength(1);
  });

  it("installs a context menu during setup so the first tray click has a menu", async () => {
    const { setupTray } = await import("../../src/main/tray.js");
    const { BrowserWindow, Menu, Tray } = await import("electron");

    // Given: the tray is being created before any calendar cache has arrived.
    const mockWindow = new BrowserWindow();

    // When: setup registers the tray item.
    setupTray(mockWindow, createTrayGraph());
    await flushTrayRebuild();

    // Then: the native tray menu is already installed for the first status-item activation.
    const trayInstance = getLatestTrayInstance(Tray);
    expect(Menu.buildFromTemplate).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ label: "No upcoming meetings", enabled: false }),
        expect.objectContaining({ label: "Refresh" }),
      ]),
    );
    expect(trayInstance.setContextMenu).toHaveBeenCalledWith({});
  });

  it("refreshes the installed context menu when cached meetings change", async () => {
    const { setupTray } = await import("../../src/main/tray.js");
    const { mainBus } = await import("../../src/main/events.js");
    const { BrowserWindow, Tray } = await import("electron");

    // Given: a tray exists with its initial loading menu installed.
    const mockWindow = new BrowserWindow();
    setupTray(mockWindow, createTrayGraph());
    await flushTrayRebuild();
    const trayInstance = getLatestTrayInstance(Tray);
    vi.mocked(trayInstance.setContextMenu).mockClear();

    // When: the scheduler publishes fresh cached meetings.
    mainBus.emit("meeting-list-updated", [createMockEvent()]);
    await flushTrayRebuild();

    // Then: the already-installed native menu is rebuilt for the next click.
    expect(trayInstance.setContextMenu).toHaveBeenCalledWith({});
  });

  it("on Windows left-click forcePolls and popUpContextMenu", async () => {
    platformState.darwin = false;
    const { setupTray } = await import("../../src/main/tray.js");
    const { BrowserWindow, Tray, Menu } = await import("electron");

    const forcePoll = vi.fn().mockResolvedValue(null);
    const mockWindow = new BrowserWindow();
    setupTray(mockWindow, createTrayGraph({ scheduler: { forcePoll } }));
    await flushTrayRebuild();
    const trayInstance = getLatestTrayInstance(Tray);

    const clickHandler = vi
      .mocked(trayInstance.on)
      .mock.calls.find((c) => c[0] === "click")?.[1] as (() => void) | undefined;
    expect(clickHandler).toBeTypeOf("function");
    vi.mocked(Menu.buildFromTemplate).mockClear();
    clickHandler?.();

    expect(forcePoll).toHaveBeenCalledWith({ reason: "auto" });
    // Sync rebuild-from-cache before popup so ended meetings are not shown stale.
    expect(Menu.buildFromTemplate).toHaveBeenCalled();
    expect(trayInstance.popUpContextMenu).toHaveBeenCalled();
  });

  it("on Darwin left-click forcePolls without popUpContextMenu", async () => {
    platformState.darwin = true;
    const { setupTray } = await import("../../src/main/tray.js");
    const { BrowserWindow, Tray } = await import("electron");

    const forcePoll = vi.fn().mockResolvedValue(null);
    const mockWindow = new BrowserWindow();
    setupTray(mockWindow, createTrayGraph({ scheduler: { forcePoll } }));
    const trayInstance = getLatestTrayInstance(Tray);
    vi.mocked(trayInstance.popUpContextMenu).mockClear();

    const clickHandler = vi
      .mocked(trayInstance.on)
      .mock.calls.find((c) => c[0] === "click")?.[1] as (() => void) | undefined;
    clickHandler?.();

    expect(forcePoll).toHaveBeenCalledWith({ reason: "auto" });
    expect(trayInstance.popUpContextMenu).not.toHaveBeenCalled();
  });

  it("updateTrayTitle sets Darwin title and Windows tooltip", async () => {
    platformState.darwin = true;
    const { setupTray, updateTrayTitle } = await import("../../src/main/tray.js");
    const { Tray } = await import("electron");
    const mockWindow = {} as Parameters<typeof setupTray>[0];
    setupTray(mockWindow, createTrayGraph());
    const trayInstance = getLatestTrayInstance(Tray);
    updateTrayTitle("Standup Meeting Title", 12, false);
    expect(trayInstance.setTitle).toHaveBeenCalled();
    updateTrayTitle(null);
    expect(trayInstance.setTitle).toHaveBeenCalledWith("");

    platformState.darwin = false;
    vi.resetModules();
    const tray2 = await import("../../src/main/tray.js");
    const electron = await import("electron");
    tray2.setupTray({} as never, createTrayGraph());
    const inst = getLatestTrayInstance(electron.Tray);
    tray2.updateTrayTitle("Win Meet", 5, true);
    expect(inst.setToolTip).toHaveBeenCalled();
    tray2.destroyTray();
  });

  it("destroyTray removes listeners and is idempotent", async () => {
    vi.resetModules();
    const { setupTray, destroyTray } = await import("../../src/main/tray.js");
    const { Tray, nativeTheme } = await import("electron");
    vi.mocked(nativeTheme.on).mockClear();
    vi.mocked(nativeTheme.removeListener).mockClear();
    const mockWindow = {} as Parameters<typeof setupTray>[0];
    setupTray(mockWindow, createTrayGraph());
    const trayInstance = getLatestTrayInstance(Tray);
    trayInstance.destroy = vi.fn();
    const themeCalls = vi.mocked(nativeTheme.on).mock.calls.filter((c) => c[0] === "updated");
    const themeHandler = themeCalls[themeCalls.length - 1]?.[1];
    expect(themeHandler).toBeTypeOf("function");
    destroyTray();
    expect(trayInstance.destroy).toHaveBeenCalled();
    expect(nativeTheme.removeListener).toHaveBeenCalledWith("updated", themeHandler);
    destroyTray();
  });

  it("forceTrayMenuRefresh no-ops before setup and rebuilds after setupTray", async () => {
    vi.resetModules();
    const { forceTrayMenuRefresh, setupTray, destroyTray } = await import("../../src/main/tray.js");
    const { Tray, Menu } = await import("electron");
    // No tray yet — must not throw.
    forceTrayMenuRefresh();
    setupTray({} as never, createTrayGraph());
    await flushTrayRebuild();
    const trayInstance = getLatestTrayInstance(Tray);
    vi.mocked(trayInstance.setContextMenu).mockClear();
    vi.mocked(Menu.buildFromTemplate).mockClear();
    forceTrayMenuRefresh();
    await flushTrayRebuild();
    expect(Menu.buildFromTemplate).toHaveBeenCalled();
    expect(trayInstance.setContextMenu).toHaveBeenCalled();
    destroyTray();
    forceTrayMenuRefresh(); // after destroy — still no throw
  });

  it("status listener rebuilds menu and offline tooltip on Windows", async () => {
    platformState.darwin = false;
    const { setupTray } = await import("../../src/main/tray.js");
    const { mainBus } = await import("../../src/main/events.js");
    const { Tray } = await import("electron");
    setupTray({} as never, createTrayGraph());
    await flushTrayRebuild();
    const trayInstance = getLatestTrayInstance(Tray);
    vi.mocked(trayInstance.setContextMenu).mockClear();
    mainBus.emit("calendar-status-updated", {
      permission: "granted",
      phase: "ready",
      lastError: null,
      accountEmail: "u@example.com",
      events: [createMockEvent()],
      offline: true,
      oauthConfigured: true,
      darwinPartialRefreshDiagnostics: null,
      cacheAgeMs: null,
    });
    await flushTrayRebuild();
    expect(trayInstance.setContextMenu).toHaveBeenCalled();
  });

  it("installs one rebuilt native menu when only Darwin diagnostic counts change", async () => {
    const { setupTray } = await import("../../src/main/tray.js");
    const { mainBus } = await import("../../src/main/events.js");
    const { BrowserWindow, Menu, Tray } = await import("electron");
    const event = createMockEvent();
    const state = {
      permission: "granted" as const,
      phase: "limited" as const,
      lastError: "Some calendars could not be refreshed",
      accountEmail: null,
      events: [event],
      offline: false,
      oauthConfigured: true,
      cacheAgeMs: null,
    };

    setupTray(new BrowserWindow(), createTrayGraph());
    await flushTrayRebuild();
    const trayInstance = getLatestTrayInstance(Tray);
    mainBus.emit("calendar-status-updated", {
      ...state,
      darwinPartialRefreshDiagnostics: {
        total: 1,
        malformedRecord: 1,
        malformedFieldCount: 0,
        invalidIso: 0,
        invalidId: 0,
        duplicateUid: 0,
      },
    });
    await flushTrayRebuild();
    vi.mocked(Menu.buildFromTemplate).mockClear();
    vi.mocked(trayInstance.setContextMenu).mockClear();

    mainBus.emit("calendar-status-updated", {
      ...state,
      darwinPartialRefreshDiagnostics: {
        total: 1,
        malformedRecord: 0,
        malformedFieldCount: 0,
        invalidIso: 0,
        invalidId: 1,
        duplicateUid: 0,
      },
    });
    await flushTrayRebuild();

    expect(Menu.buildFromTemplate).toHaveBeenCalledOnce();
    expect(trayInstance.setContextMenu).toHaveBeenCalledOnce();

    vi.mocked(Menu.buildFromTemplate).mockClear();
    vi.mocked(trayInstance.setContextMenu).mockClear();
    mainBus.emit("calendar-status-updated", {
      ...state,
      darwinPartialRefreshDiagnostics: {
        total: 1,
        malformedRecord: 0,
        malformedFieldCount: 0,
        invalidIso: 0,
        invalidId: 1,
        duplicateUid: 0,
      },
    });
    await flushTrayRebuild();

    expect(Menu.buildFromTemplate).not.toHaveBeenCalled();
    expect(trayInstance.setContextMenu).not.toHaveBeenCalled();
  });

  it("theme update swaps tray image", async () => {
    vi.resetModules();
    const { setupTray } = await import("../../src/main/tray.js");
    const { nativeTheme, Tray } = await import("electron");
    vi.mocked(nativeTheme.on).mockClear();
    setupTray({} as never, createTrayGraph());
    const trayInstance = getLatestTrayInstance(Tray);
    const themeCalls = vi.mocked(nativeTheme.on).mock.calls.filter((c) => c[0] === "updated");
    const themeHandler = themeCalls[themeCalls.length - 1]?.[1] as (() => void) | undefined;
    expect(themeHandler).toBeTypeOf("function");
    vi.mocked(trayInstance.setImage).mockClear();
    themeHandler?.();
    expect(trayInstance.setImage).toHaveBeenCalled();
  });

  it("menu callbacks invoke graph surfaces", async () => {
    const join = vi.fn().mockResolvedValue({ ok: true, value: undefined });
    const forcePoll = vi.fn().mockResolvedValue(undefined);
    const requestPermission = vi.fn().mockResolvedValue("granted");
    const disconnect = vi.fn().mockResolvedValue(undefined);
    const event = createMockEvent();
    const graph = createTrayGraph({
      join: { byId: join },
      settings: {
        get: () =>
          ({
            showTomorrowMeetings: true,
            showCompletedTodayMeetings: false,
          }) as never,
        load: vi.fn(),
        update: vi.fn(),
        save: vi.fn(),
      },
      scheduler: {
        forcePoll,
        getLastKnownEvents: () => null,
        cancelPendingBrowserOpen: vi.fn(),
        start: vi.fn(),
        stop: vi.fn(),
        restart: vi.fn(),
        setWindow: vi.fn(),
        setTrayTitleCallback: vi.fn(),
        initPowerCallbacks: vi.fn(),
      },
      calendar: {
        getEvents: vi.fn(),
        requestPermission,
        getPermissionStatus: vi.fn(),
        disconnect,
        getUiState: () => ({
          permission: "granted",
          phase: "ready",
          lastError: null,
          accountEmail: "u@example.com",
          events: [event],
          offline: false,
          oauthConfigured: true,
          darwinPartialRefreshDiagnostics: null,
          cacheAgeMs: null,
        }),
        warmup: vi.fn(),
        invalidatePermissionCache: vi.fn(),
        shouldAutoRequestPermission: () => false,
        reportPollError: vi.fn(),
      },
    });
    platformState.darwin = false;
    const { setupTray, destroyTray } = await import("../../src/main/tray.js");
    const { Menu, app } = await import("electron");
    setupTray({} as never, graph);
    await flushTrayRebuild();
    const template = vi.mocked(Menu.buildFromTemplate).mock.calls.at(-1)?.[0] as Array<{
      label?: string;
      click?: () => void;
      submenu?: Array<{ label?: string; click?: () => void }>;
    }>;

    // Connect surface (when not granted) is separate; with granted UI exercise footer + join.
    const joinNext = template?.find((i) => i.label === "Join Next Meeting");
    joinNext?.click?.();
    expect(join).toHaveBeenCalled();

    const refresh = template?.find((i) => i.label === "Refresh");
    refresh?.click?.();
    expect(forcePoll).toHaveBeenCalledWith({ reason: "user" });

    // Join submenu on a meeting row
    const meeting = template?.find((i) => i.label?.includes(event.title));
    const joinSub = meeting?.submenu?.find((s) => s.label === "Join");
    joinSub?.click?.();
    expect(join).toHaveBeenCalledTimes(2);

    const quit = template?.find((i) => i.label === "Quit");
    quit?.click?.();
    expect(app.quit).toHaveBeenCalled();

    // Disconnect path
    const disconnectItem = template?.find((i) => i.label === "Disconnect Google Calendar");
    disconnectItem?.click?.();
    await Promise.resolve();
    expect(disconnect).toHaveBeenCalled();

    // Reconnect CTA path when disconnected
    destroyTray();
    vi.resetModules();
    platformState.darwin = false;
    const trayMod = await import("../../src/main/tray.js");
    const electron2 = await import("electron");
    const graph2 = createTrayGraph({
      calendar: {
        getEvents: vi.fn(),
        requestPermission,
        getPermissionStatus: vi.fn(),
        disconnect,
        getUiState: () => ({
          permission: "not-determined",
          phase: "disconnected",
          lastError: null,
          accountEmail: null,
          events: null,
          offline: false,
          oauthConfigured: true,
          darwinPartialRefreshDiagnostics: null,
          cacheAgeMs: null,
        }),
        warmup: vi.fn(),
        invalidatePermissionCache: vi.fn(),
        shouldAutoRequestPermission: () => false,
        reportPollError: vi.fn(),
      },
      scheduler: {
        forcePoll,
        getLastKnownEvents: () => null,
        cancelPendingBrowserOpen: vi.fn(),
        start: vi.fn(),
        stop: vi.fn(),
        restart: vi.fn(),
        setWindow: vi.fn(),
        setTrayTitleCallback: vi.fn(),
        initPowerCallbacks: vi.fn(),
      },
    });
    trayMod.setupTray({} as never, graph2);
    await flushTrayRebuild();
    const template2 = vi.mocked(electron2.Menu.buildFromTemplate).mock.calls.at(-1)?.[0] as Array<{
      label?: string;
      click?: () => void;
    }>;
    const connect = template2?.find((i) => i.label?.includes("Connect"));
    connect?.click?.();
    await Promise.resolve();
    expect(requestPermission).toHaveBeenCalled();

    // Retry CTA when phase=error
    trayMod.destroyTray();
    vi.resetModules();
    platformState.darwin = true;
    const trayMod3 = await import("../../src/main/tray.js");
    const electron3 = await import("electron");
    const graph3 = createTrayGraph({
      calendar: {
        getEvents: vi.fn(),
        requestPermission,
        getPermissionStatus: vi.fn(),
        disconnect,
        getUiState: () => ({
          permission: "granted",
          phase: "error",
          lastError: "boom",
          accountEmail: null,
          events: null,
          offline: false,
          oauthConfigured: true,
          darwinPartialRefreshDiagnostics: null,
          cacheAgeMs: null,
        }),
        warmup: vi.fn(),
        invalidatePermissionCache: vi.fn(),
        shouldAutoRequestPermission: () => false,
        reportPollError: vi.fn(),
      },
      scheduler: {
        forcePoll,
        getLastKnownEvents: () => null,
        cancelPendingBrowserOpen: vi.fn(),
        start: vi.fn(),
        stop: vi.fn(),
        restart: vi.fn(),
        setWindow: vi.fn(),
        setTrayTitleCallback: vi.fn(),
        initPowerCallbacks: vi.fn(),
      },
    });
    forcePoll.mockClear();
    trayMod3.setupTray({} as never, graph3);
    await flushTrayRebuild();
    const template3 = vi.mocked(electron3.Menu.buildFromTemplate).mock.calls.at(-1)?.[0] as Array<{
      label?: string;
      click?: () => void;
    }>;
    const retry = template3?.find((i) => i.label === "Retry");
    retry?.click?.();
    expect(forcePoll).toHaveBeenCalledWith({ reason: "user" });
  });

  it("Refresh awaits user forcePoll then force-rebuilds the menu", async () => {
    let resolvePoll: (v: null) => void = () => {};
    const pollPromise = new Promise<null>((r) => {
      resolvePoll = r;
    });
    const forcePoll = vi.fn().mockReturnValue(pollPromise);
    const event = createMockEvent();
    const graph = createTrayGraph({
      settings: {
        get: () =>
          ({
            showTomorrowMeetings: true,
            showCompletedTodayMeetings: false,
          }) as never,
        load: vi.fn(),
        update: vi.fn(),
        save: vi.fn(),
      },
      scheduler: {
        forcePoll,
        getLastKnownEvents: () => null,
        cancelPendingBrowserOpen: vi.fn(),
        start: vi.fn(),
        stop: vi.fn(),
        restart: vi.fn(),
        setWindow: vi.fn(),
        setTrayTitleCallback: vi.fn(),
        initPowerCallbacks: vi.fn(),
      },
      calendar: {
        getEvents: vi.fn(),
        requestPermission: vi.fn(),
        getPermissionStatus: vi.fn(),
        disconnect: vi.fn(),
        getUiState: () => ({
          permission: "granted",
          phase: "ready",
          lastError: null,
          accountEmail: null,
          events: [event],
          offline: false,
          oauthConfigured: false,
          darwinPartialRefreshDiagnostics: null,
          cacheAgeMs: null,
        }),
        warmup: vi.fn(),
        invalidatePermissionCache: vi.fn(),
        shouldAutoRequestPermission: () => false,
        reportPollError: vi.fn(),
      },
    });
    platformState.darwin = true;
    const { setupTray, destroyTray } = await import("../../src/main/tray.js");
    const { Menu } = await import("electron");
    setupTray({} as never, graph);
    await flushTrayRebuild();
    const template = vi.mocked(Menu.buildFromTemplate).mock.calls.at(-1)?.[0] as Array<{
      label?: string;
      click?: () => void;
    }>;
    vi.mocked(Menu.buildFromTemplate).mockClear();

    const refresh = template?.find((i) => i.label === "Refresh");
    refresh?.click?.();
    expect(forcePoll).toHaveBeenCalledWith({ reason: "user" });
    // Rebuild waits for poll completion
    await flushTrayRebuild();
    expect(Menu.buildFromTemplate).not.toHaveBeenCalled();

    resolvePoll(null);
    await pollPromise;
    await flushTrayRebuild();
    expect(Menu.buildFromTemplate).toHaveBeenCalled();
    destroyTray();
  });
});
