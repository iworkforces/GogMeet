# PROJECT KNOWLEDGE BASE

**Generated:** 2026-09-22
**Commit:** 9478386
**Branch:** develop

## OVERVIEW

Menu-bar app that lists upcoming meetings and opens Meet, Zoom, Teams, Webex, and Calendly links. macOS calendar data comes from EventKit through a Swift helper. Windows calendar data comes from the Google Calendar API with OAuth PKCE (Google-only MVP). Optional alert, tray menu, completed-today history, and `CmdOrCtrl+Shift+M` to join the next meeting. Shipped versus backlog: `docs/STATUS.md` (its version line can lag).

## STRUCTURE

```text
GogMeet/
├── src/
│   ├── domain/         # pure entities, policies, services
│   ├── shared/         # IPC maps, DTOs, escape/aurora/cast
│   ├── preload/        # contextBridge → window.api
│   ├── renderer/       # popover, settings, alert
│   ├── assets/         # tray PNGs + about-icon.svg
│   └── main/           # Electron main (see src/main/AGENTS.md)
├── tests/              # 7 Vitest projects + bench outside the workspace
├── scripts/            # dev, guardrails, release verifiers, perf lab
├── build/              # electron-builder hooks, entitlements, icons
├── docs/               # adr/, plans/, security/, performance/, STATUS
├── .github/workflows/  # pr-check, release, beta-release, measurement
└── .sentrux/           # secondary architecture rules; not a CI gate
```

Skip `lib/`, `dist/`, `coverage/`, `node_modules/`. Subsystem rules live in child `AGENTS.md` files.

## WHERE TO LOOK

| Task | Location | Notes |
|------|----------|-------|
| Bootstrap | `src/main/index.ts`, `app/lifecycle.ts` | `createAppGraph()` before IPC; updater last |
| Composition | `main/composition/app-graph.ts` | one opener for IPC, join, and auto-open |
| IPC | `shared/ipc-channels.ts` → `ipc-handlers/` → `preload/` | `typedHandle` / `typedSend` |
| Calendar contract | `domain/entities/calendar-result.ts` | live complete, live partial, or offline-cache |
| Providers | `main/calendar/factory.ts` | probe, fixture, Darwin, else Google |
| Refresh | `main/calendar/refresh-coordinator.ts` | `requestRefresh`; one queued follow-up |
| Join / egress | `use-cases/join-meeting.ts`, `shell-meeting-opener.ts` | `graph.join.byId` |
| Scheduler | `main/scheduler/facade.ts` | only external import; plan is pure |
| Swift helper | `main/googlemeet-events.swift`, `main/swift/` | dual-source hash |
| Tray / windows | `main/tray.ts`, `menu/`, `windows/` | coalesce vs sync force |
| Settings UI | `renderer/settings/` | schema v3; canvas `#0d1117` |
| Guardrails | `docs/security/permanent-guardrails.md` | `bun run guardrails` |
| Packaging | `electron-builder.yml`, `build/AGENTS.md` | per-arch Windows NSIS |

## CODE MAP

No TypeScript language server is configured, and no `codegraph_*` tool is connected (`.codegraph/` is on disk only). **Refs are unmeasured.** Symbols below were confirmed by reading the defining file.

| Symbol | Type | Location | Refs | Role |
|--------|------|----------|------|------|
| `createAppGraph` | function | `composition/app-graph.ts` | — | wires calendar, settings, scheduler, join, watcher, one opener |
| `initializeApp` | function | `app/lifecycle.ts` | — | boot order; stores `activeGraph` |
| `refreshCalendarPublication` | method | `facades/calendar.ts` | — | calls coordinator `requestRefresh` |
| `planSchedule` | function | `scheduler/core/plan-schedule.ts` | — | pure actions; `set-snapshot` first |
| `isCalendarAutomationEligible` | function | `domain/entities/calendar-result.ts` | — | live `complete` only |
| `createJoinMeeting` | function | `application/use-cases/join-meeting.ts` | — | success cancels pending auto-open |
| `createShellMeetingOpener` | function | `infrastructure/electron/shell-meeting-opener.ts` | — | allowlisted `graph.opener` |
| `typedHandle` | function | `ipc-handlers/shared.ts` | — | sole `ipcMain.handle` |
| `getActiveCalendarProvider` | function | `calendar/factory.ts` | — | probe throw, fixture, Darwin, else Google |
| `eventRecordIdentifier` | function | `swift/event-occurrence-identity.swift` | — | `id:bitPattern` occurrence uid |
| `readSwiftSource` | function | `swift/binary-cache.ts` | — | identity bytes + newline + events bytes |

## CONVENTIONS

- Relative imports use `.js` specifiers. Types use `import type` (`verbatimModuleSyntax`). No `enum` (`erasableSyntaxOnly`). Exported values need explicit types (`isolatedDeclarations`).
- `exactOptionalPropertyTypes`, `noPropertyAccessFromIndexSignature`, `noUncheckedIndexedAccess`.
- `bun run typecheck` runs `@typescript/native` (TypeScript 7). The `typescript` package (^6) is the ESLint parser.
- Bun `1.4.1` (`packageManager`). `engines.node` is `>=20`. `.nvmrc` and `validate:node` require host Node 26 for icons and release helpers.
- No `export *` barrels. Outside `scheduler/`, import `scheduler/facade.ts` or use `graph.scheduler`.
- OS checks: `main/platform/os.ts`. Meeting host checks: `domain/services/platform.ts`.
- Static `swift/*` imports: `calendar/providers/darwin-eventkit.ts` and `swift/**` only. Facades stay off `swift/*` and `calendar/auth/*`.
- Production main/preload casts use `As<T>(value)`. Tests may call `.As<T>()` after `tests/setup.as.ts`.
- Every BrowserWindow uses sandbox, context isolation, and no Node integration.
- Renderer templates run user strings through `escapeHtml()`.
- Automation timers arm only for live complete results. Partial and offline results stay visible and manually joinable.
- Brand constructors run only at trust boundaries.

## ANTI-PATTERNS (THIS PROJECT)

- `as any`, `@ts-ignore`, empty `catch`, thrown raw strings.
- `ipcMain.handle` / `webContents.send` outside `typedHandle` / `typedSend`.
- Channels `scheduler:force-poll` and `calendar:events-updated`.
- Windows lifecycle auto-OAuth. Deleting Google ciphertext on timeout, network, 429, 5xx, or storage errors.
- Recompiling the Swift helper for exits 2/3/4, timeout, or stream overflow.
- `execFile` `maxBuffer`, or raising Swift, Google HTTP, trace, or `MAX_PAGES=50` caps.
- One NSIS build for both Windows arches. Replacing `dist/latest.yml` without `merge:windows-latest-yml`.
- Describing the Windows Google MVP as EventKit multi-account parity.
- Product changes whose only evidence is a `retained` measurement receipt.
- Permanent `@deprecated` re-export shims.

## COMMANDS

```bash
bun install
bun run dev
bun run build
bun run typecheck
bun run test
bun run test:coverage
bun run lint
bun run format:check
bun run validate:node
bun run check:swift-package-layout
bun run guardrails
bun run guardrails:self-test
bun run guardrails:tests
bun run bench:calendar-parser
bun run package:mac
bun run package:win:x64
bun run package:win:arm64
bun run merge:windows-latest-yml
bun run verify:macos-release
bun run verify:windows-release
```

## NOTES

- Factory order: failed probe preflight throws; unpackaged `GOGMEET_CALENDAR_FIXTURE`; Darwin EventKit; every other OS uses Google.
- `GOGMEET_PERF_PROBE` is `startup`, `tray`, `alert`, or `safe-storage`, and only in packaged lab runs.
- Poll interval is 2 minutes on AC and 4 minutes on battery. `forcePoll({ reason: "user" })` skips the 10s coalesce. Power changes call `forcePoll({ reason: "power" })`.
- `showTomorrowMeetings` force-polls with reason `user`. `showCompletedTodayMeetings` only rebuilds the tray. Timing keys restart the scheduler.
- Quiet hours mute alerts and notifications. Auto-open still runs.
- Updater install runs only when policy kind is `full` (macOS requires Developer ID). Releases URL is `iWorkforces/GogMeet`.
- Beta tags come from pushes to `develop` (`vX.Y.Z-beta-N`). Official tags are `v${package.json.version}` from `main`.
- Vitest projects: `main`, `renderer`, `vertical`, `application`, `domain`, `shared`, `scripts`.
- Protocol detail: `src/domain/AGENTS.md`, `src/main/calendar/AGENTS.md`, `src/main/scheduler/AGENTS.md`, `src/main/swift/AGENTS.md`, `scripts/AGENTS.md`, `.github/workflows/AGENTS.md`.
