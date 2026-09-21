import { describe, it, expect, vi, beforeEach } from "vitest";

const mockRefreshCalendarPublication = vi.fn();
const mockRequestCalendarPermission = vi.fn();
const mockGetCalendarPermissionStatus = vi.fn();
const mockDisconnectCalendar = vi.fn();
const mockGetCalendarUiState = vi.fn();
const mockForcePoll = vi.fn();

import { registerCalendarHandlers } from "../../src/main/ipc-handlers/calendar.js";
import { ipcMain } from "electron";
import { authorizedInvokeEvent } from "../helpers/ipc-sender.js";
import { testAppGraph } from "../helpers/app-graph.js";

const mockIpcMain = vi.mocked(ipcMain);

const disconnectedUiState = {
  permission: "not-determined" as const,
  phase: "disconnected" as const,
  lastError: null,
  accountEmail: null,
  events: null,
  offline: false,
  oauthConfigured: false,
  darwinPartialRefreshDiagnostics: null,
  cacheAgeMs: null,
};

function calendarGraph() {
  return testAppGraph({
    calendar: {
      getEvents: mockRefreshCalendarPublication,
      requestPermission: mockRequestCalendarPermission,
      getPermissionStatus: mockGetCalendarPermissionStatus,
      disconnect: mockDisconnectCalendar,
      getUiState: mockGetCalendarUiState,
    },
    scheduler: { forcePoll: mockForcePoll },
  });
}

function getRegisteredHandler(channel: string) {
  const call = mockIpcMain.handle.mock.calls.find((c) => c[0] === channel);
  return call?.[1];
}

const unauthorizedEvent = {
  senderFrame: { url: "https://evil.com/" },
}.As<import("electron").IpcMainInvokeEvent>();

const authorizedEvent = authorizedInvokeEvent("index").As<import("electron").IpcMainInvokeEvent>();

describe("registerCalendarHandlers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRefreshCalendarPublication.mockReset();
    mockRequestCalendarPermission.mockReset();
    mockGetCalendarPermissionStatus.mockReset();
    mockDisconnectCalendar.mockReset();
    mockGetCalendarUiState.mockReset();
    mockForcePoll.mockReset();
    mockGetCalendarUiState.mockReturnValue(disconnectedUiState);
  });

  it("registers 5 handlers", () => {
    registerCalendarHandlers(calendarGraph());
    expect(mockIpcMain.handle).toHaveBeenCalledTimes(5);
  });

  describe("calendar:get-events", () => {
    it("returns events for authorized sender", async () => {
      const events = [
        {
          id: "1",
          title: "Test Meeting",
          startDate: "2026-03-27T10:00:00Z",
          endDate: "2026-03-27T11:00:00Z",
          calendarName: "Work",
          isAllDay: false,
        },
      ];
      mockRefreshCalendarPublication.mockResolvedValue({
        publicationGeneration: 7,
        result: {
          kind: "ok",
          source: "live",
          completeness: "complete",
          observedAt: Date.now(),
          events,
        },
      });

      registerCalendarHandlers(calendarGraph());
      const handler = getRegisteredHandler("calendar:get-events");
      expect(handler).toBeDefined();

      const result = await handler!(authorizedEvent);
      expect(result).toMatchObject({
        publicationGeneration: 7,
        result: { kind: "ok", source: "live", completeness: "complete", events },
      });
    });

    it("returns unauthorized for blocked sender", async () => {
      registerCalendarHandlers(calendarGraph());
      const handler = getRegisteredHandler("calendar:get-events");

      const result = await handler!(unauthorizedEvent);
      expect(result).toEqual({
        publicationGeneration: 0,
        result: { kind: "err", error: "unauthorized", code: "unknown" },
      });
    });

    it("returns error on exception", async () => {
      mockRefreshCalendarPublication.mockRejectedValue(new Error("Calendar error"));

      registerCalendarHandlers(calendarGraph());
      const handler = getRegisteredHandler("calendar:get-events");

      const result = await handler!(authorizedEvent);
      expect(result).toEqual({
        publicationGeneration: 0,
        result: {
          kind: "err",
          error: "Calendar error",
          code: "unknown",
        },
      });
    });

    it("returns stringified error for non-Error exceptions", async () => {
      mockRefreshCalendarPublication.mockRejectedValue("string error");

      registerCalendarHandlers(calendarGraph());
      const handler = getRegisteredHandler("calendar:get-events");

      const result = await handler!(authorizedEvent);
      expect(result).toEqual({
        publicationGeneration: 0,
        result: { kind: "err", error: "string error", code: "unknown" },
      });
    });
  });

  describe("calendar:request-permission", () => {
    it("returns permission status for authorized sender", async () => {
      mockRequestCalendarPermission.mockResolvedValue("granted");

      registerCalendarHandlers(calendarGraph());
      const handler = getRegisteredHandler("calendar:request-permission");

      const result = await handler!(authorizedEvent);
      expect(result).toBe("granted");
    });

    it("returns denied for unauthorized sender", async () => {
      registerCalendarHandlers(calendarGraph());
      const handler = getRegisteredHandler("calendar:request-permission");

      const result = await handler!(unauthorizedEvent);
      expect(result).toBe("denied");
    });

    it("returns denied on exception", async () => {
      mockRequestCalendarPermission.mockRejectedValue(new Error("fail"));

      registerCalendarHandlers(calendarGraph());
      const handler = getRegisteredHandler("calendar:request-permission");

      const result = await handler!(authorizedEvent);
      expect(result).toBe("denied");
    });
  });

  describe("calendar:permission-status", () => {
    it("returns status for authorized sender", async () => {
      mockGetCalendarPermissionStatus.mockResolvedValue("granted");

      registerCalendarHandlers(calendarGraph());
      const handler = getRegisteredHandler("calendar:permission-status");

      const result = await handler!(authorizedEvent);
      expect(result).toBe("granted");
    });

    it("returns denied for unauthorized sender", async () => {
      registerCalendarHandlers(calendarGraph());
      const handler = getRegisteredHandler("calendar:permission-status");

      const result = await handler!(unauthorizedEvent);
      expect(result).toBe("denied");
    });

    it("returns denied on exception", async () => {
      mockGetCalendarPermissionStatus.mockRejectedValue(new Error("fail"));

      registerCalendarHandlers(calendarGraph());
      const handler = getRegisteredHandler("calendar:permission-status");

      const result = await handler!(authorizedEvent);
      expect(result).toBe("denied");
    });
  });

  describe("calendar:disconnect and ui-state", () => {
    it("disconnect ignores unauthorized", async () => {
      registerCalendarHandlers(calendarGraph());
      const handler = getRegisteredHandler("calendar:disconnect");
      await handler!(unauthorizedEvent);
      expect(mockDisconnectCalendar).not.toHaveBeenCalled();
    });

    it("disconnect swallows errors", async () => {
      mockDisconnectCalendar.mockRejectedValue(new Error("disc fail"));
      const err = vi.spyOn(console, "error").mockImplementation(() => {});
      registerCalendarHandlers(calendarGraph());
      const handler = getRegisteredHandler("calendar:disconnect");
      await handler!(authorizedEvent);
      expect(err).toHaveBeenCalled();
      err.mockRestore();
    });

    it("ui-state returns default for unauthorized", async () => {
      registerCalendarHandlers(calendarGraph());
      const handler = getRegisteredHandler("calendar:ui-state");
      const result = await handler!(unauthorizedEvent);
      expect(result).toMatchObject({ phase: "disconnected" });
    });

    it("ui-state returns default on throw", async () => {
      mockGetCalendarUiState.mockImplementation(() => {
        throw new Error("ui fail");
      });
      const err = vi.spyOn(console, "error").mockImplementation(() => {});
      registerCalendarHandlers(calendarGraph());
      const handler = getRegisteredHandler("calendar:ui-state");
      const result = await handler!(authorizedEvent);
      expect(result).toMatchObject({ phase: "disconnected" });
      err.mockRestore();
    });
  });
});
