/**
 * Suspend automatic scheduler work for degraded calendar data (partial/offline).
 * Cancels browser/alert/title/countdown/in-meeting timers and balances sleep blockers
 * while leaving lastKnownEvents untouched for display and explicit joins.
 */

import { resolveActiveTitleEvent } from "./countdown.js";
import type { SchedulerRuntime } from "./runtime.js";

/**
 * Cancel all pending automatic browser / alert / title / countdown / late-join /
 * in-meeting work and return sleep ownership to zero for pre-meeting countdowns.
 * Does **not** clear `lastKnownEvents` or fired-suppression maps.
 */
export function suspendAutomation(runtime: SchedulerRuntime): void {
  const { state } = runtime;
  for (const handle of state.timers.values()) clearTimeout(handle);
  state.timers.clear();

  for (const handle of state.alertTimers.values()) clearTimeout(handle);
  state.alertTimers.clear();
  state.alertOwners.clear();

  for (const handle of state.titleTimers.values()) clearTimeout(handle);
  state.titleTimers.clear();

  // Pre-meeting countdown intervals own display sleep blockers.
  for (const handle of state.countdownIntervals.values()) {
    clearInterval(handle);
    state.powerCallbacks?.allowSleep?.();
  }
  state.countdownIntervals.clear();

  for (const handle of state.clearTimers.values()) clearTimeout(handle);
  state.clearTimers.clear();

  for (const handle of state.inMeetingIntervals.values()) clearInterval(handle);
  state.inMeetingIntervals.clear();

  for (const handle of state.inMeetingEndTimers.values()) clearTimeout(handle);
  state.inMeetingEndTimers.clear();

  state.scheduledEventData.clear();
  state.cancelledEvents.clear();
  state.activeInMeetingEventId = null;
  state.titleDirty = true;
  state.inMeetingDirty = true;
  resolveActiveTitleEvent(runtime);

  console.debug("[scheduler] Suspended automation for degraded calendar result");
}
