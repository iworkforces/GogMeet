# domain/ (pure)

## OVERVIEW

**Pure** domain layer. Zero Electron, `node:fs`, network, or Swift process dependencies. Enforced by `eslint-plugin-boundaries` and Vitest project `domain` (coverage floors 90/90/90/80).

## STRUCTURE

```text
src/domain/
├── entities/    # brands, MeetingEvent, CalendarResult, CalendarPublication,
│                # CalendarUiState, settings (v3), Result, AppError, parse-json, type-guards
├── policies/    # meet URL allowlist + hostname helpers
└── services/    # buildMeetUrl, validateMeetUrl, url-extract, cleanDescription,
                 # pickJoinTarget, meeting-time, truncate-middle, event-signature,
                 # time, settings-parse, platform
```

## FILES (entities)

| File                      | Role                                                                                        |
| ------------------------- | ------------------------------------------------------------------------------------------- |
| `brand.ts`                | `EventId`, `MeetUrl`, `IsoUtc`, `WindowHeight` + validators                                 |
| `meeting-event.ts`        | `MeetingEvent` shape                                                                        |
| `calendar-result.ts`      | Exhaustive `CalendarResult` + permission + helpers (see below)                              |
| `calendar-publication.ts` | `CalendarPublication` — `{ publicationGeneration, result }` for coordinated refreshes / IPC |
| `calendar-ui-state.ts`    | tray/settings UI state, phases, `cacheAgeMs`, defaults                                      |
| `settings.ts`             | `AppSettings` (schema **v3**), `DEFAULT_SETTINGS`, quiet hours types                        |
| `result.ts`               | `Result<T,E>`, `ok` / `err`                                                                 |
| `errors.ts`               | `AppError` taxonomy + guards / `formatAppError` / `errFrom`                                 |
| `parse-json.ts`           | `parseJsonObject` → `AppResult`                                                             |
| `type-guards.ts`          | `isObjectRecord`                                                                            |

## Calendar fetch contract

Success is **exhaustive** (no optional provenance for callers to guess):

| Variant       | Shape                                                                                                        |
| ------------- | ------------------------------------------------------------------------------------------------------------ |
| Live complete | `{ kind:"ok"; source:"live"; completeness:"complete"; observedAt; events }`                                  |
| Live partial  | `{ kind:"ok"; source:"live"; completeness:"partial"; observedAt; events; darwinPartialRefreshDiagnostics? }` |
| Offline cache | `{ kind:"ok"; source:"offline-cache"; observedAt; cachedAt; events }`                                        |
| Error         | `{ kind:"err"; error; code }`                                                                                |

| Helper                                                 | Role                                                             |
| ------------------------------------------------------ | ---------------------------------------------------------------- |
| `isCalendarOk`                                         | any success                                                      |
| `isCalendarLiveOk` / `isCalendarOfflineOk`             | source narrow                                                    |
| `isCalendarAutomationEligible`                         | **live complete only** — intended gate for auto-open/alert/title |
| `calendarLiveOk` / `calendarOfflineOk` / `calendarErr` | constructors                                                     |
| `isValidCalendarTimestamp`                             | finite, ≤5 min future skew                                       |

**Darwin partial diagnostics:** live results have optional `darwinPartialRefreshDiagnostics`. It contains `total`, `malformedRecord`, `malformedFieldCount`, `invalidIso`, `invalidId`, and `duplicateUid`. It is emitted only for partial Darwin results, while valid events remain available. Generic providers do not attach it.

**UI (`calendar-ui-state.ts`):** `CalendarUiPhase` = `disconnected` \| `connecting` \| `ready` \| `empty` \| `error` \| `offline-cached` \| `limited` (live partial → `limited`). Fields `cacheAgeMs` for offline age and nullable `darwinPartialRefreshDiagnostics`, which defaults to `null`. Copy: `CALENDAR_LIMITED_COPY`. Offline success must **not** set permission from `kind==="ok"` alone.

## FILES (services / policies)

| File                             | Role                                                                                                                                          |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `policies/meet-url-allowlist.ts` | HTTPS host allowlist + `isAllowedMeetHostname` (Meet, calendar/accounts.google.com, Zoom / `.zoom.us`, Teams, Webex / `.webex.com`, Calendly) |
| `services/url-validation.ts`     | `validateMeetUrl` / `isAllowedMeetUrl`                                                                                                        |
| `services/build-meet-url.ts`     | pure join URL + Meet `authuser` / Zoom `uname`                                                                                                |
| `services/url-extract.ts`        | free-text Zoom → Meet → Teams → Webex → Calendly; HTML `href=` + scheme-less bare hosts                                                       |
| `services/clean-description.ts`  | notes cleaner for EventKit/Google                                                                                                             |
| `services/pick-join-target.ts`   | next joinable meeting                                                                                                                         |
| `services/meeting-time.ts`       | in-progress / not-ended / upcoming filter / **completed-today** / display horizon                                                             |
| `services/truncate-middle.ts`    | code-point middle-truncate; `MEETING_TITLE_DISPLAY_MAX_CHARS` (25) for meeting titles                                                         |
| `services/platform.ts`           | Meet vs Zoom host detection (**not** OS)                                                                                                      |
| `services/time.ts`               | day boundaries + remaining-time format                                                                                                        |
| `services/settings-parse.ts`     | clamp + rewrite `schemaVersion` to **v3**; legacy `fullScreenAlert` → `windowAlert`; default missing booleans                                 |
| `services/event-signature.ts`    | stable event/list signatures for push gating                                                                                                  |

## RULES

- Import only other `src/domain/**` modules.
- Callers: `src/shared` (IPC maps), main/preload/renderer, tests.
- **No** barrels and **no** re-exports from old `shared/*` or `main/utils` paths.
- Opening meeting URLs (`shell.openExternal`) stays in `main/infrastructure/electron/shell-meeting-opener.ts`.
- Prefer constructors/helpers over ad-hoc result object literals.

## WHERE TO LOOK

| Concern                                    | Path                                                             |
| ------------------------------------------ | ---------------------------------------------------------------- |
| Brands / validators                        | `entities/brand.ts`                                              |
| Result provenance / automation eligibility | `entities/calendar-result.ts`                                    |
| UI phase / offline age                     | `entities/calendar-ui-state.ts`                                  |
| Settings schema + quiet hours              | `entities/settings.ts` (`showCompletedTodayMeetings`, schema v3) |
| Settings parse/clamp                       | `services/settings-parse.ts`                                     |
| Wall-clock / completed-today               | `services/meeting-time.ts`                                       |
| Display title middle-truncate              | `services/truncate-middle.ts` (`truncateMiddle`, max 25)         |
| Allowlist + validateMeetUrl                | `policies/meet-url-allowlist.ts`, `services/url-validation.ts`   |
| buildMeetUrl (pure)                        | `services/build-meet-url.ts`                                     |
| URL extract / clean notes                  | `services/url-extract.ts`, `services/clean-description.ts`       |
| Publication envelope                       | `entities/calendar-publication.ts`                               |

## Settings contract (v3)

| Field                        | Notes                                                                                                                                                                |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `schemaVersion`              | `3` (`SETTINGS_SCHEMA_VERSION`)                                                                                                                                      |
| `showCompletedTodayMeetings` | default `false`; display-only history in tray + popover                                                                                                              |
| Timing / automation fields   | `openBeforeMinutes` 0–10, `autoOpenEnabled`, `alertLeadSeconds`, `lateJoinGraceMinutes`, quiet hours enable + start/end (`HH:mm`), etc. Full UI: `renderer/settings` |

Pre-v3 files migrate/rewrite on load with `showCompletedTodayMeetings: false`. Incomplete/malformed booleans fall back to defaults.
