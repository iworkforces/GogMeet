# Tray Context Menu

Builds Electron `MenuItemConstructorOptions[]` for the tray icon. Pure builder — no `Menu` lifecycle, no IPC ownership (tray owns install/popup). No direct imports of join-meeting or scheduler facades.

## FILES

| File              | Role                                                                         |
| ----------------- | ---------------------------------------------------------------------------- |
| `meeting-menu.ts` | `buildMeetingMenuTemplate`, `buildCalendarTrayMenuTemplate`, `formatOfflineCacheAgeLabel`, `MenuCallbacks` |

## CONTRACT

### `MenuCallbacks`

| Callback                    | Required | Typical wiring                                                      |
| --------------------------- | -------- | ------------------------------------------------------------------- |
| `onAbout`                   | yes      | About window                                                        |
| `onOpenSettings`            | yes      | Settings window                                                     |
| `onJoinMeeting(id)`         | yes      | `graph.join.byId`                                                   |
| `onForcePoll()`             | yes      | tray: `forcePoll({ reason: "user" })` then force menu rebuild       |
| `onCheckForUpdates()`       | yes      | tray: `checkForUpdatesManual()`                                     |
| `getUpdaterPresentation?()` | optional | tray supplies live label/enabled; default idle “Check for Updates…” |
| `onConnectGoogle`           | optional | `graph.calendar.requestPermission` then user forcePoll + rebuild    |
| `onDisconnectGoogle`        | optional | `graph.calendar.disconnect`                                         |
| `onRetryPoll`               | optional | same as `onForcePoll` (user-intent)                                 |

### `buildMeetingMenuTemplate(events, showTomorrow, callbacks, status?, showCompletedToday?)`

- Filters all-day / ended events via domain `filterUpcomingMeetings` / `isMeetingInProgress`; Today / Tomorrow groups.
- “In progress” requires `start ≤ now < end` (not merely start ≤ now).
- Meetings with URLs use a **submenu**: Join (`onJoinMeeting`) + Copy Link (`clipboard` + `buildMeetUrl`).
- Meeting **labels** use domain `truncateMiddle` / `MEETING_TITLE_DISPLAY_MAX_CHARS` (**25**, middle `…`); full title stays on `MeetingEvent` (join/copy still use full event).
- Optional **Completed today** section when `showCompletedTodayMeetings` is true: domain `filterCompletedTodayMeetings`, exclude all-day, newest-ended first, non-interactive labels only (no Join/Copy); same title truncate. Toggle is display-only (no scheduler restart).
- Footer: Join Next Meeting (`pickJoinTarget` + `onJoinMeeting`), Refresh (`onForcePoll`), Settings…, **Check for Updates…** (`onCheckForUpdates`; label/enabled from updater UI state), About, Quit.
- `status: CalendarStatus` — optional last poll status from `facades/calendar-status.ts`.

### `buildCalendarTrayMenuTemplate(ui, showTomorrow, callbacks, status?, showCompletedToday?)`

- Input: `CalendarUiState` (permission, phase, errors, events, offline, oauthConfigured, `cacheAgeMs`).
- **Windows / non-Darwin:** Connect / Reconnect / Disconnect Google; misconfigured builds use user-facing “can’t connect” copy (not raw env-var labels).
- **Darwin:** meeting list when granted; uses same meeting rows + footer (no Google Connect block).
- **`phase === "limited"`:** disabled **“Auto-open paused — calendar incomplete”**, then the limited warning / `lastError`. On Darwin only, follow with disabled positive-count diagnostic rows (skipped records, malformed records, unexpected field count, invalid dates, missing IDs, duplicates). Google partials remain generic beyond the pause line.
- **`offline`:** `formatOfflineCacheAgeLabel(cacheAgeMs)` plus **“Auto-open paused — offline cache”** when events present.
- Same completed-today history rules as `buildMeetingMenuTemplate` when the preference is on.

## CONSUMERS

`meeting-menu.ts` owns menu templates. `tray.ts` takes `AppGraph` in `setupTray(win, graph)` and owns menu signatures, rebuild coalescing, installation, and popup lifecycle. It builds menus from UI state + cached meetings + `settings.showCompletedTodayMeetings`; the renderer is not involved.

| Trigger                                                    | Tray API                                                                        | Notes                                                                              |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `meeting-list-updated` / `calendar-status-updated`         | `requestTrayRebuild(win)`                                                       | Microtask-coalesces bus bursts. Theme changes call `tray.setImage` only            |
| Updater label listener                                     | `forceTrayMenuRefresh()`                                                        | Menu signature omits the updater label, so this path stays synchronous             |
| User Refresh / Retry / Connect-granted                    | `forcePoll({ reason: "user" })` then `requestTrayRebuild(win, { force: true })` | Immediate re-fetch (no 10s poll coalesce); force clears the menu signature        |
| Disconnect                                                 | `requestTrayRebuild(win, { force: true })` after `disconnect()`                 | Clears `cachedMeetings`. Does not poll                                              |
| Display-horizon ticks / completed-history toggle           | `forceTrayMenuRefresh()`                                                        | **Sync** force rebuild (wall-clock membership must update before next paint/popup) |
| Windows left-click                                         | sync `refreshContextMenu` + `popUpContextMenu`                                  | Soft `forcePoll({ reason: "auto" })` in parallel                                   |

Menu signature (`trayMenuSignature`) includes `showTomorrowMeetings`, wall-clock **upcoming** membership, `showCompletedTodayMeetings`, and all six Darwin aggregate counts. A changed count rebuilds the native menu; an equal aggregate summary skips a non-forced rebuild. Tray installs with `setContextMenu()` before first activation.

## Verification boundary

Tests prove Electron menu-template and menu-install behavior. Synthetic-state visual rendering in SystemUIServer was not controllable, so there is no claim of actual SystemUIServer visual automation.

## ANTI-PATTERNS

- Do not mutate `events` / `ui` arrays.
- Do not call `Menu.buildFromTemplate` here — tray owns lifecycle.
- Do not import `utils/join-meeting` or `scheduler/facade` — use callbacks.
- Do not open meetings with raw `shell.openExternal`.
