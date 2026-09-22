# infrastructure/

## Overview

This directory contains two driven adapters: settings persistence and allowlisted meeting egress. It does not own calendar providers, network transport, OAuth, Swift, sync tokens, or offline calendar cache.

| Path                               | Implements          | Responsibility                                                                                                                                                     |
| ---------------------------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `settings/json-settings-store.ts`  | `SettingsStorePort` | Loads, gets, and updates schema v3 settings under `userData/settings.json`. Its adapter-specific `save` persists the current settings and rewrites migrated input. |
| `electron/shell-meeting-opener.ts` | `MeetingOpenerPort` | Validates the meeting URL with the domain allowlist, then calls Electron `shell.openExternal`. Logs host only (no full URL) on block/failure.                      |

## Boundaries

- `JsonSettingsStore` is the concrete store used through the settings facade and composition. The application port exposes load, get, and update, not adapter-only save.
- `ShellMeetingOpener` is the egress adapter. Composition exposes one instance as `graph.opener` and injects it into scheduler auto-open work and `graph.join.byId`; a successful explicit join then cancels pending automatic browser work through its injected scheduler callback.
- Calendar factory selection, Darwin EventKit, Google Calendar, Google HTTP, OAuth and token stores, incremental sync, offline cache, and the refresh coordinator live under `src/main/calendar/`.
- Swift helper process, binary, protocol parsing, and sidecar behavior live under `src/main/swift/` and are only reached by the Darwin calendar provider.

## Rules

- These adapters may use the Electron and Node APIs their own contracts require. Do not add unrelated provider, transport, or Swift responsibilities here.
- Pure `src/domain/` and application use cases must not import these concrete adapters. Composition and facades wire them through ports.
- Import `createJsonSettingsStore` and `createShellMeetingOpener` from their adapter modules. Do not re-export them through `utils`.
- Tests live in `tests/main/json-settings-store.test.ts` and `tests/main/shell-meeting-opener.test.ts`.

## NOTES

- `createAppGraph` constructs the opener and the JSON store immediately. The calendar provider stays lazy.
- `settings.json` is pretty-printed JSON via `writeFile`. It is not a `secure-fs` `0o600` file. ENOENT loads defaults and does not create the file. `get` throws if `load` has not run.
- Blocked or failed opens log `protocol//hostname/…` or `(invalid-url)`.
