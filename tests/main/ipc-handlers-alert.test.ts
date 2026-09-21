import { describe, it, expect, vi, beforeEach } from "vitest";

const mockCancelPendingBrowserOpen = vi.fn();

import { registerAlertHandlers } from "../../src/main/ipc-handlers/alert.js";
import { ipcMain } from "electron";
import { asTestEventId } from "../helpers/test-utils.js";
import { authorizedOnEvent } from "../helpers/ipc-sender.js";
import { testAppGraph } from "../helpers/app-graph.js";

const mockIpcMain = vi.mocked(ipcMain);

function alertGraph() {
  return testAppGraph({
    scheduler: { cancelPendingBrowserOpen: mockCancelPendingBrowserOpen },
  });
}

function getRegisteredHandler(channel: string) {
  const call = mockIpcMain.on.mock.calls.find((c) => c[0] === channel);
  return call?.[1];
}

const unauthorizedHttpsEvent = {
  senderFrame: { url: "https://evil.com/" },
}.As<import("electron").IpcMainEvent>();

const unauthorizedHttpEvent = {
  senderFrame: { url: "http://malicious.example/" },
}.As<import("electron").IpcMainEvent>();

const authorizedEvent = authorizedOnEvent("alert").As<import("electron").IpcMainEvent>();

describe("registerAlertHandlers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("registers exactly 1 fire-and-forget handler via ipcMain.on", () => {
    registerAlertHandlers(alertGraph());
    expect(mockIpcMain.on).toHaveBeenCalledTimes(1);
  });

  it("registers handler under the alert:dismissed channel", () => {
    registerAlertHandlers(alertGraph());
    expect(mockIpcMain.on).toHaveBeenCalledWith("alert:dismissed", expect.any(Function));
  });

  it("does not register via ipcMain.handle (fire-and-forget, not invoke)", () => {
    registerAlertHandlers(alertGraph());
    expect(mockIpcMain.handle).not.toHaveBeenCalled();
  });

  describe("alert:dismissed handler", () => {
    it("calls cancelPendingBrowserOpen with the payload id when sender authorized", () => {
      registerAlertHandlers(alertGraph());
      const handler = getRegisteredHandler("alert:dismissed");
      expect(handler).toBeDefined();

      const id = asTestEventId("evt-1");
      handler!(authorizedEvent, { id });

      expect(mockCancelPendingBrowserOpen).toHaveBeenCalledTimes(1);
      expect(mockCancelPendingBrowserOpen).toHaveBeenCalledWith(id);
    });

    it("rejects unauthorized https:// sender — cancel not invoked", () => {
      registerAlertHandlers(alertGraph());
      const handler = getRegisteredHandler("alert:dismissed");

      const id = asTestEventId("evt-1");
      handler!(unauthorizedHttpsEvent, { id });

      expect(mockCancelPendingBrowserOpen).not.toHaveBeenCalled();
    });

    it("rejects unauthorized http:// sender — cancel not invoked", () => {
      registerAlertHandlers(alertGraph());
      const handler = getRegisteredHandler("alert:dismissed");

      const id = asTestEventId("evt-1");
      handler!(unauthorizedHttpEvent, { id });

      expect(mockCancelPendingBrowserOpen).not.toHaveBeenCalled();
    });

    it("rejects file:// from outside lib/renderer/", () => {
      const badFileEvent = {
        senderFrame: { url: "file:///etc/passwd" },
      }.As<import("electron").IpcMainEvent>();

      registerAlertHandlers(alertGraph());
      const handler = getRegisteredHandler("alert:dismissed");

      handler!(badFileEvent, { id: asTestEventId("evt-1") });
      expect(mockCancelPendingBrowserOpen).not.toHaveBeenCalled();
    });

    describe("malformed payload (runtime validation at IPC boundary)", () => {
      it("ignores undefined payload — does not throw, does not cancel", () => {
        registerAlertHandlers(alertGraph());
        const handler = getRegisteredHandler("alert:dismissed");

        expect(() => handler!(authorizedEvent, undefined)).not.toThrow();
        expect(mockCancelPendingBrowserOpen).not.toHaveBeenCalled();
      });

      it("ignores null payload — does not throw, does not cancel", () => {
        registerAlertHandlers(alertGraph());
        const handler = getRegisteredHandler("alert:dismissed");

        expect(() => handler!(authorizedEvent, null)).not.toThrow();
        expect(mockCancelPendingBrowserOpen).not.toHaveBeenCalled();
      });

      it("ignores empty object payload — does not throw, does not cancel", () => {
        registerAlertHandlers(alertGraph());
        const handler = getRegisteredHandler("alert:dismissed");

        expect(() => handler!(authorizedEvent, {})).not.toThrow();
        expect(mockCancelPendingBrowserOpen).not.toHaveBeenCalled();
      });

      it("ignores payload with numeric id — does not throw, does not cancel", () => {
        registerAlertHandlers(alertGraph());
        const handler = getRegisteredHandler("alert:dismissed");

        expect(() => handler!(authorizedEvent, { id: 123 })).not.toThrow();
        expect(mockCancelPendingBrowserOpen).not.toHaveBeenCalled();
      });

      it("ignores payload with empty-string id — does not throw, does not cancel", () => {
        registerAlertHandlers(alertGraph());
        const handler = getRegisteredHandler("alert:dismissed");

        expect(() => handler!(authorizedEvent, { id: "" })).not.toThrow();
        expect(mockCancelPendingBrowserOpen).not.toHaveBeenCalled();
      });

      it("ignores payload with whitespace-only id — does not throw, does not cancel", () => {
        registerAlertHandlers(alertGraph());
        const handler = getRegisteredHandler("alert:dismissed");

        expect(() => handler!(authorizedEvent, { id: "   " })).not.toThrow();
        expect(mockCancelPendingBrowserOpen).not.toHaveBeenCalled();
      });

      it("ignores unauthorized sender with malformed payload — does not throw, does not cancel", () => {
        registerAlertHandlers(alertGraph());
        const handler = getRegisteredHandler("alert:dismissed");

        expect(() => handler!(unauthorizedHttpsEvent, undefined)).not.toThrow();
        expect(() => handler!(unauthorizedHttpsEvent, { id: 123 })).not.toThrow();
        expect(mockCancelPendingBrowserOpen).not.toHaveBeenCalled();
      });
    });
  });
});
