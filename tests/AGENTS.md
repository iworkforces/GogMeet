# GogMeet Tests — Knowledge Base

Vitest workspace (`vitest.workspace.ts`): seven projects. `tests/bench/` and `vitest.bench.config.ts` are outside the workspace and the coverage gate.

## Projects

| Project | Env | Setup | Scope | Floors (L/S/F/B) |
|---------|-----|-------|-------|------------------|
| `domain` | Node | `setup.as.ts` | `src/domain/**` | 90/90/90/80 |
| `application` | Node | `setup.as.ts` | ports and use cases | 80/80/80/70 |
| `main` | Node | `setup.main.ts` | Electron main, scheduler, providers, Swift, IPC, tray | 90/90/90/80 |
| `renderer` | jsdom | `setup.as.ts` | browser UI | soft 70/70/70/50 |
| `vertical` | jsdom | `setup.as.ts` | `tests/vertical/**` | none |
| `shared` | Node | `setup.as.ts` | IPC, cast, aurora | 90/90/80/80 |
| `scripts` | Node | `setup.as.ts` | `scripts/` | none |

Global include is `src/**/*.{ts,tsx}` with floors **90/90/90/80**. Excludes: `swift/calendar-watch-sidecar.ts`, `calendar/providers/darwin-eventkit.ts`. Shared also excludes type-only `alert.ts` and `app-state.ts`.

Child notes: `tests/{main,renderer,shared,helpers,domain,application}/AGENTS.md`. Script suites are listed in `scripts/AGENTS.md`.

## Structure

```text
tests/
├── setup.main.ts    # Electron mock; imports setup.as.ts
├── setup.as.ts      # Object.prototype.As
├── helpers/         # test-utils, ipc-sender, app-graph, scheduler-runtime
├── domain/ application/ shared/ scripts/
├── main/            # flat *.test.ts plus swift/ (three files)
├── renderer/
├── vertical/        # calendar-publication.test.ts
└── bench/           # *.bench.ts plus calendar-parser-fixtures.ts
```

## Patterns

- Names are `[module].test.ts`. No `*.spec.ts`. Imports and `vi.mock` paths use `.js`.
- Casts go through `.As<T>()` / `As<T>(v)` after `setup.as.ts`.
- Branded fixtures: `asTestEventId`, `asTestMeetUrl`, `asTestIsoUtc`. Live-complete fixtures: `okCalendarResult`.
- Graphs: `testAppGraph(overrides)` → `createTestAppGraph` → `createAppGraph`.
- Provider `getEvents` tests pass an `AbortSignal`.
- Timer suites use `vi.useFakeTimers()` and `vi.advanceTimersByTimeAsync()`. Re-read Map/Set refs after a scheduler reset.
- Domain and application suites do not import `electron`. Renderer suites do not import `src/main`.

## Commands

```bash
bun run test
bun run test:coverage
bun run bench:calendar-parser
bun run guardrails:tests
```

## Gaps

- `vertical` is one jsdom loopback (handlers, a preload-shaped `window.api`, and the popover). It is not a packaged three-process smoke.
- CI does not call real EventKit, Swift, or Google.
- Native probe runs live in `measurement.yml`, not in PR gates. Auto-updater download and relaunch are mocked.
