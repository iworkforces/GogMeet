# composition/

## Overview

This directory is the main-process composition root. It builds graph-local dependencies for lifecycle, IPC, tray, and shortcuts.

| File                       | Role                                                                                                                                             |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `app-graph.ts`             | `AppGraph` types and `createAppGraph(overrides?: AppGraphOverrides)`, which builds calendar, settings, scheduler, join, watcher, and one opener. |
| `create-test-app-graph.ts` | `createTestAppGraph(overrides?: AppGraphOverrides)`, which directly delegates to `createAppGraph(overrides)`.                                    |

## Calendar graph contract

- `graph.calendar.getEvents()` returns `CalendarPublication`, the coordinated envelope `{ publicationGeneration, result }`. It has no caller-provided signal because the refresh coordinator owns the provider call and its cancellation.
- `graph.calendar.getEventsResult()` returns only the enclosed `CalendarResult` for callers that need data rather than publication metadata, such as explicit join paths.
- `CalendarResult` describes the fetch outcome. `CalendarPublication` identifies a result produced by the coordinator and is used for refresh consumers and IPC pushes. Do not collapse the two contracts.
- The graph exposes UI snapshot reads, permission flow, disconnect, warmup, permission-cache invalidation, auto-request eligibility, and poll-level error reporting through its calendar surface.
- `graph.scheduler.forcePoll(options?)` returns a coordinated publication or `null`. `reason: "user"` bypasses the 10-second coalesce. Display-horizon code calls `graph.scheduler.republishUiForDisplayTick()`.

## Construction and probe use

- `createAppGraph(overrides?: AppGraphOverrides)` is dependency wiring. It constructs the opener and the JSON settings store immediately. The calendar provider stays lazy inside the facade. It builds graph-local calendar, settings, scheduler, join, watcher, and one opener. It finalizes each override before downstream closures use it, and does not initiate a calendar request, OAuth flow, or eager settings write.
- The same opener object is exposed as `graph.opener` and injected into both scheduler auto-open work and the explicit join use case.
- Normal lifecycle calls it once before IPC. Pass the resulting graph to tray, IPC handlers, and shortcuts rather than rebuilding surfaces at each boundary.
- The tray packaged probe also creates the production graph so it exercises production tray setup and callbacks, but supplies synthetic events and calendar UI snapshots through the main bus.
- Probe mode is selected and preflighted by `app/`, not composition. The calendar factory rejects invalid packaged-probe preflight before selecting any real provider.

## Rules

- Keep this directory to wiring. Network, OAuth, EventKit, Swift, calendar transport, and persistence implementation belong to their actual adapter directories.
- `AppGraphOverrides` accepts partial calendar, settings, scheduler, join, and watcher surfaces plus an optional opener.
- Use `tests/helpers/app-graph.ts` or `createTestAppGraph()` for test graphs. Both accept only `AppGraphOverrides` and preserve the production graph-local ownership model.
