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

- Extract the join URL from the raw description, then `cleanDescription`, then `validateMeetUrl`.
- Incremental sync runs when a stored token exists and the process-local index is non-empty. A cold process full-fetches.
- HTTP 410 clears that calendar's token and index, then full-fetches. Disconnect clears tokens, sync tokens, the index, and the cache.
- `pagination-limit` does not mutate that calendar's index or token. A finished sibling may still save its own token. Cache writes require aggregate `completeness === "complete"`.
- Full-window malformed `items` becomes `pagination-limit` once any events were collected. Incremental malformed `items` returns `complete`, and those upserts and deletes are applied.
- Incremental 429 throws `RateLimitError` and does not full-fetch in that poll. Other incremental failures may full-fetch in the same poll.
- First 401 forces one token refresh and one retry. A second 401 clears tokens. `if-needed` skips the network when expiry is more than 60s away. `force` joins the shared flight and runs one follow-up if that join did not refresh. The caller `AbortSignal` unblocks the waiter only.
- Clear tokens for `invalid_grant`, `invalid_token`, or that second 401. Timeout, network, 429, 5xx, storage, and config keep ciphertext.
- `safeStorage` is required unless unpackaged `GOGMEET_ALLOW_PLAINTEXT_TOKENS=1`.
- No push or webhook watch (ADR 0002).

## RULES

- Honor `AbortSignal` on helper and HTTP calls.
- Facades do not import `auth/*` or `swift/*`.
- Fixture loading requires an unpackaged app.
