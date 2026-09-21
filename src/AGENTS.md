# src/ — Source Root

Application source is split by Electron process and Clean Architecture layers. Keep process boundaries strict: `main/` owns Node/Electron APIs, `preload/` is the only context bridge, `renderer/` is browser-only UI, `domain/` is pure logic, and `shared/` is IPC/DTO contracts.

## Build outputs

| Source      | Entry                  | Output                  | Runtime                                    |
| ----------- | ---------------------- | ----------------------- | ------------------------------------------ |
| `main/`     | `src/main/index.ts`    | `lib/main/index.cjs`    | Electron main (CJS)                        |
| `preload/`  | `src/preload/index.ts` | `lib/preload/index.cjs` | sandboxed preload (CJS)                    |
| `renderer/` | 3 entries              | `lib/renderer/`         | BrowserWindow pages (ESM)                  |
| `domain/`   | imported modules       | bundled into consumers  | pure, no side effects                      |
| `shared/`   | imported modules       | bundled into consumers  | contracts + cast side-effect when imported |

## Directory map

| Path                                 | Role                                                                                                                                                                                                                                   |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `domain/`                            | Pure entities, policies, services. See `domain/AGENTS.md`.                                                                                                                                                                             |
| `shared/`                            | IPC maps + thin DTOs + `utils/as.ts` + `escape-html` + `app-icon-aurora`. See `shared/AGENTS.md`.                                                                                                                                      |
| `main/composition/`                  | `createAppGraph`, `createTestAppGraph`, and graph-local dependency wiring.                                                                                                                                                             |
| `main/application/`                  | Ports + use cases (no Electron).                                                                                                                                                                                                       |
| `main/infrastructure/`               | Driven adapters: JsonSettingsStore, ShellMeetingOpener.                                                                                                                                                                                |
| `main/facades/`                      | Calendar, watcher, status, and settings instance factories.                                                                                                                                                                            |
| `main/calendar/`                     | Provider factory (probe preflight first), Darwin/Google/fixture/**performance-probe**, **google-http**, auth (OAuth + tokens + **sync tokens**), offline cache, **refresh-coordinator**.                                               |
| `main/scheduler/`                    | Facade + pure `planSchedule` + interpret adapters.                                                                                                                                                                                     |
| `main/ipc-handlers/`                 | Typed IPC; handlers receive `AppGraph`.                                                                                                                                                                                                |
| `main/app/`                          | Lifecycle + IPC registrar + packaged **performance-probe** contract/dispatcher/drivers.                                                                                                                                                |
| `main/menu/`, `tray.ts`, `events.ts` | Tray menu builders + tray lifecycle (optional completed-today history; microtask-coalesced `requestTrayRebuild` + sync `forceTrayMenuRefresh`); bus events `meeting-list-updated` / `calendar-status-updated` / `power-state-changed`. |
| `main/index.ts`                      | Single-instance bootstrap; popover BrowserWindow **360×480**.                                                                                                                                                                          |
| `main/system/`                       | Power, display-horizon, shortcuts, auto-launch, auto-updater, notifications.                                                                                                                                                           |
| `main/windows/`                      | About (320×360, aurora, no Close), Update (340×340–400, aurora), alert, settings (Dock + hide-cache) BrowserWindows.                                                                                                                   |
| `main/utils/`                        | CSP/window helpers, **performance-trace**, logging, and system settings.                                                                                                                                                               |
| `main/platform/`                     | OS predicates (`isDarwin` / `isWin32`).                                                                                                                                                                                                |
| `main/swift/`                        | EventKit helper compile/run/JSON Lines + **swift-helper-process** + **event-occurrence-identity.swift** (Darwin leaf; dual-source hash/compile).                                                                                       |
| `preload/`                           | `window.api` bridge.                                                                                                                                                                                                                   |
| `renderer/`                          | popover, settings, alert UIs.                                                                                                                                                                                                          |
| `assets/`                            | tray icons (mac 18/36 + win 16/32) via `nativeImage.createFromPath()`; `about-icon.svg` for About/Update data: URI + Settings brand (bundled).                                                                                         |

## Where to change things

| Task                          | Files                                                                                                                                      |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Add IPC channel               | `shared/ipc-channels.ts` → `main/ipc-handlers/*` → `preload/index.ts` → renderer                                                           |
| Composition / DI              | `main/composition/app-graph.ts`                                                                                                            |
| Calendar result / phases      | `domain/entities/calendar-result.ts`, `calendar-ui-state.ts`                                                                               |
| Calendar publication envelope | `domain/entities/calendar-publication.ts` (`publicationGeneration` + `result`)                                                             |
| Calendar facade / UI status   | `main/facades/calendar.ts`, `main/events.ts`                                                                                               |
| Calendar backends             | `main/calendar/factory.ts`, `providers/*`, `auth/*`, `google-http.ts`                                                                      |
| Google incremental sync       | `main/calendar/auth/google-sync-tokens.ts` + `providers/google-calendar.ts` (ADR 0002)                                                     |
| Single-flight refresh         | `main/calendar/refresh-coordinator.ts` via facade `refreshCalendarPublication`                                                             |
| Meeting URL extract           | `domain/services/url-extract.ts` (+ Swift `findMeetUrl`)                                                                                   |
| Allowlist / validate          | `domain/policies/meet-url-allowlist.ts`, `domain/services/url-validation.ts`                                                               |
| buildMeetUrl / platform host  | `domain/services/build-meet-url.ts`, `domain/services/platform.ts`                                                                         |
| Wall-clock membership         | `domain/services/meeting-time.ts` (in-progress / upcoming / completed-today / horizon)                                                     |
| Open / join meeting           | `infrastructure/electron/shell-meeting-opener.ts`, `application/use-cases/join-meeting.ts`, `graph.join.byId`                              |
| Settings schema + parse       | `domain/entities/settings.ts` (schema **v3**), `domain/services/settings-parse.ts`                                                         |
| Settings persistence          | `infrastructure/settings/json-settings-store.ts` via `facades/settings.ts`                                                                 |
| Scheduler                     | `main/scheduler/facade.ts` only from outside scheduler                                                                                     |
| Display horizon               | `main/system/display-horizon.ts` (wall-clock re-filter; no automation)                                                                     |
| Swift EventKit wire           | `main/swift/*` (incl. `swift-helper-process.ts`, `event-occurrence-identity.swift`), `main/googlemeet-events.swift`                        |
| Unchecked casts               | `shared/utils/as.ts` (`.As<T>()` / free `As`)                                                                                              |
| Opt-in perf marks             | `main/utils/performance-trace.ts` + `performance-trace-file.ts`                                                                            |
| Packaged probes (lab)         | `main/app/performance-probe*.ts`, `performance-probes/*`                                                                                   | never set `GOGMEET_PERF_PROBE` for product installs                              |
| OS branching                  | `main/platform/os.ts`                                                                                                                      |
| Window chrome                 | `main/utils/window-chrome.ts` (`#0d1117` dialogs; kinds include `update`), `main/windows/*` (about / update / settings / alert hide-reuse) |
| Brand-icon aurora             | `shared/utils/app-icon-aurora.ts`                                                                                                          | pure CSS+HTML; calm Settings base; fancy About/Update tier; a11y media queries   |
| Settings renderer             | `renderer/settings/*`                                                                                                                      | schema v3 full UI; grouped lists; canvas `#0d1117`; brand aurora under title bar |
| Auto-update                   | `main/system/auto-updater.ts` + `main/windows/update-window.ts` (packaged non-portable; portable/unpackaged explain; native dialog)        |

## src-local rules

- Use `.js` extensions in TypeScript imports; `import type` for types only.
- Main IPC: `typedHandle()` / `typedSend()` only; handlers take `AppGraph` where they need deps.
- Scheduler consumers: `scheduler/facade.js` only (or `graph.scheduler.*`).
- No static `swift/*` imports outside Darwin provider + `swift/**`.
- Facades must not import `swift/*` or `calendar/auth/*`.
- Branded values only at trust boundaries.
- Prefer free-function `As<T>(v)` in production main/preload; method `.As<T>()` is fine in tests after `setup.as.ts`.
- Calendar: exhaustive provenance; `isCalendarOk` / `isCalendarAutomationEligible` (live complete).
- Darwin partial refresh: parser retains valid events and reports skipped records; the Darwin provider aggregates `total`, `malformedRecord`, `malformedFieldCount`, `invalidIso`, `invalidId`, and `duplicateUid`. A nonzero total produces a live partial result and one count-only provider warning. `GetMeetings` carries it in the existing `CalendarPublication` and clears stale diagnostics for complete, offline, and error states.
- Partial events remain displayable and manually joinable. Automation arms only for live complete results.
- Only the native Darwin tray adds disabled partial warning and diagnostic rows. Its signature includes the diagnostic counts. Google and Windows retain generic partial behavior. Renderer production has no diagnostics UI.
- `getEvents(signal: AbortSignal)` on ports/providers.
- Renderer user HTML: `escapeHtml()`.
- Windows OAuth only via tray/Settings — never lifecycle auto-start.
- BrowserWindows: `sandbox`, `contextIsolation`, no Node integration.
- Do not re-export domain/infrastructure symbols from utils or shared.

## Wrapper provider recipe

Add new meeting hosts after updating **both** extraction paths and allowlists:

1. Swift `findMeetUrl` in `googlemeet-events.swift` (Zoom → Meet → Teams → Webex → Calendly; HTML href + bare hosts).
2. `domain/services/url-extract.ts` same priority for cloud providers (incl. href/bare).
3. `domain/policies/meet-url-allowlist.ts` + preload hostname check.
4. Tests under `tests/domain/` (extract, allowlist, buildMeetUrl) + main egress tests.

Meeting egress uses the allowlisted `ShellMeetingOpener` through `graph.opener`; explicit joins use `graph.join.byId`.

## Tests

Vitest projects: `tests/domain/`, `tests/application/`, `tests/main/` (Electron mocks + `setup.main.ts` + `setup.as.ts`), `tests/renderer/` (jsdom + `setup.as.ts`), `tests/shared/`, `tests/scripts/`. Helpers: `tests/helpers/`. Bench: `vitest.bench.config.ts` (not workspace). Coverage floors: see `tests/AGENTS.md`.
