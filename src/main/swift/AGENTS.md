# Swift Integration

macOS EventKit helper. The only production TypeScript importer outside `swift/**` is `calendar/providers/darwin-eventkit.ts`.

**Sources (both in electron-builder `files` and `asarUnpack`):**

- `src/main/googlemeet-events.swift` — one-shot and `--watch`
- `src/main/swift/event-occurrence-identity.swift` — `eventRecordIdentifier`

## Files

| File | Role |
|------|------|
| `event-occurrence-identity.swift` | `id:bitPattern` from `occurrenceDate ?? startDate` |
| `../googlemeet-events.swift` | Nine-string JSON Lines; `uid` uses that identifier |
| `swift-helper-process.ts` | `spawn` runner: 8MiB stdout, 256KiB stderr, 15s; SIGTERM, 5s, SIGKILL |
| `binary-manager.ts` | `runSwiftHelper` / `ensureBinary` |
| `binary-cache.ts` | `readSwiftSource`; cache dir `{tmpdir}/googlemeet/` mode `0o700` |
| `binary-compiler.ts` | `swiftc` / `strip` may use `execFile`. The event dump must not |
| `calendar-watch-sidecar.ts` | `--watch`. Stream ceilings match the one-shot runner |
| `event-parser.ts` | Nine fields to `MeetingEvent[]`, plus diagnostics. Notes go through domain `cleanDescription` |
| `event-field-parser.ts` | ISO pair, `EventId`, and `MeetUrl`. No notes |
| `event-validator.ts` | Exits 2/3/4 map to `calendar-*` errors. There is no exit 1 |
| `guards.ts` | Exec and tuple guards |

## Hash and compile

`readSwiftSource` is the raw identity bytes, one `0x0A`, then the raw events bytes. `source.hash` is SHA-256 hex of that buffer, compared after `trim()`. The same buffer is the single-file `swiftc` unit under the cache dir. `computeSwiftSourceHash` hashes one path and is not this digest.

`ensureBinary` recompiles when the hash changes or the binary is missing or not executable. One `runSwiftHelper` may recompile on a pre-flight hash mismatch and again on spawn `ENOENT` / `ENOEXEC`. Abort, timeout, overflow, exits 2/3/4, signals, bad stdout, and parser diagnostics do not recompile. A packaged `Resources/` helper, when executable, is copied into the cache and can skip `swiftc`; that copy writes the dual-source digest into `source.hash` when the source hash is available.

## Protocol

Each stdout line on exit 0 is a JSON array of nine strings: `uid`, `title`, `startISO`, `endISO`, `url`, `calName`, `allDay` (`"true"` or `"false"`), `email`, `notes`. Missing url, email, and notes are `""`.

| Exit | Meaning |
|------|---------|
| 0 | Parse stdout. Any diagnostic becomes live partial |
| 2 | Permission denied |
| 3 | No calendars |
| 4 | Runtime / helper error |

`--watch` prints `CHANGED`, not JSON. The sidecar accepts any line containing `CHANGED`.

## Watch sidecar

Swift debounce is 1000ms. Node debounce is 2000ms. Backoff runs through `MAX_RETRIES` (5), then a 5-minute cooldown. A child alive for 60s resets the retry count. Stdout overflow stops the child and uses the restart budget. Stderr past the cap logs once and does not restart. `error` and `exit` share one `scheduleRestart` per child.

## Rules

- Recurring instances share `calendarItemIdentifier`. The parser brands the full `id:bitPattern` string as `EventId`.
- Closed diagnostic reasons: `malformed_record`, `malformed_field_count`, `invalid_iso`, `invalid_id`, `duplicate_uid`. Out-of-range lines stay silent.
- No Electron, window, or scheduler imports.
- Tests: `tests/main/swift/` (real spawn, parser, darwin-only `swiftc` identity) and top-level `swift-binary-manager`, `swift-guards`, `calendar-watch-sidecar`.
