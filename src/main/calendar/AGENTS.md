# calendar/ — Provider abstraction

**Parent:** `src/main/AGENTS.md`. Production callers use `facades/calendar.ts` or `graph.calendar`. `scheduler/poll.ts` may import `CalendarRefreshCancelledError` only. The safe-storage probe may import the token store and offline cache.

## FILES

| File | Role |
|------|------|
| `provider.ts` | `CalendarProvider`. Ids include reserved `microsoft-graph` (no module) |
| `factory.ts` | `getActiveCalendarProvider()` / `resetCalendarProvider()` |
| `refresh-coordinator.ts` | `createCalendarRefreshCoordinator`: `requestRefresh`, `getLastPublication`, `cancel` |
| `google-http.ts` | 15s / 8MiB / 60s poll budget |
| `offline-cache.ts` | Encrypted `calendar-cache.enc` schema v1; live-complete writes only |
| `auth/google-oauth.ts` | PKCE on `127.0.0.1` only; 5-minute login; one in-flight browser flow |
| `auth/google-token-store.ts` | `google.enc`; preserve ciphertext on load failure |
| `auth/google-sync-tokens.ts` | `google-sync.enc` schema v1; opaque `nextSyncToken` per calendar |
| `auth/google-client-id.ts` | `GOOGLE_OAUTH_CLIENT_ID` |
| `providers/darwin-eventkit.ts` | Only non-`swift/**` static importer of `swift/*` |
| `providers/google-calendar.ts` | Incremental sync; `MAX_PAGES=50`; id is `calendarId:event.id` |
| `providers/fixture-calendar.ts` | Unpackaged `GOGMEET_CALENDAR_FIXTURE` only |
| `providers/performance-probe-calendar.ts` | Empty live complete; provider id string is `"fixture"` |
| `providers/stub-unsupported.ts` | Test-only. Returns `denied` |

Facade names: `refreshCalendarPublication` → `requestRefresh`, `getLastPublication`, `cancelActiveCalendarRefresh`. There is no `requestCalendarRefresh` / `bindCalendarRefreshFetcher`.

## Factory order

1. Non-empty `GOGMEET_PERF_PROBE` preflight. Pass → probe provider. Fail → throw (no EventKit, Google, or fixture fallthrough).
2. Unpackaged `GOGMEET_CALENDAR_FIXTURE` → fixture.
3. `isDarwin()` → EventKit (dynamic import).
4. Every other OS → Google.

## Provenance

Darwin live partial means `darwinPartialRefreshDiagnostics.total > 0`. Counts only: `total`, `malformedRecord`, `malformedFieldCount`, `invalidIso`, `invalidId`, `duplicateUid`. `console.warn` receives that object. No retry and no Swift recompile. Google partials stay generic. Offline cache is never written by Darwin.

Google is live complete only when the calendar list and every selected calendar finish. `pagination-limit` with at least one finished calendar is partial. Offline cache is a valid encrypted snapshot on transient failure.

## Google

- `extractMeetingUrl` walks `hangoutLink`, `conferenceData.entryPoints` URIs, `location`, raw `description`, then `cleanDescription`. The first allowlisted match wins. `validateMeetUrl` brands it.
- A compatible initial `events.list` is unbounded: `singleEvents=true`, `conferenceDataVersion=1`, `maxResults=250`, with no `timeMin`, `timeMax`, or `orderBy`. Its complete snapshot, including an empty one, stays process-local. Display projects timed overlaps and all-day calendar dates into the current two-local-calendar-day window.
- Incremental sync requires a persisted token paired with that complete index, exact UTC window endpoints, local timezone, and account identity. Each delta page repeats the original `syncToken` and invariant parameters; only the terminal complete page can advance the token. Cold process, changed window or timezone, changed account, or HTTP 410 requires a new compatible unbounded seed.
- After 50 unbounded pages, discard the incomplete batch and try a bounded `timeMin`/`timeMax`/`orderBy=startTime` full fetch. Only a complete bounded result may display/cache; it never establishes a resumable index or token. The next poll seeds again. Missing or non-array `items` on any events or calendar-list page is incomplete, not a valid empty page; `items: []` is valid.
- HTTP 410 invalidates that calendar's pair and clears its token before reseeding. Disconnect synchronously invalidates outstanding provider work and the process index, aborts token refresh and in-flight PKCE login, then clears tokens, sync tokens, and cache. An OS write already in progress cannot be undone; the subsequent queued clear wins.
- Completed delta pages remove indexed events that become cancelled, declined, or unmappable. Incomplete page chains never apply staged events, deletions, or cursor. A finished sibling may still save its own token. Only aggregate live `completeness === "complete"` writes the offline cache, guarded against cancelled/replaced polls.
- Incremental 429 throws `RateLimitError` and does not full-fetch in that poll. Other incremental failures may full-fetch in the same poll.
- First 401 forces one token refresh and one retry. A second 401 clears tokens. `if-needed` skips the network when expiry is more than 60s away. `force` joins the shared flight and runs one follow-up if that join did not refresh. The caller `AbortSignal` unblocks the waiter only.
- Clear tokens for `invalid_grant`, `invalid_token`, or that second 401. Timeout, network, 429, 5xx, storage, and config keep ciphertext.
- Refresh saves and definitive invalid-grant clears are queue-atomic and require the exact origin credential to remain current, so stale account A cannot overwrite or clear newly connected B. PKCE login timeout also invalidates that in-flight login.
- `safeStorage` is required unless unpackaged `GOGMEET_ALLOW_PLAINTEXT_TOKENS=1`.
- No push or webhook watch (ADR 0002).

## RULES

- Honor `AbortSignal` on helper and HTTP calls.
- Facades do not import `auth/*` or `swift/*`.
- Fixture loading requires an unpackaged app.
- `resetCalendarProvider()` stops watch and drops the process cache. It does not clear tokens, sync tokens, the index, or the offline cache. Google `disconnect()` does.
