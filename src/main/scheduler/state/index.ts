import { type TimersState, createTimersState } from "./state-timers.js";
import { type DisplayState, createDisplayState } from "./state-display.js";
import { type PollState, createPollState } from "./state-poll.js";
import { type RuntimeState, createRuntimeState } from "./state-runtime.js";

export type { ScheduledEventSnapshot } from "./state-timers.js";
export type { PowerCallbacks } from "./state-runtime.js";
export {
  clearInMeetingState,
  clearSchedulerResources,
  cancelStaleEntries,
} from "./state-cleanup.js";

export interface SchedulerState extends TimersState, DisplayState, PollState, RuntimeState {}

export function createSchedulerState(): SchedulerState {
  return {
    ...createTimersState(),
    ...createDisplayState(),
    ...createPollState(),
    ...createRuntimeState(),
  };
}
