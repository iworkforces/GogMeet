# src/ — Source Root

Process and layer split. `main/` owns Node and Electron. `preload/` is the only context bridge. `renderer/` is browser UI. `domain/` is pure. `shared/` is IPC and DTO contracts. Detail lives in each child `AGENTS.md`.

## Build outputs

| Source | Entry | Output | Runtime |
|--------|-------|--------|---------|
| `main/` | `src/main/index.ts` | `lib/main/index.cjs` | Electron main CJS |
| `preload/` | `src/preload/index.ts` | `lib/preload/index.cjs` | sandboxed preload CJS |
| `renderer/` | popover, settings, alert | `lib/renderer/` | BrowserWindow pages |
| `domain/`, `shared/` | imported | bundled into consumers | no Electron in domain |

## Directory map

| Path | Role |
|------|------|
| `domain/` | Entities, policies, services. |
| `shared/` | IPC maps, `escape-html`, `as.ts`, aurora. |
| `main/composition/` | `createAppGraph`, `createTestAppGraph`. |
| `main/application/` | Ports and use cases. No Electron. |
| `main/infrastructure/` | `JsonSettingsStore`, `ShellMeetingOpener`. |
| `main/facades/` | Calendar, watcher, status, settings factories. |
| `main/calendar/` | Factory, providers, auth, Google HTTP, offline cache, refresh coordinator. |
| `main/scheduler/` | Facade plus pure `planSchedule`. External imports: facade only. |
| `main/ipc-handlers/` | Typed IPC. Handlers receive `AppGraph`. |
| `main/app/` | Lifecycle, IPC registrar, packaged probes. |
| `main/swift/` | EventKit helper runner. Darwin provider only. |
| `main/windows/`, `system/`, `menu/`, `tray.ts` | Windows, OS adapters, tray templates, tray lifecycle. |
| `main/platform/` | `isDarwin` / `isWin32`. |
| `preload/`, `renderer/`, `assets/` | Bridge, three UIs, tray icons and `about-icon.svg`. |

## Where to change things

| Task | Files |
|------|-------|
| Add an IPC channel | `shared/ipc-channels.ts` → `main/ipc-handlers/*` → `preload/index.ts` → renderer |
| Calendar result / UI phase | `domain/entities/calendar-result.ts`, `calendar-ui-state.ts` |
| Google sync | `main/calendar/auth/google-sync-tokens.ts`, `providers/google-calendar.ts` (ADR 0002) |
| Single-flight refresh | `main/calendar/refresh-coordinator.ts` via `refreshCalendarPublication` |
| Join / open | `shell-meeting-opener.ts`, `join-meeting.ts`, `graph.join.byId` |
| Settings schema | `domain/entities/settings.ts` (v3), `services/settings-parse.ts` |
| New meeting host | Swift `findMeetUrl`, `domain/services/url-extract.ts`, `policies/meet-url-allowlist.ts`, domain tests |
| Packaged probes | `main/app/performance-probe.ts`, `main/app/performance-probes/` — lab/CI only |
| Window chrome | `main/utils/window-chrome.ts` (`#0d1117` for settings, about, update) |

## src-local rules

Root `AGENTS.md` holds the import, IPC, swift, cast, and `escapeHtml` rules. This tree adds:

- `CalendarPort.getEvents` takes an `AbortSignal`.
- Do not re-export domain or infrastructure symbols from `shared/` or `main/utils`.
- Windows connect starts from the tray or Settings.

## Tests

Workspace projects that cover this tree: `domain`, `application`, `main`, `renderer`, `vertical`, `shared`, `scripts`. Bench is `vitest.bench.config.ts`, not the workspace. See `tests/AGENTS.md`.
