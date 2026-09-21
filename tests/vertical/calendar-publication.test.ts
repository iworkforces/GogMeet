import { afterEach, describe, expect, it, vi } from "vitest";

import type { CalendarPublication } from "../../src/domain/entities/calendar-publication.js";
import { DEFAULT_SETTINGS } from "../../src/domain/entities/settings.js";
import type { Api } from "../../src/preload/index.js";
import { IPC_CHANNELS } from "../../src/shared/ipc-channels.js";
import type { IpcRendererEvent, WebContents } from "electron";
import { asTestIsoUtc, createMockEvent, okCalendarResult } from "../helpers/test-utils.js";

const loopback = vi.hoisted(() => {
  type InvokeHandler = (event: object, ...args: readonly unknown[]) => unknown;
  type RendererListener = (event: object, payload: unknown) => void;

  const handlers = new Map<string, InvokeHandler>();
  const listeners = new Map<string, Set<RendererListener>>();
  const senderFrame = { url: "https://invalid.example/" };
  const settings = { current: null as object | null };

  const removeListener = vi.fn((channel: string, listener: RendererListener) => {
    listeners.get(channel)?.delete(listener);
  });

  const ipcRenderer = {
    invoke: vi.fn(async (channel: string, ...args: readonly unknown[]) => {
      if (channel === "settings:get") return settings.current;
      if (channel === "app:get-version") return "2.0.0";
      const handler = handlers.get(channel);
      if (handler === undefined) {
        throw new Error(`No loopback handler registered for ${channel}`);
      }
      return handler({ senderFrame }, ...args);
    }),
    on: vi.fn((channel: string, listener: RendererListener) => {
      const channelListeners = listeners.get(channel) ?? new Set<RendererListener>();
      channelListeners.add(listener);
      listeners.set(channel, channelListeners);
    }),
    removeListener,
    send: vi.fn(),
  };

  return {
    handlers,
    listeners,
    senderFrame,
    settings,
    removeListener,
    electron: {
      app: {
        getAppPath: vi.fn(() => "/app"),
        getPath: vi.fn(() => "/tmp/gogmeet-vertical"),
        isPackaged: false,
      },
      contextBridge: {
        exposeInMainWorld: vi.fn((key: string, value: object) => {
          Object.defineProperty(window, key, { configurable: true, value });
        }),
      },
      ipcMain: {
        handle: vi.fn((channel: string, handler: InvokeHandler) => {
          handlers.set(channel, handler);
        }),
      },
      ipcRenderer,
      Notification: vi.fn(),
      safeStorage: {
        isEncryptionAvailable: vi.fn(() => false),
        encryptString: vi.fn(),
        decryptString: vi.fn(),
      },
      shell: { openExternal: vi.fn(async () => undefined) },
    },
  };
});

vi.mock("electron", () => loopback.electron);

type TrackedDocumentListener = {
  readonly type: string;
  readonly listener: EventListenerOrEventListenerObject;
  readonly options: boolean | AddEventListenerOptions | undefined;
};

const trackedDocumentListeners: TrackedDocumentListener[] = [];
let removeTrackedDocumentListeners: (() => void) | null = null;
let originalApiDescriptor: PropertyDescriptor | undefined;

function restoreApi(): void {
  if (originalApiDescriptor === undefined) {
    Reflect.deleteProperty(window, "api");
    return;
  }
  Object.defineProperty(window, "api", originalApiDescriptor);
}

function safetyCleanup(): void {
  removeTrackedDocumentListeners?.();
  removeTrackedDocumentListeners = null;
  trackedDocumentListeners.length = 0;
  loopback.handlers.clear();
  loopback.listeners.clear();
  loopback.settings.current = null;
  loopback.senderFrame.url = "https://invalid.example/";
  document.body.replaceChildren();
  restoreApi();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.resetModules();
}

afterEach(() => {
  safetyCleanup();
});

describe("calendar publication vertical path", () => {
  it("keeps a pushed newer publication when the initial real IPC request finishes later", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-21T12:00:00.000Z"));
    vi.resetModules();
    originalApiDescriptor = Object.getOwnPropertyDescriptor(window, "api");
    loopback.settings.current = DEFAULT_SETTINGS;
    document.body.innerHTML = '<div id="app"></div>';

    const rendererInitialized = Promise.withResolvers<void>();
    const nativeAddEventListener = document.addEventListener.bind(document);
    const nativeRemoveEventListener = document.removeEventListener.bind(document);
    vi.spyOn(document, "addEventListener").mockImplementation(
      (
        type: string,
        listener: EventListenerOrEventListenerObject,
        options?: boolean | AddEventListenerOptions,
      ) => {
        trackedDocumentListeners.push({ type, listener, options });
        nativeAddEventListener(type, listener, options);
        if (type === "visibilitychange") rendererInitialized.resolve();
      },
    );
    removeTrackedDocumentListeners = () => {
      for (const { type, listener, options } of trackedDocumentListeners.toReversed()) {
        nativeRemoveEventListener(type, listener, options);
      }
      trackedDocumentListeners.length = 0;
    };
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const generationOneEvent = createMockEvent({
      title: "Deferred generation one",
      startDate: asTestIsoUtc("2026-09-21T12:10:00.000Z"),
      endDate: asTestIsoUtc("2026-09-21T12:40:00.000Z"),
    });
    const generationTwoEvent = createMockEvent({
      title: "Pushed generation two",
      startDate: asTestIsoUtc("2026-09-21T12:20:00.000Z"),
      endDate: asTestIsoUtc("2026-09-21T12:50:00.000Z"),
    });
    const generationOne: CalendarPublication = {
      publicationGeneration: 1,
      result: okCalendarResult([generationOneEvent]),
    };
    const generationTwo: CalendarPublication = {
      publicationGeneration: 2,
      result: okCalendarResult([generationTwoEvent]),
    };
    const deferredGenerationOne = Promise.withResolvers<CalendarPublication>();
    const graphCallStarted = Promise.withResolvers<void>();
    const getEvents = vi.fn(() => {
      graphCallStarted.resolve();
      return deferredGenerationOne.promise;
    });
    const getPermissionStatus = vi.fn(async () => "granted" as const);

    try {
      const [{ registerCalendarHandlers }, { typedSend }, { testAppGraph }] = await Promise.all([
        import("../../src/main/ipc-handlers/calendar.js"),
        import("../../src/main/ipc-handlers/shared.js"),
        import("../helpers/app-graph.js"),
      ]);
      await import("../../src/preload/index.js");
      const api = window.As<Window & { readonly api: Api }>().api;

      registerCalendarHandlers(
        testAppGraph({
          calendar: {
            getEvents,
            getPermissionStatus,
          },
        }),
      );

      const unauthorized = await api.calendar.getEvents();
      expect(unauthorized).toEqual({
        publicationGeneration: 0,
        result: { kind: "err", error: "unauthorized", code: "unknown" },
      });
      expect(getEvents).not.toHaveBeenCalled();

      const unsubscribe = api.calendar.onResultUpdated(() => undefined);
      const temporaryListeners = loopback.listeners.get(IPC_CHANNELS.CALENDAR_RESULT_UPDATED);
      const registeredListener = temporaryListeners?.values().next().value;
      if (registeredListener === undefined) {
        throw new Error("Preload did not register the calendar result listener");
      }
      unsubscribe();
      expect(loopback.removeListener).toHaveBeenCalledWith(
        IPC_CHANNELS.CALENDAR_RESULT_UPDATED,
        registeredListener,
      );
      expect(temporaryListeners?.has(registeredListener)).toBe(false);

      loopback.senderFrame.url = "http://localhost:5173/";
      await import("../../src/renderer/index.js");
      const domContentLoaded = trackedDocumentListeners.find(
        ({ type }) => type === "DOMContentLoaded",
      )?.listener;
      if (domContentLoaded === undefined) {
        throw new Error("Renderer did not register DOMContentLoaded");
      }
      const loadedEvent = new Event("DOMContentLoaded");
      if (typeof domContentLoaded === "function") {
        domContentLoaded.call(document, loadedEvent);
      } else {
        domContentLoaded.handleEvent(loadedEvent);
      }
      await graphCallStarted.promise;
      expect(loopback.electron.ipcRenderer.invoke).toHaveBeenCalledWith(
        IPC_CHANNELS.CALENDAR_PERMISSION_STATUS,
      );
      expect(getPermissionStatus).toHaveBeenCalledOnce();

      const fakeWebContents = {
        isDestroyed: () => false,
        send: (channel: string, payload: unknown) => {
          const snapshot = [...(loopback.listeners.get(channel) ?? [])];
          for (const listener of snapshot) {
            listener({}.As<IpcRendererEvent>(), payload);
          }
        },
      }.As<WebContents>();
      typedSend(fakeWebContents, IPC_CHANNELS.CALENDAR_RESULT_UPDATED, generationTwo);

      expect(document.body.textContent).toContain("Pushed generation two");
      expect(document.body.textContent).not.toContain("Deferred generation one");

      deferredGenerationOne.resolve(generationOne);
      await rendererInitialized.promise;
      expect(document.body.textContent).toContain("Pushed generation two");
      expect(document.body.textContent).not.toContain("Deferred generation one");

      removeTrackedDocumentListeners();
      removeTrackedDocumentListeners = null;
      loopback.handlers.clear();
      loopback.listeners.clear();
      loopback.removeListener.mockClear();
      loopback.electron.ipcMain.handle.mockClear();
      loopback.electron.ipcRenderer.invoke.mockClear();
      loopback.electron.ipcRenderer.on.mockClear();
      loopback.electron.ipcRenderer.send.mockClear();
      document.body.replaceChildren();
      restoreApi();

      expect(loopback.handlers.size).toBe(0);
      expect([...loopback.listeners.values()].reduce((count, set) => count + set.size, 0)).toBe(0);
      expect(trackedDocumentListeners).toHaveLength(0);
      expect(vi.getTimerCount()).toBe(0);
      expect(document.body.innerHTML).toBe("");
    } finally {
      safetyCleanup();
    }
  });
});
