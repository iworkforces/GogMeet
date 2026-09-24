# ADR 0002: Google Calendar incremental sync (nextSyncToken)

## Status

Accepted (MVP)

## Context

Bounded two-day `events.list` polls show the right meetings but repeat work. The performance program deferred incremental sync until measurement and design gates existed. Google's `syncToken` cannot be combined with `timeMin`, `timeMax`, or `orderBy`, so a bounded fetch cannot seed incremental sync.

## Decision

1. Seed each calendar with an unbounded `events.list`: `singleEvents=true`, `conferenceDataVersion=1`, `maxResults=250`, and no `timeMin`, `timeMax`, or `orderBy`. Only the terminal `nextSyncToken` from a complete page chain pairs with the process-local full event index, including a valid empty snapshot. Persist the opaque token encrypted per calendar; project the index onto the exact two-local-day UTC bounds for display.
2. Incremental polls require that token and complete index paired with the exact UTC bounds, local timezone, and account identity. Every delta page repeats the original `syncToken` and invariant parameters. Stage changes and deletions until the complete terminal page, then advance the token. A changed window, timezone, or account, a cold process, or HTTP 410 invalidates the pair and requires a new unbounded seed; clear an invalid token before reseeding.
3. At the 50-page unbounded limit, discard the incomplete batch. A completed bounded two-day fetch may supply display and offline cache data, but no resumable index or token. Missing or non-array `items`, or any unfinished page chain, is not a complete snapshot. An incremental 429 has no same-poll full-fetch fallback.
4. Cancellation or replacement fences staged commits and cache writes. Disconnect synchronously invalidates outstanding work and the process index, aborts token refresh and in-flight PKCE login, then clears auth tokens, sync tokens, and cache. PKCE login timeout also invalidates that login. An OS write already in progress cannot be undone; the subsequent queued clear wins. Refresh saves and definitive invalid-grant clears are queue-atomic and require the exact origin credential to remain current, so stale account A cannot overwrite or clear newly connected B.
5. Write the offline cache only for a complete aggregate live result. Keep no durable event database and make no change to `CalendarPublication` or automation eligibility. Push and webhooks remain out of scope.

## Consequences

- First launch and cold processes seed again, even when an encrypted token remains on disk.
- Token file: `{userData}/calendar-auth/google-sync.enc`.
