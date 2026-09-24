import type { MeetingEvent } from "../../domain/entities/meeting-event.js";
import type { EventId, IsoUtc } from "../../domain/entities/brand.js";
import { asIsoUtc } from "../../domain/entities/brand.js";
import { FIRED_EVENT_TTL_MS } from "./state/state-timers.js";
import { showAlert } from "../windows/alert-window.js";
import type { SchedulerRuntime } from "./runtime.js";
import { cancelPendingBrowserOpenForState } from "./cancel-pending-browser-open.js";
import { isInQuietHours } from "../../domain/entities/settings.js";
import type { TimersState } from "./state/state-timers.js";

/** Default alert lead before browser open (overridden by settings). */
const DEFAULT_ALERT_OFFSET_MS = 60 * 1000;

export const ALERT_OFFSET_MS: number = DEFAULT_ALERT_OFFSET_MS;

/**
 * Schedule an alert timer for a meeting event.
 * Fires `alertLeadMs` before the browser open to show a full-screen overlay.
 */
export function scheduleAlertTimer(
  runtime: SchedulerRuntime,
  event: MeetingEvent,
  effectiveDelay: number,
  endMs: number,
  shouldAbort?: () => boolean,
  alertLeadMs: number = DEFAULT_ALERT_OFFSET_MS,
  openAtMs?: number,
): void {
  const state = runtime.state;
  const generation = runtime.lifecycleGeneration;
  const { alertTimers, alertFiredEvents, alertOwners } = state;
  cancelAlertTimer(event.id, state);
  const owner = {};
  alertOwners.set(event.id, owner);

  const alertDelayMs = Math.max(0, effectiveDelay - alertLeadMs);
  const autoOpenAt: IsoUtc | undefined = (() => {
    if (openAtMs === undefined) return undefined;
    const branded = asIsoUtc(new Date(openAtMs).toISOString());
    return branded.ok ? branded.value : undefined;
  })();

  const alertHandle = setTimeout(() => {
    if (
      runtime.state !== state ||
      runtime.lifecycleGeneration !== generation ||
      alertTimers.get(event.id) !== alertHandle ||
      alertOwners.get(event.id) !== owner
    )
      return;
    if (shouldAbort?.()) return;
    alertTimers.delete(event.id);
    alertFiredEvents.set(event.id, endMs + FIRED_EVENT_TTL_MS);
    const isCurrent = (): boolean =>
      runtime.state === state &&
      runtime.lifecycleGeneration === generation &&
      alertOwners.get(event.id) === owner;
    const canShow = (): boolean => {
      if (!isCurrent()) return false;
      const settings = runtime.dependencies.settings.get();
      return !(
        settings.quietHoursEnabled &&
        isInQuietHours(new Date(), settings.quietHoursStart, settings.quietHoursEnd)
      );
    };
    if (!canShow()) return;
    try {
      showAlert(
        event,
        () => {
          if (isCurrent()) cancelPendingBrowserOpenForState(event.id, state);
        },
        autoOpenAt,
        canShow,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("[scheduler] Alert presentation failed:", message);
    }
    console.log(
      `[scheduler] Alert shown for "${event.title}" (${Math.round(alertDelayMs / 1000)}s before open)`,
    );
  }, alertDelayMs);
  alertTimers.set(event.id, alertHandle);
}

/**
 * Cancel an alert timer for a specific event.
 */
export function cancelAlertTimer(eventId: EventId, state: TimersState): void {
  state.alertOwners.delete(eventId);
  const handle = state.alertTimers.get(eventId);
  if (handle) {
    clearTimeout(handle);
    state.alertTimers.delete(eventId);
  }
}
