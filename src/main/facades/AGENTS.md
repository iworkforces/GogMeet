# facades/

## Overview

Facades provide the main-process application surface for calendar access, calendar watching, last-poll status, and persistent settings. They are not pure domain code. Production callers usually use `AppGraph`; factories return owner-local instances with their own state and dependencies.

## Files

| File                  | Exports                                         | Purpose                                                                                                                                                                             |
| --------------------- | ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `calendar.ts`         | `createCalendarFacade()`                        | Returns an instance that lazily resolves provider ports, owns calendar UI snapshot and permission cache, connects `GetMeetings` to the coordinator, and publishes snapshot changes. |
| `calendar-watcher.ts` | `createCalendarWatcher()`                       | Returns an instance with owner-local watcher state and an injected coalesced scheduler poll request.                                                                                |
| `calendar-status.ts`  | `recordCalendarResult`, `getLastCalendarStatus` | Stores reduced tray status: `unknown`, successful timestamp, or error code and message.                                                                                             |
| `settings.ts`         | `createSettingsFacade()`                        | Returns an instance over `JsonSettingsStore`; port methods are load, get, and update, while save is adapter-specific.                                                               |

## Calendar snapshot and publication

- `CalendarUiState` is the synchronous tray and Settings snapshot. Its fields are permission, phase, last error, account email, nullable events, offline flag, OAuth configuration, nullable Darwin partial diagnostics, and nullable offline `cacheAgeMs`.
- `GetMeetings` updates and publishes the snapshot for every provider result. Complete live results clear diagnostics and cache age. Offline results clear diagnostics and set cache age. Errors clear diagnostics and cache age. `reportCalendarPollError()` also clears diagnostics.
- A live partial result becomes `limited`, retains its valid events, and may carry `darwinPartialRefreshDiagnostics`. The aggregate is optional, count-only, and Darwin-specific. Facades do not add diagnostic channels or renderer presentation.
- `refreshCalendarPublication()` returns the coordinator's `CalendarPublication`. `getCalendarEventsResult()` returns its enclosed result, and `getLastPublication()` returns the last completed coordinator publication.
- The refresh coordinator permits one provider call at a time. Requests during that call share the chain and queue at most one follow-up. Waiters resolve to the final publication in the chain. Cancellation aborts active provider work and invalidates that lifecycle's chain.
- Scheduler policy handles automation eligibility: live complete can schedule; partial and offline snapshots remain display and explicit-join data while automatic work is suspended.

## Boundaries and call paths

- Do not import `swift/*` or `calendar/auth/*` here. Use `CalendarPort` methods for account label, warmup, OAuth state, watch, and revival.
- Provider implementation belongs in `../calendar/`: Darwin EventKit, Google Calendar, Google HTTP, OAuth and sync-token storage, offline cache, and coordinator.
- `calendar-watcher.ts` uses `getCalendarPort()` and requests `forcePoll({ reason: "watch" })`. Providers without `startWatch` remain poll-only.
- Calendar status intentionally has no source, completeness, event, cache-age, or diagnostic data. Menu presentation combines it with the full calendar UI snapshot when needed.
- Invalidate the calendar permission cache before the graph-local power `forcePoll` after resume. Lifecycle may auto-request only on Darwin; Windows Connect remains a tray or Settings action.

## Settings rules

- `settings.ts` uses `domain/entities/type-guards`, not Swift guards.
- Schema v3 includes timing and automation settings plus display-only `showCompletedTodayMeetings` and `showTomorrowMeetings`. `openBeforeMinutes` is 0 through 10. The full UI is in `renderer/settings`.
