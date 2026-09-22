# application/

## Overview

The application layer contains ports and use cases. It has no Electron, Node I/O, or Swift dependencies. Lint rules enforce that boundary.

## Structure

```text
application/
├── ports/
│   ├── calendar-port.ts          # getEvents(signal), permission, optional watch and OAuth hooks
│   ├── settings-store-port.ts    # load / get / update
│   ├── meeting-opener-port.ts    # open(url) -> Result
│   ├── scheduler-port.ts         # narrow scheduler dependencies
│   ├── clock-port.ts             # now()
│   └── event-publisher-port.ts   # calendar UI status and optional meeting-list publication
└── use-cases/
    ├── join-meeting.ts
    ├── get-meetings.ts
    ├── request-calendar-access.ts
    ├── get-calendar-permission-status.ts
    ├── disconnect-calendar.ts
    ├── load-settings.ts
    ├── get-settings.ts
    └── update-settings.ts
```

## Calendar use cases

| Use case                                                                                    | Notes                                                                                                                                                                                                                                                                                           |
| ------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `get-meetings.ts`                                                                           | Calls `calendar.getEvents(signal)` and projects the result into `CalendarUiState`, then publishes the snapshot. Live complete becomes `ready` or `empty`; live partial becomes `limited` with retained events; offline cache becomes `offline-cached` with `cacheAgeMs`; errors become `error`. |
| `join-meeting.ts`                                                                           | Explicit join from last-known data or a fetch. It uses an injected opener and cancels pending browser auto-open after a successful join. Any successful result with events remains joinable.                                                                                                    |
| `request-calendar-access.ts`, `get-calendar-permission-status.ts`, `disconnect-calendar.ts` | Permission and disconnect through `CalendarPort`; the provider owns Darwin TCC or Google OAuth details.                                                                                                                                                                                         |
| `load-settings.ts`, `get-settings.ts`, `update-settings.ts`                                 | `SettingsStorePort` wrappers for schema v3. Adapter-only disk save belongs to `JsonSettingsStore`.                                                                                                                                                                                              |

## GetMeetings projection rules

- The use case preserves a live partial result's valid events and marks its snapshot `limited`. It copies optional Darwin count-only diagnostics only from that partial result.
- Complete live, offline-cache, and error projections clear `darwinPartialRefreshDiagnostics`. Offline also clears `cacheAgeMs` only outside the offline-cache projection.
- Offline success preserves a prior granted or denied permission. It never infers permission from `kind: "ok"`.
- `GetMeetings` returns `CalendarResult`, not `CalendarPublication`. The facade and refresh coordinator own publication generation and concurrent-refresh coordination.

## Rules

- Ports are TypeScript interfaces. Use cases depend on ports and `src/domain`, never concrete adapters.
- `CalendarPort.getEvents` requires `AbortSignal`. The coordinator passes it through to the use case and provider so cancellation reaches the boundary.
- Provider optionals on `CalendarPort` include watch, disconnect, warmup, account label, OAuth state, and watch revival.
- `SchedulerPort` and `ClockPort` have no production importer. Join takes `JoinMeetingDeps`. The watcher calls facade `forcePoll`, which returns `Promise<CalendarPublication | null>`.
- Calendar facade work is not limited to one-line delegation. It lazily resolves provider ports, owns permission and UI snapshot state, binds use cases to the refresh coordinator, exposes the latest publication, and publishes poll-level errors. Keep those responsibilities out of use cases.
- Composition injects the graph-local dependencies each use case needs. `createAppGraph(overrides?: AppGraphOverrides)` finalizes overrides before it creates downstream scheduler, join, and watcher closures.
- Application tests live in `tests/application/` and use no Electron mocks.
