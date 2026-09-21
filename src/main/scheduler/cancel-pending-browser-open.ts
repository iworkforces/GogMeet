import type { EventId } from "../../domain/entities/brand.js";
import { cancelBrowserTimer } from "./browser-timer.js";
import type { SchedulerState } from "./state/index.js";
import { FIRED_EVENT_TTL_MS } from "./state/state-timers.js";

export function cancelPendingBrowserOpenForState(
  id: EventId,
  schedulerState: SchedulerState,
  now: number = Date.now(),
): void {
  cancelBrowserTimer(id, schedulerState.timers);
  const endMs = schedulerState.scheduledEventData.get(id)?.endMs ?? now;
  schedulerState.firedEvents.set(id, endMs + FIRED_EVENT_TTL_MS);
}
