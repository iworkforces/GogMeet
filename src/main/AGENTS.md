# Main Process: Electron Main

Electron main owns lifecycle, tray and menu, BrowserWindows, system APIs, typed IPC, scheduler orchestration, settings persistence, and calendar access through pluggable providers. `app/lifecycle.ts` starts and stops the process. `composition/app-graph.ts` wires its production dependencies.

## Files and subsystems

| Area              | Files                                                                               | Responsibility                                                                                                      |
| ----------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Root              | `index.ts`, `tray.ts`, `events.ts`, `googlemeet-events.swift`                       | Single-instance bootstrap, production tray, main bus, and primary Darwin Swift source                               |
| `app/`            | `lifecycle.ts`, `ipc.ts`, `performance-probe*`                                      | Lifecycle, IPC registration, and private packaged measurement probes                                                |
| `composition/`    | `app-graph.ts`, `create-test-app-graph.ts`                                          | Production graph construction and test graph delegation                                                             |
| `application/`    | `ports/`, `use-cases/`                                                              | Port contracts and use-case projections with no Electron, Node I/O, or Swift                                        |
| `infrastructure/` | `settings/`, `electron/`                                                            | `JsonSettingsStore` and `ShellMeetingOpener` only                                                                   |
| `facades/`        | calendar, watcher, status, settings                                                 | Main-process instance factories and UI snapshot publication                                                         |
| `calendar/`       | factory, providers, `google-http`, auth, offline cache, refresh coordinator         | Provider implementation, OAuth, Google transport and sync, offline cache, coordinated refreshes, and probe provider |
| `platform/`       | `os.ts`                                                                             | `isDarwin` and `isWin32`                                                                                            |
| `windows/`        | about, update, alert, settings                                                      | BrowserWindow ownership, including hide and reuse for alert and settings windows                                    |
| `system/`         | power, display horizon, shortcuts, auto-launch, auto-updater, notification          | OS integration and wall-clock display refreshes                                                                     |
| `scheduler/`      | facade, core, adapters, timers                                                      | Polling, schedule planning, automatic joins, alerts, and timer state                                                |
| `swift/`          | helper process, binary manager/cache/compiler, parser, sidecar, occurrence identity | EventKit helper (dual Swift sources), reachable only from the Darwin provider                                       |
| `ipc-handlers/`   | per-domain handlers                                                                 | Typed IPC handlers that receive `AppGraph`                                                                          |
| `menu/`           | `meeting-menu.ts`                                                                   | Tray menu templates, including limited, offline, and completed-today rows                                           |
| `utils/`          | window helpers, logging, performance trace, system settings                         | Main-process utilities                                                                                              |

## Lifecycle order

`initializeApp(win)` creates and stores `AppGraph` before IPC, warms the calendar provider in the background, loads settings and permission status, installs the tray, wires scheduler callbacks and display-horizon refreshes, then starts scheduler and watcher. Power, shortcuts, notifications, auto-launch, and the packaged non-portable updater follow. Darwin may request not-determined calendar permission. Windows OAuth starts only from tray or Settings.

`shutdownApp()` cleans up power and display-horizon listeners, destroys cached windows, stops scheduler and watcher, unregisters shortcuts, and clears the active graph. Resume and unlock invalidate the calendar permission cache, revive the watcher, and request `graph.scheduler.forcePoll({ reason: "power" })`.

## Calendar publication and automation

- Calendar calls use `facades/calendar.ts`, never provider factories directly.
- `refreshCalendarPublication()` and `requestCalendarRefresh()` share one in-flight fetch. A concurrent request queues at most one follow-up. All waiters receive the final `CalendarPublication` for that chain. The coordinator assigns monotonic `publicationGeneration`, retains only the final publication, and cancellation aborts provider work before a later request starts a new lifecycle epoch.
- `CalendarPublication` is `{ publicationGeneration, result }`. It is the coordinated refresh and IPC envelope. `CalendarResult` is the underlying live complete or partial, offline-cache, or error outcome.
- `GetMeetings` projects results into the calendar UI snapshot. Complete live data becomes `ready` or `empty`; live partial becomes `limited`; offline cache becomes `offline-cached` with `cacheAgeMs`; errors become `error`.
- Partial results keep valid events. The scheduler keeps those events for tray, popover, shortcuts, and explicit joins, then suspends browser, alert, title, countdown, and in-meeting automation. Only live complete results schedule automatic work.
- Darwin partial results may include the optional count-only `darwinPartialRefreshDiagnostics` aggregate. It is not a generic provider feature. It clears on complete live, offline-cache, error, and poll-level error states. Native macOS tray code may render those disabled diagnostic rows; renderer production UI does not present diagnostic labels or tokens.

## Architecture rules

- `events.ts` decouples scheduler, power, calendar UI, and tray through `meeting-list-updated`, `calendar-status-updated`, and `power-state-changed`.
- `AppGraph` owns lifecycle, IPC, tray, and shortcut dependencies. Its factory creates graph-local calendar, settings, scheduler, join, watcher, and one opener; it finalizes overrides before downstream closures use them.
- Outside `scheduler/`, import only `scheduler/facade.ts` or use `graph.scheduler`.
- `swift/` may be imported only by `calendar/providers/darwin-eventkit.ts` and `swift/**`. Facades must not import `swift/*` or `calendar/auth/*`.
- Calendar ports require `AbortSignal`. `showCompletedTodayMeetings` is display-only and does not restart the scheduler.
- Meeting host detection belongs to `domain/services/platform.ts`; OS detection belongs to `platform/os.ts`.

## IPC, security, and tray

- Use `typedHandle` and `typedSend`, and validate senders for renderer-originated IPC.
- Meeting egress goes through the allowlisted `ShellMeetingOpener`, exposed as `graph.opener`. Explicit joins use `graph.join.byId`.
- Renderers stay sandboxed and context-isolated with no Node integration.
- Install the tray context menu before activation. Bus-driven rebuilds are microtask-coalesced; display-horizon ticks and the completed-history setting force an immediate rebuild.
- A user tray refresh bypasses the 10-second auto, watch, and power coalesce. macOS clicks use a soft refresh; Windows also rebuilds from cache before opening its context menu.

## Packaged probes

- `GOGMEET_PERF_PROBE` is a lab and CI facility, never a product setting. Its only modes are `startup`, `tray`, `alert`, and `safe-storage`.
- Preflight runs before calendar or token adapters. It requires a packaged app, `GOGMEET_PERF_TRACE=1`, and a real `--user-data-dir` beneath `os.tmpdir()` whose supplied and resolved leaf names start with `gogmeet-perf-probe-`.
- A bad preflight blocks probe execution, and the probe calendar factory throws rather than reaching EventKit or Google. Startup uses `initializeApp({ probeSafe: true })`, which suppresses external mutators.
- The tray probe drives production `setupTray` and rebuild paths with synthetic events and UI snapshots. The alert probe drives production `showAlert` and alert-window lifecycle with synthetic meetings. The safe-storage probe uses the real encrypted token and offline-cache adapters with synthetic values.

## Notes

- Both Darwin Swift sources are packaged and `asarUnpack`ed: `googlemeet-events.swift` and `swift/event-occurrence-identity.swift`. Integrity hash digests identity + `"\n"` + events (see `swift/AGENTS.md`). PR check runs `check:swift-package-layout`.
- Power resume/unlock and AC/battery call `forcePoll({ reason: "power" })` (not full `restartScheduler`).
- Google OAuth/sync/offline files use owner-only modes (`utils/secure-fs.ts`).
- Windows Google Calendar requires `GOOGLE_OAUTH_CLIENT_ID` at runtime or package time (Settings uses user-facing copy when missing).
- The fixture provider is available only to unpackaged builds with `GOGMEET_CALENDAR_FIXTURE`.
- `index.ts` configures `electron-log` through `utils/log.ts` and sets Chromium `log-level=3`.
