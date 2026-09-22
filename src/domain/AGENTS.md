# domain/ (pure)

Pure layer. No Electron, `node:*`, filesystem, or Swift. `eslint-plugin-boundaries` blocks every other layer. Vitest project `domain` floors are 90/90/90/80.

## STRUCTURE

```text
src/domain/
├── entities/   # brands, MeetingEvent, CalendarResult, publication, UI state, settings v3
├── policies/   # meet-url-allowlist.ts
└── services/   # extract, validate, buildMeetUrl, meeting-time, settings-parse, platform
```

## Calendar fetch contract

| Variant | Shape |
|---------|--------|
| Live complete | `{ kind:"ok", source:"live", completeness:"complete", observedAt, events }` |
| Live partial | live ok + `completeness:"partial"` + optional `darwinPartialRefreshDiagnostics` |
| Offline cache | `{ kind:"ok", source:"offline-cache", observedAt, cachedAt, events }` |
| Error | `{ kind:"err", error, code }` |

Helpers: `isCalendarOk`, `isCalendarLiveOk`, `isCalendarOfflineOk`, `isCalendarAutomationEligible` (live complete only), `calendarLiveOk` / `calendarOfflineOk` / `calendarErr`, `isValidCalendarTimestamp` (finite, ≤5 min future). Constructors beat ad-hoc literals.

Darwin diagnostics are six counts: `total`, `malformedRecord`, `malformedFieldCount`, `invalidIso`, `invalidId`, `duplicateUid`. Emitted only on a Darwin live partial.

`CalendarUiPhase`: `disconnected` | `connecting` | `ready` | `empty` | `error` | `offline-cached` | `limited`. Offline success must not infer permission from `kind==="ok"`.

## WHERE TO LOOK

| Concern | Path |
|---------|------|
| Brands | `entities/brand.ts` — `EventId`, `MeetUrl`, `IsoUtc`, `WindowHeight` (220–480) |
| Result / publication | `entities/calendar-result.ts`, `calendar-publication.ts` |
| UI phase | `entities/calendar-ui-state.ts` |
| Settings v3 | `entities/settings.ts`, `services/settings-parse.ts` |
| Allowlist | `policies/meet-url-allowlist.ts` — suffixes only `.zoom.us` and `.webex.com` |
| Exact-host prefixes | `services/url-validation.ts` `MEETING_URL_ALLOWLIST` (no suffixes) |
| Extract order | `services/url-extract.ts` — Zoom, Meet, Teams, Webex, Calendly; `href=` and bare hosts |
| Join URL | `services/build-meet-url.ts` — Meet `authuser`, Zoom `uname` |
| Wall clock | `services/meeting-time.ts` — in progress is `start ≤ now < end` |
| Titles | `services/truncate-middle.ts` — `MEETING_TITLE_DISPLAY_MAX_CHARS` is 25 |
| Host vs OS | `services/platform.ts` is Meet vs Zoom. OS is `main/platform/os.ts` |
| Signature | `services/event-signature.ts` — `eventListSignature` drops `description` |

## Settings v3

`SETTINGS_SCHEMA_VERSION` is 3. `showTomorrowMeetings` defaults to true. `showCompletedTodayMeetings` defaults to false. `parseSettingsRecord` rewrites legacy files, maps `fullScreenAlert` → `windowAlert`, and fills missing booleans from defaults. Timing clamps live on the entity. IPC side effects of those toggles are in `ipc-handlers/AGENTS.md`.

## RULES

- Import only other `src/domain/**` modules.
- No barrels and no re-exports from `shared/` or `main/utils`.
- `shell.openExternal` stays in `main/infrastructure/electron/shell-meeting-opener.ts`.
