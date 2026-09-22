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
| Brands | `entities/brand.ts` — `asMeetUrl` is structural (`https`, no userinfo, no port). Allowlist is `validateMeetUrl`. `WindowHeight` is 220–480 |
| Result / publication | `entities/calendar-result.ts`, `calendar-publication.ts` |
| UI phase | `entities/calendar-ui-state.ts` |
| Settings v3 | `entities/settings.ts`, `services/settings-parse.ts` |
| Allowlist | `policies/meet-url-allowlist.ts` — exact hosts plus suffixes `.zoom.us` and `.webex.com`. Apex `webex.com` is not a suffix match |
| Exact-host prefixes | `services/url-validation.ts` `MEETING_URL_ALLOWLIST` (no suffixes) |
| Extract order | `services/url-extract.ts` — Zoom, Meet, Teams, Webex, Calendly; `href=` and bare hosts |
| Join URL | `services/build-meet-url.ts` — Meet `authuser`, Zoom `uname` |
| Wall clock | `services/meeting-time.ts` — in progress is `start ≤ now < end` |
| Next join | `services/pick-join-target.ts` — timed events with a URL; soonest in-progress end, else next future start |
| Titles | `services/truncate-middle.ts` — `MEETING_TITLE_DISPLAY_MAX_CHARS` is 25 |
| Host vs OS | `services/platform.ts` is Meet vs Zoom. OS is `main/platform/os.ts` |
| Signature | `services/event-signature.ts` — `eventListSignature` drops `description` |

## Settings v3

`SETTINGS_SCHEMA_VERSION` is 3. `showTomorrowMeetings` defaults to true. `showCompletedTodayMeetings` defaults to false. `parseSettingsRecord` mutates the in-memory record: maps `fullScreenAlert` → `windowAlert`, fills missing booleans, and clamps. It does not write the file. `JsonSettingsStore` persists. IPC side effects of those toggles are in `ipc-handlers/AGENTS.md`.

## RULES

- Import only other `src/domain/**` modules.
- No barrels and no re-exports from `shared/` or `main/utils`.
- `shell.openExternal` stays in `main/infrastructure/electron/shell-meeting-opener.ts`.
