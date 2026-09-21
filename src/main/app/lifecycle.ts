import { app, dialog, type BrowserWindow } from "electron";
import { setupTray, forceTrayMenuRefresh, updateTrayTitle } from "../tray.js";
import { registerIpcHandlers } from "./ipc.js";
import {
  initPowerManagement,
  initPowerEvents,
  cleanupPowerManagement,
  getPollInterval,
  preventSleep,
  allowSleep,
} from "../system/power.js";
import { syncAutoLaunch } from "../system/auto-launch.js";
import { checkNotificationPermission } from "../system/notification.js";
import { registerShortcuts, unregisterShortcuts } from "../system/shortcuts.js";
import { initAutoUpdater } from "../system/auto-updater.js";
import { onDisplayHorizonTick, clearDisplayHorizon } from "../system/display-horizon.js";
import { createAppGraph, type AppGraph } from "../composition/app-graph.js";
import { destroyAlertWindow } from "../windows/alert-window.js";
import { destroySettingsWindow } from "../windows/settings-window.js";
import { destroyAboutWindow } from "../windows/about-window.js";
import { destroyUpdateWindow } from "../windows/update-window.js";
import { isPerfTraceEnabled, perfTrace } from "../utils/performance-trace.js";
import type { PerfTraceStartupPhase } from "../utils/performance-trace.js";

function traceStartupPhase(phase: PerfTraceStartupPhase, startMs: number): void {
  if (!isPerfTraceEnabled()) return;
  perfTrace({
    operation: "startup-phase",
    phase,
    outcome: "ok",
    startMs,
    durationMs: Math.max(0, performance.now() - startMs),
  });
}

/** Active graph for this process (set during initializeApp). */
let activeGraph: AppGraph | null = null;

/** Unsubscribe for display-horizon → UI refresh wiring. */
let unsubscribeDisplayHorizon: (() => void) | null = null;

export function getActiveAppGraph(): AppGraph | null {
  return activeGraph;
}

/** Options for packaged measurement probes — suppress external mutators. */
export interface InitializeAppOptions {
  /**
   * When true, run production window/graph/IPC/settings/tray/scheduler/watcher/first-poll
   * but skip power events, global shortcuts, notification permission, auto-launch mutation,
   * and auto-updater. Used only by the private GOGMEET_PERF_PROBE=startup path.
   */
  readonly probeSafe?: boolean;
}

/**
 * Initialize all app subsystems after Electron is ready.
 * Called once from app.whenReady() in index.ts.
 */
export async function initializeApp(
  mainWindow: BrowserWindow,
  options: InitializeAppOptions = {},
): Promise<void> {
  const probeSafe = options.probeSafe === true;
  const errors: Error[] = [];
  const tryRun = (label: string, fn: () => void): void => {
    try {
      fn();
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      console.error(`[lifecycle] ${label} failed:`, error);
      errors.push(new Error(`${label}: ${error.message}`));
    }
  };
  const tryRunAsync = async (label: string, fn: () => Promise<void>): Promise<void> => {
    try {
      await fn();
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      console.error(`[lifecycle] ${label} failed:`, error);
      errors.push(new Error(`${label}: ${error.message}`));
    }
  };
  const tryRunCritical = (label: string, fn: () => void): void => {
    try {
      fn();
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      console.error(`[lifecycle] ${label} failed:`, error);
      throw new Error(`${label}: ${error.message}`, { cause: err });
    }
  };
  const tryRunAsyncCritical = async (label: string, fn: () => Promise<void>): Promise<void> => {
    try {
      await fn();
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      console.error(`[lifecycle] ${label} failed:`, error);
      throw new Error(`${label}: ${error.message}`, { cause: err });
    }
  };

  try {
    // Composition root: wire adapters/use-case defaults before IPC
    let graph!: AppGraph;
    const tGraph = performance.now();
    tryRunCritical("createAppGraph", () => {
      graph = createAppGraph();
      activeGraph = graph;
    });
    traceStartupPhase("app-graph", tGraph);

    // Pre-warm calendar provider (Swift compile on Darwin) — don't block init
    const tWarm = performance.now();
    tryRun("warmupCalendarProvider", () => {
      graph.calendar.warmup().catch((err: unknown) => {
        console.warn("[lifecycle] Calendar provider pre-warm failed:", err);
      });
    });
    // Dispatch only (not awaited helper spawn/query) — safe probe profile.
    traceStartupPhase("warmup-dispatch", tWarm);

    // Register IPC handlers before any async ops — renderer may call channels early
    const tIpc = performance.now();
    tryRunCritical("registerIpcHandlers", () => registerIpcHandlers(mainWindow, graph));
    traceStartupPhase("ipc-register", tIpc);

    // Load settings and check calendar permission in parallel
    const tSettings = performance.now();
    await Promise.all([
      tryRunAsyncCritical("loadSettings", async () => {
        const result = await graph.settings.load();
        if (!result.ok) {
          console.warn("[lifecycle] Settings load warning:", result.error);
        }
      }),
      tryRunAsync("calendarPermission", async () => {
        const calendarPerm = await graph.calendar.getPermissionStatus();
        // Darwin: request EventKit when not determined. Windows: never auto-OAuth.
        // Probe-safe / Windows: never auto-OAuth (shouldAutoRequestPermission is Darwin-only).
        if (
          !probeSafe &&
          calendarPerm === "not-determined" &&
          graph.calendar.shouldAutoRequestPermission()
        ) {
          console.log("[lifecycle] Calendar permission not determined — requesting...");
          await graph.calendar.requestPermission();
        }
      }),
    ]);
    traceStartupPhase("settings-permission", tSettings);

    const tTray = performance.now();
    tryRunCritical("setupTray", () => setupTray(mainWindow, graph));
    traceStartupPhase("tray", tTray);
    tryRun("setTrayTitleCallback", () => graph.scheduler.setTrayTitleCallback(updateTrayTitle));
    tryRun("setSchedulerWindow", () => graph.scheduler.setWindow(mainWindow));
    tryRun("initPowerCallbacks", () =>
      graph.scheduler.initPowerCallbacks({ getPollInterval, preventSleep, allowSleep }),
    );
    tryRun("wireDisplayHorizon", () => {
      unsubscribeDisplayHorizon?.();
      unsubscribeDisplayHorizon = onDisplayHorizonTick(() => {
        // Wall clock crossed a start/end boundary: force list UI to re-filter.
        graph.scheduler.republishUiForDisplayTick();
        forceTrayMenuRefresh();
      });
    });

    const tSched = performance.now();
    tryRun("startScheduler", () => graph.scheduler.start());
    traceStartupPhase("scheduler", tSched);
    const tWatch = performance.now();
    tryRun("startCalendarWatcher", () => graph.watcher.start());
    traceStartupPhase("watcher", tWatch);
    // first-poll is owned by the first completed guarded poll (see scheduler poll path).

    if (!probeSafe) {
      tryRun("initPowerManagement", () =>
        initPowerManagement((reason) => {
          if (reason === "battery" || reason === "ac") {
            // Interval source already flipped in power.ts; re-arm next tick only.
            void graph.scheduler.forcePoll({ reason: "power" });
            return;
          }
          graph.calendar.invalidatePermissionCache();
          graph.watcher.revive();
          // Coalesced forcePoll (reason power) — avoid full stop/start restart storms.
          void graph.scheduler.forcePoll({ reason: "power" });
        }),
      );
      tryRun("initPowerEvents", () => initPowerEvents());
      tryRun("registerShortcuts", () => registerShortcuts(graph));

      tryRun("checkNotificationPermission", () => {
        void checkNotificationPermission();
      });

      tryRun("syncAutoLaunch", () => {
        const settings = graph.settings.get();
        syncAutoLaunch(settings.launchAtLogin);
      });

      tryRun("initAutoUpdater", () => {
        initAutoUpdater();
      });
    }

    if (errors.length > 0) {
      const message = errors.map((e) => `• ${e.message}`).join("\n");
      throw new Error(`One or more subsystems failed to initialize:\n${message}`);
    }
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    console.error("[lifecycle]", error);
    if (!probeSafe) {
      dialog.showErrorBox("GogMeet Startup Error", error.message);
    }
    app.quit();
  }
}

/**
 * Shut down all app subsystems before quit.
 * Called from app.on("before-quit") in index.ts.
 */
export function shutdownApp(): void {
  cleanupPowerManagement();
  unsubscribeDisplayHorizon?.();
  unsubscribeDisplayHorizon = null;
  clearDisplayHorizon();
  // Drop hide-cached BrowserWindows so quit is not blocked by preventDefault close.
  destroyAlertWindow();
  destroySettingsWindow();
  destroyAboutWindow();
  destroyUpdateWindow();
  const graph = activeGraph;
  if (graph) {
    graph.scheduler.stop();
    graph.watcher.stop();
  }
  unregisterShortcuts();
  activeGraph = null;
}
