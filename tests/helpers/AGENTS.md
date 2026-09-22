# Test Helpers

## OVERVIEW

Shared factories used across Vitest projects.

| File | Role |
| --- | --- |
| `test-utils.ts` | Brand validators + meeting/settings fixtures (no `vi` / `expect`) |
| `ipc-sender.ts` | Platform-correct authorized `file://` sender fixtures for IPC tests |
| `app-graph.ts` | `testAppGraph(overrides)` → `createTestAppGraph` for handler/lifecycle suites |
| `scheduler-runtime.ts` | `schedulerTestContext` and `calendarPublication` for scheduler plan tests |

Import path convention (note `.js` extension):

```typescript
import { createMockEvent, asTestEventId } from "../helpers/test-utils.js";
import { authorizedInvokeEvent } from "../helpers/ipc-sender.js";
import { testAppGraph } from "../helpers/app-graph.js";
```

## EXPORTED HELPERS

| Helper                                                            | Purpose                                                                                                                           |
| ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `createMockEvent`                                                 | Fully-formed `MeetingEvent` with sensible defaults                                                                                |
| `createMockSettings`                                              | `AppSettings` from `DEFAULT_SETTINGS` (schema **v3**, incl. `showCompletedTodayMeetings`) + shallow overrides                     |
| `authorizedInvokeEvent` / `authorizedOnEvent` / `rendererFileUrl` | Packaged renderer `file://` senders via `pathToFileURL(app.getAppPath()...)`; `RendererPage` = `"index" \| "settings" \| "alert"` |
| `createMockIpcEvent`                                              | Minimal invoke event; prefer authorized helpers for `validateSender`                                                              |
| `isoFromNow`                                                      | ISO-8601 UTC offset from now                                                                                                      |
| `asTestEventId` / `asTestIsoUtc` / `asTestMeetUrl`                | Throw-on-invalid wrappers around domain brand validators                                                                          |
| `okCalendarResult`                                                | Live-complete `CalendarResult` fixture (exhaustive provenance fields)                                                             |
| `testAppGraph`                                                    | Minimal production-shaped `AppGraph` with optional `AppGraphOverrides`                                                            |

## CONTRACTS

- **Throw-on-invalid branding.** Use `asTest*` only for known-good fixtures. Assert validation failures with domain `asEventId` / `asMeetUrl` / `asIsoUtc` and inspect `Result`.
- Brands import from **`src/domain/entities/brand.js`** (not shared).
- **Defaults are time-relative.** Combine with fake timers for deterministic windows.
- **No Electron at import time** in `test-utils.ts` (type-only electron imports). `ipc-sender` and graph helpers may touch mocked Electron in main tests.
- `testAppGraph(overrides: AppGraphOverrides = {})` directly delegates to `createTestAppGraph(overrides)`, which directly delegates to `createAppGraph(overrides)`.

## LEGACY FACTORIES

| Per-file factory | Where | Notes |
| --- | --- | --- |
| `makeEvent` | scheduler-* tests | Prefer `createMockEvent` for new tests |
| `makeSwiftLine` | `tests/main/calendar.test.ts` | Nine-string JSON Lines fixture; no shared replacement yet |
| `makeLine` | `tests/main/swift/event-parser.test.ts` | Parser-local nine-string helper |

When extending an existing suite, match the surrounding style; when starting a new test file, use the helpers above.
