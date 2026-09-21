# Main Process Test Suite

## OVERVIEW

Vitest `main` project: Node environment plus `tests/setup.main.ts` Electron mock. Covers Electron main, composition graph, scheduler, calendar providers, Swift bridge, IPC, windows, tray/menu, system adapters, settings, preload.

## STRUCTURE

```text
tests/main/                         # flat *.test.ts (no scheduler/ subdirectory)
├── app-graph*.test.ts / lifecycle / app-bootstrap / index-bootstrap
├── scheduler-*.test.ts             # facade, poll, timers, plan-schedule, auto-open off, …
├── swift/                          # swift-helper-process, event-parser, event-occurrence-identity
├── swift-binary-manager / swift-guards / calendar-watch-sidecar  # top-level (not under swift/)
├── calendar*.test.ts / google-* / fixture / offline-cache / refresh-coordinator / watcher
├── performance-probe* / performance-trace* / shell-meeting-opener / guardrails-security / after-pack
├── ipc*.test.ts                    # channels, typed wrappers, handlers, registrar
│                                   # ipc-handlers-scheduler.test.ts = negative (module must not exist)
├── tray / meeting-menu / *-window / window-chrome / dock-visibility
├── system adapters                 # power, display-horizon, shortcuts, notification, auto-launch, updater
└── utils                           # package-info, system-settings, log, …
```

Domain-pure suites (brand, url-extract, meet-url build, pick-join-target, settings defaults, etc.) live under **`tests/domain/`**, not here.

## SCHEDULER SUITES

| Area                 | Files                                                                                                                                                      |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| State machine        | `scheduler.test.ts`, `scheduler-state-replace.test.ts`                                                                                                     |
| Poll/restart races   | `scheduler-poll.test.ts`, `scheduler-facade-force-poll.test.ts` (user vs auto coalesce), `scheduler-restart-preserves-suppression.test.ts`                 |
| Pure plan            | `scheduler-plan-schedule.test.ts`                                                                                                                          |
| Browser/alert timers | `scheduler-browser-timer.test.ts`, `scheduler-alert-timer.test.ts`, `scheduler-auto-open-deadline.test.ts`, `scheduler-facade-cancel-browser-open.test.ts` |
| Late-join            | `late-join.test.ts` (`firedEvents` only)                                                                                                                   |
| Tray countdown       | `scheduler-title-countdown.test.ts`, `scheduler-countdown.test.ts`                                                                                         |

Use `vi.advanceTimersByTimeAsync()` when promise callbacks may flush. Refresh live Map/Set refs after scheduler resets when a suite stores local state refs.

## CALENDAR / PROVIDERS / SWIFT

- `calendar.test.ts` — facade over provider mocks, permission cache, provenance fixtures, and one count-only Darwin provider warning with no event details or other private payload.
- `calendar-factory.test.ts` / `fixture-calendar.test.ts` — factory selection, fixture gate, **probe preflight fail-closed** (no EventKit/Google fallthrough).
- `google-http.test.ts` — bounded transport (timeout, body limits, abort).
- `google-oauth.test.ts` / `google-token-store.test.ts` — force/if-needed refresh, preserve ciphertext.
- `google-sync-tokens.test.ts` — encrypted nextSyncToken map (schema v1).
- `google-calendar.test.ts` — 401 force refresh, offline ok, complete/partial, **pagination-limit** (list/full/incremental + multi-cal partial), **incremental 429** (no full fallback).
- `offline-cache.test.ts` — encrypt round-trip (schema v1 metadata + ended filter).
- `calendar-refresh-coordinator.test.ts` — single-flight, follow-up queue, cancel, publication generation.
- `swift/swift-helper-process.test.ts` — real spawn bounds + kill paths.
- `swift/event-parser.test.ts` — field parsing, diagnostics, error classification, and aggregation into the fixed Darwin diagnostic counts.
- `swift/event-occurrence-identity.test.ts` — darwin-only real `swiftc` of occurrence-aware uid helper (long timeout).
- `swift-binary-manager.test.ts` — dual-source integrity hash/compile (distinct fixtures + order freeze) + integrity-only recompile (top-level).
- `lifecycle.test.ts` / `power.test.ts` — power reasons → `forcePoll({ reason: "power" })` (no full restart on wake).
- `swift-guards.test.ts` / `calendar-watch-sidecar.test.ts` — guards + watch; stream ceilings + overflow; restart budget.
- `performance-trace.test.ts` / `performance-trace-file.test.ts` — bounded buffer + atomic flush.
- `performance-probe.test.ts` / `performance-probe-drivers.test.ts` — contract, private provider, tray/alert/safe-storage drivers.
- `shell-meeting-opener.test.ts` / `guardrails-security.test.ts` / `after-pack.test.ts` — egress, permanent freezes (`MAX_PAGES`, watch=one-shot, trace caps, probe prefix).

`scheduler-poll.test.ts` covers retained partial events for display and manual join while `suspendAutomation` cancels automatic work. `meeting-menu.test.ts`, `tray.test.ts`, and `tray-rebuild-coalesce.test.ts` cover Darwin-only diagnostic rows, all diagnostic counts in the menu signature, and a rebuild when those counts change.

Provider tests must pass `AbortController` signal into `getEvents`. Prefer `.As<T>()` for Electron mock shapes.

## IPC / PRELOAD / GRAPH

- Channel contracts: `ipc-channels.test.ts` (includes `APP_JOIN_MEETING`), `ipc-types.test.ts`.
- Boundary helpers: `ipc-handlers-shared.test.ts`.
- Domain handlers: `ipc-handlers-*.test.ts` — pass `testAppGraph()`; cover Result open + join-by-id; settings selective restart vs display-only `showCompletedTodayMeetings` tray rebuild.
- Registrar: `ipc-registrar.test.ts` tracks every handler from `src/main/app/ipc.ts`.
- Preload API: `preload.test.ts` — joinMeeting, domain allowlist, invoke/send/listeners.
- Composition: `app-graph.test.ts` covers graph-local construction, override isolation, the shared opener injection, and test graph delegation. Lifecycle asserts graph-first init + `initAutoUpdater` + resume revive.

## WINDOWS / SYSTEM / UTILS

- Tray/menu: `tray.test.ts` (setup with graph, menus, Windows left-click, history signature, user Refresh await+rebuild), `meeting-menu.test.ts` (join/poll callbacks + completed-today rows), `tray-rebuild-coalesce.test.ts` (microtask coalesce + reschedule start/end signature + force path).
- Windows: `alert-window` (queue + hide/reuse + destroy + **generation-safe** immediate/height/close + `autoOpenAt` on queued entries), `settings-window` (520×760), `about-window` (320×360, aurora CSS/HTML, CSP, https-only repo, no Close, Esc/traffic lights, `isSafeAboutRepositoryUrl`), `update-window` (340×340 to 400, aurora, Esc dismiss or action buttons, checking/result phases), `browser-window`, `window-chrome` (`DIALOG_BACKGROUND_COLOR` `#0d1117`), `dock-visibility`. Keep update-window version fixtures aligned with the current `package.json` version; this guide intentionally does not pin a release number.
- System: `power`, `display-horizon`, `shortcuts` (graph + `join.byId`), `notification`, `auto-launch`, `auto-updater` (portable skip + unpackaged no-op).
- Utils: `system-settings.test.ts`, `package-info.test.ts`, `settings.test.ts`, `json-settings-store.test.ts` (v3 migrate), `log.test.ts`, `safe-storage-performance.test.ts`.

## MOCKING RULES

- Default Electron mock in `tests/setup.main.ts`.
- Inline `vi.mock("electron", ...)` when a suite needs isolated import-time behavior.
- Mock source modules with `.js` specifiers.
- Dynamic import tests use `vi.resetModules()` before `await import(...)`.
- Prefer `testAppGraph` over ad-hoc partial graph objects.

## ANTI-PATTERNS

- Never skip sender validation coverage for IPC handlers.
- Never assert raw `setTimeout` implementation details when observable state changes can be tested.
- Never import renderer code into main tests; preload tests are the documented bridge exception.
- Do not reintroduce domain-pure suites here — put them under `tests/domain/`.
