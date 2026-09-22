# Scheduler — Auto-Open Browser Before Meetings

Polls the calendar, arms per-event timers, and opens join URLs. Outside this folder, import `facade.ts` or use `graph.scheduler`. Inside, do not import `facade.ts` (cycles).

## Files

| File | Role |
|------|------|
| `facade.ts` | `createSchedulerFacade`. `resetRuntimeState` lives here |
| `runtime.ts` | `SchedulerRuntime`, `createSchedulerRuntime` |
| `index.ts` | `scheduleEvents(runtime, events)` → `planSchedule` → `interpretSchedulePlan`. Internal re-exports, not a package barrel |
| `core/plan-schedule.ts` | Pure decisions. No Electron or timers. Drops all-day events |
| `core/schedule-types.ts` | `ScheduleAction` / `SchedulePlan` / `ScheduleSnapshot` |
| `adapters/interpret-schedule.ts` | Applies the plan. Must not import `facade.ts` |
| `poll.ts` | `refreshCalendarPublication`; arms horizon; schedules live complete; else `suspendAutomation` |
| `suspend-automation.ts` | Cancels auto timers; keeps `lastKnownEvents` |
| `cancel-pending-browser-open.ts` | `cancelPendingBrowserOpenForState` |
| `browser-timer.ts` | Open + optional Notification. Does not write `scheduledEventData` |
| `alert-timer.ts` | Alert `alertLeadSeconds` before open |
| `title-countdown.ts` | 30-minute tray title window |
| `countdown.ts` | In-meeting title |
| `late-join.ts` | `isLateJoinEligible` |
| `state/` | See `state/AGENTS.md` |

`ScheduleAction` includes `set-snapshot`, `update-snapshot`, `start-in-meeting`, `update-title-only`, arm/cancel for browser, alert, and title, plus fired/in-meeting bookkeeping. The interpreter writes `scheduledEventData` from `set-snapshot`, `start-in-meeting`, and `update-snapshot`.

## Public API

| Method | Contract |
|--------|----------|
| `start()` | Bumps `pollEpoch`, polls, arms the interval |
| `stop(options?)` | Cancels refresh, `resetRuntimeState`, clears tray title |
| `restart()` | `stop({ preserveFiredState: true })` then start. Timing keys use this |
| `forcePoll({ reason })` | `user` skips the 10s coalesce. `auto` / `watch` / `power` coalesce |
| `republishUiForDisplayTick()` | Re-pushes the last publication. No fetch |
| `cancelPendingBrowserOpen(id)` | Cancels the browser timer and marks the event fired |
| `getLastKnownEvents()` | Last `CalendarResult` for join |

Poll interval: 2 min AC / 4 min battery. `openBeforeMinutes` is 0–10. Quiet hours mute alert show and Notification only. Late-join grace defaults to 0. Schedule-ahead cap is 24h. `FIRED_EVENT_TTL_MS` is 15 min. Consecutive-error warn threshold is 3; the counter caps at 4. The first settled poll emits startup `first-poll` when tracing.

## Automation

| Result | Poll |
|--------|------|
| Live complete | `scheduleEvents` |
| Live partial or offline-cache | `suspendAutomation`; keep events for display and `graph.join.byId` |
| Error | `handlePollFailure` in `poll.ts` |

Display horizon is `system/display-horizon.ts`. It never opens URLs. Auto-open suppression uses `firedEvents` / `cancelPendingBrowserOpen`, never title-countdown `cancelledEvents`. The opener is the one injected into `createSchedulerFacade`. URL construction uses `buildMeetUrl()`.
