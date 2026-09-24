import { IPC_CHANNELS } from "../../shared/ipc-channels.js";
import type { AlertPayload } from "../../shared/alert.js";
import type { MeetingEvent } from "../../domain/entities/meeting-event.js";
import { BrowserWindow } from "electron";
import {
  SECURE_WEB_PREFERENCES,
  getPreloadPath,
  loadWindowContent,
} from "../utils/browser-window.js";
import { applyAlertAlwaysOnTop, platformWindowChrome } from "../utils/window-chrome.js";

import { typedSend } from "../ipc-handlers/shared.js";
import type { EventId, IsoUtc } from "../../domain/entities/brand.js";

interface AlertPresentation {
  event: MeetingEvent;
  onDismiss: () => void;
  autoOpenAt?: IsoUtc;
  canShow: () => boolean;
}

function toAlertPayload(event: MeetingEvent, autoOpenAt?: IsoUtc): AlertPayload {
  const payload: AlertPayload = {
    id: event.id,
    title: event.title,
    startDate: event.startDate,
    endDate: event.endDate,
    calendarName: event.calendarName,
    isAllDay: event.isAllDay,
    hasMeetUrl: !!event.meetUrl,
  };
  if (event.description !== undefined) {
    payload.description = event.description;
  }
  if (autoOpenAt !== undefined) {
    payload.autoOpenAt = autoOpenAt;
  }
  return payload;
}

let alertWindow: BrowserWindow | null = null;
let isAlertShowing = false;
let activePresentation: AlertPresentation | null = null;
let alertReady = false;
/** FIFO queue preserves optional autoOpenAt for stacked presentations. */
const pendingAlerts: AlertPresentation[] = [];
/** Prefer hide/show reuse when the prior window is still alive (same security prefs). */
let reuseGeneration = 0;
/** At most one reserved dequeue → present handoff (module-owned). */
let queuedImmediate: ReturnType<typeof setImmediate> | null = null;

/**
 * Reserve the presentation slot, then shift+present on the next tick.
 * Destroy clears `queuedImmediate` and bumps generation so stale callbacks no-op.
 */
function processNextAlert(): void {
  if (queuedImmediate !== null) return;
  if (isAlertShowing || pendingAlerts.length === 0) return;

  // Reserve before scheduling so concurrent showAlert queues behind this owner.
  isAlertShowing = true;
  const reservedGeneration = reuseGeneration;
  queuedImmediate = setImmediate(() => {
    queuedImmediate = null;
    if (reservedGeneration !== reuseGeneration) {
      // Generation advanced via destroy or in-place reschedule while we waited.
      // Do NOT clear isAlertShowing: a live reschedule already owns the slot, and
      // destroy already cleared flags/queue. Only re-drive if nobody is presenting.
      if (!isAlertShowing && pendingAlerts.length > 0) {
        processNextAlert();
      }
      return;
    }
    const next = pendingAlerts.shift();
    if (!next) {
      isAlertShowing = false;
      return;
    }
    if (!next.canShow()) {
      isAlertShowing = false;
      processNextAlert();
      return;
    }
    showAlertInternal(next);
  });
}

function isCurrentPresentation(win: BrowserWindow, generation: number): boolean {
  return !win.isDestroyed() && alertWindow === win && generation === reuseGeneration;
}

export function showAlert(
  event: MeetingEvent,
  onDismiss: () => void,
  autoOpenAt: IsoUtc | undefined,
  canShow: () => boolean,
): void {
  const startMs = new Date(event.startDate).getTime();
  // If same uid but different startMs, the meeting was rescheduled — replace in-place.
  if (
    isAlertShowing &&
    alertWindow &&
    !alertWindow.isDestroyed() &&
    alertWindow.__alertUid === event.id
  ) {
    const sameStart = alertWindow.__alertStartMs === startMs;
    if (sameStart) {
      if (activePresentation?.canShow()) return;
    }
    if (!canShow()) {
      if (sameStart && !alertWindow.isVisible()) {
        consumePresentation(alertWindow, alertWindow.__alertGeneration ?? -1);
      }
      return;
    }
    // Rescheduled: reuse the live window with the new payload (no cancel of pending open —
    // same contract as the prior destroy/recreate path with __replacing).
    const presentation: AlertPresentation = { event, onDismiss, canShow };
    if (autoOpenAt !== undefined) presentation.autoOpenAt = autoOpenAt;
    showAlertInternal(presentation, sameStart && !alertReady);
    return;
  }
  const queuedIndex = pendingAlerts.findIndex((entry) => entry.event.id === event.id);
  if (queuedIndex !== -1) {
    const existing = pendingAlerts[queuedIndex];
    if (existing && new Date(existing.event.startDate).getTime() === startMs) {
      if (existing.canShow()) {
        if (autoOpenAt !== undefined) {
          existing.autoOpenAt = autoOpenAt;
        }
        return;
      }
    }
    // Replace queued entry in-place to preserve order (keep autoOpenAt).
    const next: AlertPresentation = { event, onDismiss, canShow };
    if (autoOpenAt !== undefined) next.autoOpenAt = autoOpenAt;
    pendingAlerts[queuedIndex] = next;
    return;
  }

  if (isAlertShowing) {
    const entry: AlertPresentation = { event, onDismiss, canShow };
    if (autoOpenAt !== undefined) entry.autoOpenAt = autoOpenAt;
    pendingAlerts.push(entry);
    return;
  }

  isAlertShowing = true;
  const presentation: AlertPresentation = { event, onDismiss, canShow };
  if (autoOpenAt !== undefined) presentation.autoOpenAt = autoOpenAt;
  showAlertInternal(presentation);
}

function presentAlertPayload(
  win: BrowserWindow,
  presentation: AlertPresentation,
  generation: number,
): void {
  if (!isCurrentPresentation(win, generation)) return;
  if (!presentation.canShow()) {
    consumePresentation(win, generation);
    return;
  }
  typedSend(
    win.webContents,
    IPC_CHANNELS.ALERT_SHOW,
    toAlertPayload(presentation.event, presentation.autoOpenAt),
  );
  win.webContents
    .executeJavaScript(
      `(() => {
          const app = document.getElementById("app");
          const card = document.querySelector(".alert-card");
          if (!app || !card) return 0;
          const appStyles = window.getComputedStyle(app);
          const paddingTop = Number.parseFloat(appStyles.paddingTop) || 0;
          const paddingBottom = Number.parseFloat(appStyles.paddingBottom) || 0;
          return Math.ceil(card.getBoundingClientRect().height + paddingTop + paddingBottom);
        })()`,
    )
    .then((contentHeight: number) => {
      if (!isCurrentPresentation(win, generation)) return;
      if (!presentation.canShow()) {
        consumePresentation(win, generation);
        return;
      }
      if (typeof contentHeight === "number" && contentHeight > 0) {
        const MIN_HEIGHT = 280;
        const MAX_HEIGHT = 480;
        const clamped = Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, Math.ceil(contentHeight)));
        win.setSize(500, clamped, false);
      }
      win.show();
    })
    .catch(() => {
      if (!isCurrentPresentation(win, generation)) return;
      if (!presentation.canShow()) {
        consumePresentation(win, generation);
        return;
      }
      win.show();
    });
}

function consumePresentation(win: BrowserWindow, generation: number): void {
  if (!isCurrentPresentation(win, generation)) return;
  reuseGeneration += 1;
  delete win.__alertOnDismiss;
  delete win.__alertUid;
  activePresentation = null;
  isAlertShowing = false;
  processNextAlert();
}

function showAlertInternal(presentation: AlertPresentation, waitForReady = false): void {
  const { event, onDismiss } = presentation;
  const startMs = new Date(event.startDate).getTime();
  reuseGeneration += 1;
  const generation = reuseGeneration;
  activePresentation = presentation;

  // Prefer reusing a hidden-but-alive window (same SECURE_WEB_PREFERENCES, no recreate).
  if (alertWindow && !alertWindow.isDestroyed()) {
    const win = alertWindow;
    win.__replacing = false;
    win.__alertUid = event.id;
    win.__alertStartMs = startMs;
    win.__alertGeneration = generation;
    win.__alertOnDismiss = onDismiss;
    applyAlertAlwaysOnTop(win);
    if (waitForReady) {
      win.once("ready-to-show", () => {
        if (!isCurrentPresentation(win, generation)) return;
        alertReady = true;
        presentAlertPayload(win, presentation, generation);
      });
      return;
    }
    if (win.isVisible()) {
      win.hide();
    }
    // Clear prior DOM then push the new synthetic generation's payload.
    void win.webContents
      .executeJavaScript(
        `(() => { const app = document.getElementById("app"); if (app) app.innerHTML = ""; return true; })()`,
      )
      .catch(() => undefined)
      .then(() => {
        if (!isCurrentPresentation(win, generation)) return;
        presentAlertPayload(win, presentation, generation);
      });
    return;
  }

  const chrome = platformWindowChrome("alert");
  const win = new BrowserWindow({
    width: 500,
    height: 480,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    alwaysOnTop: true,
    show: false,
    ...chrome,
    webPreferences: {
      preload: getPreloadPath(),
      ...SECURE_WEB_PREFERENCES,
    },
  });
  alertWindow = win;
  alertReady = false;
  win.__alertUid = event.id;
  win.__alertStartMs = startMs;
  win.__alertGeneration = generation;
  win.__alertOnDismiss = onDismiss;
  applyAlertAlwaysOnTop(win);

  loadWindowContent(win, "alert");

  win.once("ready-to-show", () => {
    if (!isCurrentPresentation(win, generation)) return;
    alertReady = true;
    presentAlertPayload(win, presentation, generation);
  });

  // Prefer hide over destroy so the next alert can reuse this window (same webPreferences).
  win.on("close", (closeEvent) => {
    if (win.__forceDestroy) return;
    closeEvent.preventDefault();
    // Identity + generation: ignore stale close after replacement/teardown.
    if (!isCurrentPresentation(win, win.__alertGeneration ?? -1)) return;
    if (!win.__replacing) {
      win.__alertOnDismiss?.();
    }
    win.__replacing = false;
    if (!win.isDestroyed()) win.hide();
    activePresentation = null;
    isAlertShowing = false;
    processNextAlert();
  });

  win.on("closed", () => {
    // Only the current window ref may clear shared module state.
    if (alertWindow !== win) return;
    activePresentation = null;
    alertReady = false;
    if ((win.__alertGeneration ?? -1) !== reuseGeneration) {
      alertWindow = null;
      return;
    }
    alertWindow = null;
    isAlertShowing = false;
  });
}

/** Force-destroy any alert window (shutdown / tests). Does not cancel pending browser-open. */
export function destroyAlertWindow(): void {
  if (queuedImmediate !== null) {
    clearImmediate(queuedImmediate);
    queuedImmediate = null;
  }
  reuseGeneration += 1;
  if (alertWindow && !alertWindow.isDestroyed()) {
    alertWindow.__forceDestroy = true;
    alertWindow.destroy();
  }
  alertWindow = null;
  activePresentation = null;
  alertReady = false;
  isAlertShowing = false;
  pendingAlerts.length = 0;
}

declare module "electron" {
  interface BrowserWindow {
    __alertUid?: EventId;
    __alertStartMs?: number;
    __alertGeneration?: number;
    __alertOnDismiss?: () => void;
    __replacing?: boolean;
    __forceDestroy?: boolean;
  }
}
