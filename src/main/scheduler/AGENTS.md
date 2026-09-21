# Scheduler — Auto-Open Browser Before Meetings

Core scheduling engine for polling calendar, scheduling per-event timers, updating tray countdowns, showing full-screen alerts, and opening meeting URLs. External code imports only `facade.ts` (or `graph.scheduler`); internal modules may cross-import each other directly.

## Files

| File                             | Role                                                                                                                                                                                                                                                                                                |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `facade.ts`                      | `createSchedulerFacade()` returns the sole public instance surface: start/stop/restart, `forcePoll`, dependency injection, `cancelPendingBrowserOpen`, and force-poll coalescing                                                                                                                    |
| `index.ts`                       | `scheduleEvents(events)` — snapshot → pure `planSchedule` → `interpretSchedulePlan`; also re-exports plan/types/late-join helpers for **internal** scheduler use (not a public package barrel)                                                                                                      |
| `core/plan-schedule.ts`          | Pure scheduling decisions (no Electron / timers)                                                                                                                                                                                                                                                    |
| `core/schedule-types.ts`         | `SchedulePlan` ADT / action types (includes **`set-snapshot`**)                                                                                                                                                                                                                                     |
| `adapters/interpret-schedule.ts` | Applies plan actions; **sole schedule-path snapshot writer** via `set-snapshot`                                                                                                                                                                                                                     |
| `poll.ts`                        | Fetches via `refreshCalendarPublication` (coordinator), publishes UI for any ok (content **or display** signature change), arms display horizon, schedules only live complete, else `suspendAutomation`; preserves calendar-provided Darwin aggregate diagnostics without interpreting their labels |
| `suspend-automation.ts`          | Cancels browser/alert/title/countdown/in-meeting timers; keeps lastKnownEvents                                                                                                                                                                                                                      |
| `state/`                         | Internal sliced state; see `state/AGENTS.md`. External imports forbidden                                                                                                                                                                                                                            |
| `browser-timer.ts`               | Browser-open timer + optional Notification; **does not write** `scheduledEventData`                                                                                                                                                                                                                 |
| `alert-timer.ts`                 | Full-screen alert timer: `alertLeadSeconds` before browser open                                                                                                                                                                                                                                     |
| `title-countdown.ts`             | 30-minute tray title window; requires snapshot entry; sleep blockers                                                                                                                                                                                                                                |
| `countdown.ts`                   | In-meeting title countdown and active event resolution                                                                                                                                                                                                                                              |
| `late-join.ts`                   | Late-join eligibility helpers                                                                                                                                                                                                                                                                       |
| `TIMER_MANAGEMENT_LOOP.md`       | Deep timer/sleep ownership notes                                                                                                                                                                                                                                                                    |

## Snapshot ownership

1. `planFutureTimers` emits **`set-snapshot` first**, then alert, conditional browser, title.
2. Interpreter applies `set-snapshot` to `scheduledEventData`.
3. `browser-timer` only arms open/notification — never first-writes snapshot.
4. Enables `autoOpenEnabled=false` title countdown + poll idempotence without manufacturing browser timers.

## Public API (`facade.ts` only)

| Method                          | Contract                                                                                                                                                                                                            |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `start()`                       | Bumps `pollEpoch`, initial `poll()`, arms recursive polling timeout                                                                                                                                                 |
| `stop()`                        | Cancels pending force poll, cancels the injected calendar refresh, resets resources preserving window (`preserveFiredState` optional), clears tray title                                                            |
| `restart()`                     | `stop({ preserveFiredState: true })` then start; timing settings use this method, while power uses `forcePoll`                                                                                                      |
| `forcePoll(options?)`           | Coordinated poll. `ForcePollReason`: `user` \| `auto` \| `watch` \| `power`. **`user` bypasses** 10s coalesce (tray Refresh); auto/watch/power coalesce. First settled poll emits startup `first-poll` when tracing |
| `republishUiForDisplayTick()`   | Force re-push last publication for wall-clock list refresh with no fetch. Exposed as `graph.scheduler.republishUiForDisplayTick()`.                                                                                 |
| `setWindow(w)`                  | BrowserWindow for typed push channels                                                                                                                                                                               |
| `setTrayTitleCallback(fn)`      | Tray title updater; scheduler never imports tray                                                                                                                                                                    |
| `initPowerCallbacks(callbacks)` | Poll interval + sleep-prevention hooks from `system/power.ts`                                                                                                                                                       |
| `getLastKnownEvents()`          | Last calendar result for join/hotkey logic                                                                                                                                                                          |
| `cancelPendingBrowserOpen(id)`  | Cancels browser timer and marks event fired (alert dismiss **and** successful join)                                                                                                                                 |

## Timing / settings

- Poll interval: 2 minutes on AC, 4 minutes on battery.
- Open-before: `settings.openBeforeMinutes` (**0–10**; 0 = at start).
- Auto-open gated by `settings.autoOpenEnabled` (no `arm-browser` when false).
- Alert lead: `settings.alertLeadSeconds` (default 60) before browser open.
- Native notifications gated by `settings.nativeNotifications` and quiet hours.
- Quiet hours: suppress **alert show + Notification** only; auto-open continues.
- Late-join: `settings.lateJoinGraceMinutes` (default 0 = off).
- Title countdown window: 30 minutes before start.
- Display horizon (wall-clock list refresh) is owned by `system/display-horizon.ts`, armed from poll publish; lifecycle wires ticks to `graph.scheduler.republishUiForDisplayTick()` plus tray force rebuild. Display-only, never auto-opens.
- In-meeting: poll resyncs when calendar `endMs` changes while already in progress.
- Schedule-ahead cap: 24 hours.
- Force-poll coalesce: 10 seconds after last completed poll for **auto/watch/power** only. **`reason: "user"`** always re-fetches immediately (clears any pending deferred auto timer).
- Consecutive errors threshold 3; counter caps at 4.
- `firedEvents` / `alertFiredEvents` TTL: `FIRED_EVENT_TTL_MS` = **15 minutes** (`state/state-timers.ts`).

## Automation eligibility

| Result                           | Poll behavior                                                                   |
| -------------------------------- | ------------------------------------------------------------------------------- |
| Live **complete**                | `scheduleEvents` (browser/alert/title as settings allow)                        |
| Live **partial** / offline-cache | `suspendAutomation` — cancel auto work; keep `lastKnownEvents` for display/join |
| Error                            | error counter / tray clear path                                                 |

Degraded results remain **explicitly joinable** via tray/popover/shortcut + `graph.join.byId`.

Successful live partial results, including Darwin's count-only diagnostic aggregate, replace `lastKnownEvents` just like other successful results. The scheduler does not translate diagnostic counts into labels and does not clear UI diagnostics. Calendar UI-state publication owns that boundary. Only live complete results schedule; partial and offline results suspend automation while preserving display and explicit-join data.

## Rules

- Outside scheduler, import from `scheduler/facade.js` only (or graph).
- Inside scheduler, do not import from `facade.js` (cycles).
- Do not expose raw mutable Maps/Sets outside `state/`.
- Auto-open suppression uses **`firedEvents` / `cancelPendingBrowserOpen` only** — never title-countdown `cancelledEvents`.
- Browser auto-open uses the opener injected into `createSchedulerFacade()`; URL construction uses `buildMeetUrl()`.
- Alert dismissal and a successful `graph.join.byId` both cancel pending browser open through the graph-local scheduler callback.
- Balance `preventSleep` / `allowSleep` on every terminal countdown path.
