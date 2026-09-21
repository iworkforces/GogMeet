import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppGraph } from "../../src/main/composition/app-graph.js";
import { ok } from "../../src/domain/entities/result.js";
import { testAppGraph } from "../helpers/app-graph.js";
import {
  asTestEventId,
  asTestIsoUtc,
  createMockEvent,
  okCalendarResult,
} from "../helpers/test-utils.js";

vi.mock("electron", () => ({
  globalShortcut: {
    register: vi.fn().mockReturnValue(true),
    unregister: vi.fn(),
    unregisterAll: vi.fn(),
  },
  app: {
    on: vi.fn(),
  },
  Notification: Object.assign(
    vi.fn().mockImplementation(() => ({ show: vi.fn() })),
    { isSupported: vi.fn().mockReturnValue(false) },
  ),
}));

vi.mock("electron-log", () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

const mockGetCalendarEventsResult = vi.fn<AppGraph["calendar"]["getEventsResult"]>();
const mockGetLastKnownEvents = vi.fn<AppGraph["scheduler"]["getLastKnownEvents"]>();
const mockJoinById = vi.fn<AppGraph["join"]["byId"]>();

type ShortcutHandler = () => void | Promise<void>;
type GlobalShortcutMock = {
  readonly register: ReturnType<
    typeof vi.fn<(accelerator: string, callback: ShortcutHandler) => boolean>
  >;
  readonly unregisterAll: ReturnType<typeof vi.fn<() => void>>;
};

function shortcutsGraph(): AppGraph {
  return testAppGraph({
    calendar: { getEventsResult: mockGetCalendarEventsResult },
    scheduler: { getLastKnownEvents: mockGetLastKnownEvents },
    join: { byId: mockJoinById },
  });
}

describe("shortcuts", () => {
  let registerShortcuts: (graph: AppGraph) => void;
  let pickJoinTarget: typeof import("../../src/domain/services/pick-join-target.js").pickJoinTarget;
  let globalShortcut: GlobalShortcutMock;

  function registeredHandler(): () => Promise<void> {
    const handler = vi.mocked(globalShortcut.register).mock.calls[0]?.[1];
    if (typeof handler !== "function") throw new TypeError("shortcut handler was not registered");
    return async () => handler();
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();

    const mod = await import("../../src/main/system/shortcuts.js");
    registerShortcuts = mod.registerShortcuts;
    pickJoinTarget = (await import("../../src/domain/services/pick-join-target.js")).pickJoinTarget;

    const electron = await import("electron");
    globalShortcut = electron.globalShortcut.As<GlobalShortcutMock>();
    vi.mocked(globalShortcut.register).mockReturnValue(true);

    const now = Date.now();
    mockGetLastKnownEvents.mockReturnValue(null);
    mockGetCalendarEventsResult.mockResolvedValue(
      okCalendarResult([
        createMockEvent({
          id: asTestEventId("evt-1"),
          title: "Team Standup",
          startDate: asTestIsoUtc(new Date(now + 3_600_000).toISOString()),
          endDate: asTestIsoUtc(new Date(now + 7_200_000).toISOString()),
        }),
      ]),
    );
    mockJoinById.mockResolvedValue(ok(undefined));
  });

  it("registers global shortcut on first call", () => {
    registerShortcuts(shortcutsGraph());

    expect(globalShortcut.register).toHaveBeenCalledWith("CmdOrCtrl+Shift+M", expect.any(Function));
  });

  it("does not register twice on subsequent calls", () => {
    registerShortcuts(shortcutsGraph());
    registerShortcuts(shortcutsGraph());

    expect(globalShortcut.register).toHaveBeenCalledTimes(1);
  });

  describe("pickJoinTarget", () => {
    it("prefers in-progress over future", () => {
      const now = Date.now();
      const inProgress = createMockEvent({
        id: asTestEventId("in"),
        startDate: asTestIsoUtc(new Date(now - 60_000).toISOString()),
        endDate: asTestIsoUtc(new Date(now + 60_000).toISOString()),
      });
      const future = createMockEvent({
        id: asTestEventId("fut"),
        startDate: asTestIsoUtc(new Date(now + 3_600_000).toISOString()),
        endDate: asTestIsoUtc(new Date(now + 7_200_000).toISOString()),
      });

      expect(pickJoinTarget([future, inProgress], now)?.id).toBe("in");
    });
  });

  describe("shortcut handler", () => {
    it("joins the target meeting by id", async () => {
      registerShortcuts(shortcutsGraph());

      await registeredHandler()();

      expect(mockJoinById).toHaveBeenCalledWith("evt-1");
    });

    it("does nothing when no calendar events are available", async () => {
      mockGetCalendarEventsResult.mockResolvedValueOnce(okCalendarResult());
      registerShortcuts(shortcutsGraph());

      await registeredHandler()();

      expect(mockJoinById).not.toHaveBeenCalled();
    });

    it("does nothing when the calendar returns an error", async () => {
      mockGetCalendarEventsResult.mockResolvedValueOnce({
        kind: "err",
        error: "no access",
        code: "permission-denied",
      });
      registerShortcuts(shortcutsGraph());

      await registeredHandler()();

      expect(mockJoinById).not.toHaveBeenCalled();
    });

    it("filters out all-day events", async () => {
      mockGetCalendarEventsResult.mockResolvedValueOnce(
        okCalendarResult([
          createMockEvent({
            id: asTestEventId("evt-allday"),
            isAllDay: true,
          }),
        ]),
      );
      registerShortcuts(shortcutsGraph());

      await registeredHandler()();

      expect(mockJoinById).not.toHaveBeenCalled();
    });

    it("picks the earliest upcoming meeting when multiple exist", async () => {
      const now = Date.now();
      mockGetCalendarEventsResult.mockResolvedValueOnce(
        okCalendarResult([
          createMockEvent({
            id: asTestEventId("evt-late"),
            startDate: asTestIsoUtc(new Date(now + 7_200_000).toISOString()),
            endDate: asTestIsoUtc(new Date(now + 10_800_000).toISOString()),
          }),
          createMockEvent({
            id: asTestEventId("evt-early"),
            startDate: asTestIsoUtc(new Date(now + 1_800_000).toISOString()),
            endDate: asTestIsoUtc(new Date(now + 3_600_000).toISOString()),
          }),
        ]),
      );
      registerShortcuts(shortcutsGraph());

      await registeredHandler()();

      expect(mockJoinById).toHaveBeenCalledWith("evt-early");
    });

    it("joins an in-progress meeting over a future meeting", async () => {
      const now = Date.now();
      mockGetCalendarEventsResult.mockResolvedValueOnce(
        okCalendarResult([
          createMockEvent({
            id: asTestEventId("evt-future"),
            startDate: asTestIsoUtc(new Date(now + 3_600_000).toISOString()),
            endDate: asTestIsoUtc(new Date(now + 7_200_000).toISOString()),
          }),
          createMockEvent({
            id: asTestEventId("evt-now"),
            startDate: asTestIsoUtc(new Date(now - 300_000).toISOString()),
            endDate: asTestIsoUtc(new Date(now + 1_800_000).toISOString()),
          }),
        ]),
      );
      registerShortcuts(shortcutsGraph());

      await registeredHandler()();

      expect(mockJoinById).toHaveBeenCalledWith("evt-now");
    });
  });

  describe("registration failure", () => {
    it("does not mark the shortcut as registered when registration fails", () => {
      vi.mocked(globalShortcut.register).mockReturnValue(false);

      registerShortcuts(shortcutsGraph());
      registerShortcuts(shortcutsGraph());

      expect(globalShortcut.register).toHaveBeenCalledTimes(2);
    });
  });

  describe("notification and error paths", () => {
    it("warns and notifies when joining fails", async () => {
      const log = (await import("electron-log")).default;
      mockJoinById.mockResolvedValueOnce({ ok: false, error: "blocked url" });
      registerShortcuts(shortcutsGraph());

      await registeredHandler()();

      expect(log.warn).toHaveBeenCalled();
      expect(log.info).toHaveBeenCalledWith(expect.stringMatching(/GogMeet/));
    });

    it("logs when the calendar fetch throws", async () => {
      const log = (await import("electron-log")).default;
      mockGetCalendarEventsResult.mockRejectedValueOnce(new Error("boom"));
      registerShortcuts(shortcutsGraph());

      await registeredHandler()();

      expect(log.error).toHaveBeenCalled();
    });

    it("clears registration so the shortcut can register again", async () => {
      const mod = await import("../../src/main/system/shortcuts.js");
      mod.registerShortcuts(shortcutsGraph());
      mod.unregisterShortcuts();

      expect(globalShortcut.unregisterAll).toHaveBeenCalled();

      mod.registerShortcuts(shortcutsGraph());
      expect(globalShortcut.register).toHaveBeenCalledTimes(2);
    });
  });
});
