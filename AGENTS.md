# GogMeet - AGENTS.md

- **Updated:** 2026-09-21
- **App version:** 1.20.4
- **Branch:** develop

`package.json` is the version source of truth. Keep this root metadata aligned with it, but do not hardcode the version elsewhere. Shipped vs open backlog: `docs/STATUS.md`.

Desktop tray app for calendar meeting reminders. **macOS** reads EventKit via a Swift helper; **Windows** uses Google Calendar API + OAuth PKCE (Google-only MVP — not EventKit multi-account parity). Lists Meet/Zoom/Teams/Webex/Calendly join links, auto-opens join URLs before start, optional alert window, tray menu, optional completed-today history, and `CmdOrCtrl+Shift+M` to join the next meeting.

## STACK

| Layer              | Tech                                                                                                                                                                                                                                             |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Runtime            | Electron `^44.4.3`; all BrowserWindows sandboxed/context-isolated/no Node integration                                                                                                                                                            |
| Language           | Typecheck via `@typescript/native` (TypeScript `^7.0.2`); package `typescript` `^6` for ESLint tooling; `isolatedDeclarations`, `verbatimModuleSyntax`, `erasableSyntaxOnly`, `noPropertyAccessFromIndexSignature`, `exactOptionalPropertyTypes` |
| Build              | Rslib for main/preload CJS; Rsbuild for three renderer entries                                                                                                                                                                                   |
| Package            | Bun `>=1.3.0`, `packageManager: bun@1.4.1`; host Node floor `>=20`, CI/recommended Node `26` (`.nvmrc`)                                                                                                                                          |
| Calendar (macOS)   | Swift EventKit helper: `googlemeet-events.swift` + `swift/event-occurrence-identity.swift` (occurrence-aware UIDs); binary under `{tmpdir}/googlemeet/`; bounded spawn runner                                                                    |
| Calendar (Windows) | Google OAuth PKCE + Calendar API; encrypted under `userData` with owner-only modes: tokens `calendar-auth/google.enc`, sync tokens `calendar-auth/google-sync.enc`, offline cache `calendar-cache.enc`                                           |
| Architecture       | Clean Architecture hybrid: `src/domain` → application ports/use cases → infrastructure adapters → facades + `createAppGraph`                                                                                                                     |
| Test               | Vitest workspace: domain / application / main / renderer / shared / scripts; `setup.as.ts` installs cast extension                                                                                                                               |
| Package build      | electron-builder: mac DMG+ZIP; win NSIS+portable; `arm64` + `x64`                                                                                                                                                                                |
| Updates/logging    | `electron-updater` (packaged non-portable only), `electron-log`                                                                                                                                                                                  |
| Lint edges         | `eslint-plugin-boundaries` (`boundaries/dependencies: error`); `.sentrux/` is secondary (not CI-wired)                                                                                                                                           |
| Measurement        | Opt-in `GOGMEET_PERF_TRACE=1` (1024 rows / 1 MiB, fixed atomic JSONL); private packaged probes via `GOGMEET_PERF_PROBE` (lab only); `perf:*` / `bench:*`; lab docs `docs/performance/measurement-lab.md`; weekly non-PR `measurement.yml`        |
| Guardrails         | Permanent P-NEVER invariants: `docs/security/permanent-guardrails.md`; `bun run guardrails` (+ `guardrails:self-test` / `guardrails:tests`); freezes include Swift/watch bounds, trace caps, probe prefix, `MAX_PAGES=50`                        |

## STRUCTURE

```text
GogMeet/
├── src/
│   ├── domain/           # pure: entities, policies, services (no Electron)
│   ├── shared/           # IPC maps + thin DTOs + cast/escape/aurora helpers (imports domain types)
│   ├── main/
│   │   ├── composition/  # createAppGraph, createTestAppGraph
│   │   ├── application/  # ports + use cases
│   │   ├── infrastructure/ # JsonSettingsStore, ShellMeetingOpener
│   │   ├── facades/      # calendar, watcher, status, settings factories
│   │   ├── calendar/     # factory, providers, google-http, offline-cache, auth (+ sync tokens), refresh-coordinator
│   │   ├── scheduler/    # facade + planSchedule (pure) + interpret + state/
│   │   ├── ipc-handlers/ # typed IPC (receives AppGraph)
│   │   ├── menu/, system/, windows/, utils/, platform/, swift/ (+ event-occurrence-identity.swift), app/
│   │   └── tray.ts, events.ts, index.ts, googlemeet-events.swift
│   ├── preload/          # contextBridge → window.api
│   ├── renderer/         # popover, settings, alert (vanilla TS)
│   └── assets/           # tray icons (mac 18/36 + win 16/32) + about-icon.svg (About + Settings brand)
├── tests/                # domain, application, main, renderer, shared, scripts, helpers, bench
├── scripts/              # dev, icons, release verifiers, performance lab, latest.yml merge, guardrails
├── build/                # electron-builder hooks, entitlements, icons
├── docs/                 # CA plan, windows design/dogfood, adr/, plans/, security/, performance/
├── vitest.workspace.ts   # unit/coverage projects
├── vitest.bench.config.ts # isolated microbenchmarks (not in workspace)
├── .github/workflows/    # pr-check + release (release-mac/win jobs) + beta-release + measurement
└── .sentrux/             # secondary architecture constraints (not CI-wired)
```

Skip generated/cache outputs: `lib/`, `dist/`, `coverage/`, `node_modules/`, `.eslintcache`, `*.tsbuildinfo`.

## WHERE TO LOOK

| Task                       | Location                                                                                                    | Notes                                                                                                                                                                                  |
| -------------------------- | ----------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Runtime bootstrap          | `src/main/index.ts`, `app/lifecycle.ts`                                                                     | `createAppGraph()` first; settings before scheduler; auto-updater last                                                                                                                 |
| Composition root           | `composition/app-graph.ts`                                                                                  | calendar / settings / join / opener / scheduler / watcher surfaces                                                                                                                     |
| Add IPC                    | `shared/ipc-channels.ts` → `ipc-handlers/*` (graph) → preload → renderer                                    | `typedHandle` / sender validation                                                                                                                                                      |
| Pure domain                | `src/domain/`                                                                                               | entities, policies, services                                                                                                                                                           |
| Calendar result contract   | `domain/entities/calendar-result.ts`                                                                        | exhaustive ok provenance + helpers; Darwin partial diagnostics                                                                                                                         |
| Calendar UI phases         | `domain/entities/calendar-ui-state.ts`                                                                      | includes `limited`, `cacheAgeMs`, nullable Darwin diagnostics                                                                                                                          |
| Calendar facade            | `facades/calendar.ts`                                                                                       | use cases + CalendarPort; **no** `swift/*` or `calendar/auth/*`                                                                                                                        |
| Calendar providers         | `calendar/factory.ts`, `providers/*`                                                                        | Darwin EventKit; Windows Google; fixture                                                                                                                                               |
| Calendar refresh           | `calendar/refresh-coordinator.ts`                                                                           | single-flight + one queued follow-up; `CalendarPublication` generation                                                                                                                 |
| Google HTTP bounds         | `calendar/google-http.ts`                                                                                   | 15s / 8MiB / 60s poll budget; typed errors                                                                                                                                             |
| Google OAuth / tokens      | `calendar/auth/*`                                                                                           | PKCE; `if-needed` \| `force` refresh; preserve ciphertext                                                                                                                              |
| Google incremental sync    | `calendar/auth/google-sync-tokens.ts` + Google provider                                                     | encrypted `google-sync.enc` nextSyncToken map; process-local index; 410 → full fetch (ADR 0002)                                                                                        |
| Offline cache              | `calendar/offline-cache.ts`                                                                                 | schema v1 `{version,observedAt,cachedAt,events}`; complete writes only from Google                                                                                                     |
| URL extract / buildMeetUrl | `domain/services/url-extract.ts`, `build-meet-url.ts`                                                       | pure                                                                                                                                                                                   |
| Allowlist / validate       | `domain/policies/meet-url-allowlist.ts`, `services/url-validation.ts`                                       | pure                                                                                                                                                                                   |
| Meeting wall-clock         | `domain/services/meeting-time.ts`                                                                           | in-progress / upcoming / completed-today / display horizon                                                                                                                             |
| Open meeting URL           | `infrastructure/electron/shell-meeting-opener.ts`                                                           | allowlisted egress; exposed as `graph.opener` and injected into scheduler and join                                                                                                     |
| Settings store             | `infrastructure/settings/json-settings-store.ts`                                                            | FS under userData; schema **v3**                                                                                                                                                       |
| Join hub                   | `application/use-cases/join-meeting.ts` / `graph.join.byId`                                                 | injected opener; successful explicit join cancels pending browser auto-open                                                                                                            |
| Scheduler public API       | `scheduler/facade.ts`                                                                                       | only external scheduler import                                                                                                                                                         |
| Schedule decisions         | `scheduler/core/plan-schedule.ts`                                                                           | pure; `set-snapshot` before timers                                                                                                                                                     |
| Display horizon            | `system/display-horizon.ts`                                                                                 | wall-clock re-filter timer; no automation                                                                                                                                              |
| Swift one-shot runner      | `swift/swift-helper-process.ts`, `binary-manager.ts`, `binary-cache.ts`                                     | bounded spawn; integrity-only recompile; dual-source hash (identity + `"\n"` + events)                                                                                                 |
| Swift sources (macOS)      | `googlemeet-events.swift`, `swift/event-occurrence-identity.swift`                                          | both in electron-builder `files` + `asarUnpack`; release verifier dual-hash                                                                                                            |
| Calendar watch             | `facades/calendar-watcher.ts`                                                                               | provider `startWatch` / `reviveWatch`                                                                                                                                                  |
| Tray menu                  | `tray.ts`, `menu/meeting-menu.ts`                                                                           | limited/offline rows; optional completed-today history; tray takes AppGraph; `requestTrayRebuild` microtask-coalesces bus bursts; `forceTrayMenuRefresh` sync force (horizon/settings) |
| Settings UI                | `renderer/settings/*`, `windows/settings-window.ts`                                                         | 520×760; canvas `#0d1117`; brand aurora icon; full schema v3 prefs; auto-save                                                                                                          |
| About UI                   | `windows/about-window.ts`                                                                                   | 320×360 data: HTML; canvas `#0d1117`; brand aurora; no Close (Esc / traffic lights); CSP; https-only repo                                                                              |
| Updates UI                 | `windows/update-window.ts`                                                                                  | 340×340–400 data: HTML; About-tier aurora; checking/result phases; dismiss-only Esc or multi-action buttons                                                                            |
| App-icon aurora            | `shared/utils/app-icon-aurora.ts`                                                                           | Pure CSS+HTML; calm Settings base; fancy About/Update tier; a11y media queries                                                                                                         |
| Window chrome              | `utils/window-chrome.ts`                                                                                    | `DIALOG_BACKGROUND_COLOR`; kinds `popover`/`settings`/`about`/`update`/`alert`                                                                                                         |
| Unchecked casts            | `shared/utils/as.ts`                                                                                        | `.As<T>()` / free `As<T>(value)`                                                                                                                                                       |
| Opt-in perf trace          | `main/utils/performance-trace.ts` + `performance-trace-file.ts`                                             | `GOGMEET_PERF_TRACE=1`; 1024 rows / 1 MiB; fixed atomic `gogmeet-perf-trace-v1.jsonl` under userData                                                                                   |
| Packaged probes            | `app/performance-probe*.ts`, `app/performance-probes/*`, `calendar/providers/performance-probe-calendar.ts` | Lab only; never default product env                                                                                                                                                    |
| Perf scripts               | `scripts/performance/*`                                                                                     | `perf:report`, `perf:workspace-fingerprint`, `perf:startup`/`tray`/`alert`/`safe-storage` (exit 1 on crash/timeout)                                                                    |
| Parser bench               | `tests/bench/`, `vitest.bench.config.ts`                                                                    | `bench:calendar-parser`                                                                                                                                                                |
| OS vs meeting host         | `platform/os.ts` vs `domain/services/platform.ts`                                                           |                                                                                                                                                                                        |
| Packaging / CI             | `electron-builder.yml`, `build/AGENTS.md`, `.github/workflows/AGENTS.md`, `check:swift-package-layout`      | dual Swift sources + dual-source hash formula                                                                                                                                          |
| Shipped vs backlog         | `docs/STATUS.md`                                                                                            | prefer over historical `docs/enhancement-development-plan.md`                                                                                                                          |
| Design / perf plan         | `docs/clean-architecture-refactor-plan.md`, `docs/windows-*.md`, `docs/plans/*`, `docs/adr/*`               |                                                                                                                                                                                        |
| Secure secret files        | `main/utils/secure-fs.ts`                                                                                   | `0o700` dirs / `0o600` files for OAuth, sync tokens, offline cache                                                                                                                     |
| Shared meeting opener      | `composition/app-graph.ts`                                                                                  | one graph-local opener for IPC, explicit joins, and scheduler auto-open                                                                                                                |

## CODE MAP

| Symbol / file                                              | Role                                                                                  |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `createAppGraph(overrides?: AppGraphOverrides)`            | graph-local composition root; finalizes overrides before downstream closures use them |
| `initializeApp()` / `shutdownApp()`                        | lifecycle; graph stored as `activeGraph`                                              |
| `facades/calendar.ts`                                      | calendar use cases + UI state bus + refresh coordinator bind                          |
| `refreshCalendarPublication` / `requestCalendarRefresh`    | single-flight fetch → `CalendarPublication`                                           |
| `graph.calendar.getEvents` / `getEventsResult`             | publication vs result-only coordinated refresh                                        |
| `scheduler/facade.ts`                                      | only external scheduler import                                                        |
| `graph.scheduler.republishUiForDisplayTick`                | wall-clock UI re-push on the graph-local scheduler                                    |
| `scheduler/core/plan-schedule.ts`                          | pure schedule plan ADT (`set-snapshot`, arm-*)                                        |
| `domain/services/build-meet-url.ts`                        | pure join URL with identity params                                                    |
| `filterCompletedTodayMeetings` / `isCompletedTodayMeeting` | completed-today history membership                                                    |
| `truncateMiddle` / `MEETING_TITLE_DISPLAY_MAX_CHARS`       | title display middle-truncate (25)                                                    |
| `graph.join.byId`                                          | explicit join use case + suppress pending auto-open                                   |
| `isCalendarOk` / `isCalendarAutomationEligible`            | ok narrowing; automation gate (live complete only)                                    |
| `DarwinPartialRefreshDiagnostics`                          | six-count aggregate for Darwin live partial results                                   |
| `googleHttpRequest` / `refreshGoogleAccessToken`           | bounded Google transport; force/if-needed refresh                                     |
| `loadGoogleSyncTokens` / `saveGoogleSyncTokens`            | encrypted Google nextSyncToken map                                                    |
| `eventRecordIdentifier` (Swift)                            | occurrence-aware EventKit uid (`id:bitPattern`)                                       |
| `readSwiftSource` / `COMPILED_SWIFT_SOURCE_PATH`           | dual-source concat for compile + `source.hash`                                        |
| `graph.opener`                                             | allowlisted egress adapter shared by scheduler and join                               |
| `formatOfflineCacheAgeLabel`                               | tray offline age from `cacheAgeMs`                                                    |
| `ensureSecureDir` / `writeSecureFile`                      | owner-only modes for secret/cache paths                                               |

## CONVENTIONS

- TypeScript imports use `.js` specifiers; type-only imports use `import type`.
- Bun is the primary package manager; host Node 26 for validation/icon generation/release helpers.
- No package-level barrels. Outside `scheduler/`, import only `scheduler/facade.ts` (or `graph.scheduler`); `scheduler/index.ts` may re-export for internal use.
- Prefer `platform/os.ts` over raw `process.platform` for OS branches.
- Never static-import `swift/*` outside `calendar/providers/darwin-eventkit.ts` and `swift/**`.
- Facades must not import `swift/*` or `calendar/auth/*`.
- Branded values created only at trust boundaries.
- Prefer free-function `As<T>(v)` in production main/preload (survives Rslib tree-shaking); method `.As<T>()` is fine in tests once `setup.as.ts` installs the prototype. Never bare side-effect-only import of `as.js` for production call sites.
- **CalendarResult** success is exhaustive: live `complete`\|`partial` or `offline-cache` with timestamps. Narrow with `isCalendarOk` / `isCalendarLiveOk` / `isCalendarOfflineOk`.
- **Automation rule:** only live complete (`isCalendarAutomationEligible`) arms timers; partial/offline call `suspendAutomation` while keeping display/join data.
- **Darwin partial refreshes:** the EventKit parser keeps valid events while recording skipped records. The Darwin provider aggregates `total`, `malformedRecord`, `malformedFieldCount`, `invalidIso`, `invalidId`, and `duplicateUid`; a nonzero total makes the live result partial and emits one count-only provider warning. `GetMeetings` publishes the existing `CalendarPublication`, clears stale diagnostics on complete, offline, and error states, and keeps partial events available for display and manual join.
- **Darwin tray diagnostics:** only the native macOS tray renders the partial warning and diagnostic rows, all disabled. Its menu signature includes every diagnostic count so changed diagnostics rebuild the menu. Google and Windows use the generic partial state without Darwin diagnostic rows.
- Renderer production has no diagnostics UI. It renders retained partial events or the ordinary no-events state, never tray warning text, diagnostic labels, or diagnostic tokens.
- `CalendarPort.getEvents(signal: AbortSignal)` — providers must honor cancel.
- Meeting URL allowlisting at egress only through `ShellMeetingOpener`, exposed as `graph.opener`.
- All user join paths call `graph.join.byId`.
- Tray menu: `setContextMenu()` before first activation; Windows left-click `popUpContextMenu`.
- User strings in renderer HTML go through `escapeHtml()`.

## ANTI-PATTERNS

- `as any`, `@ts-ignore`, empty catches, raw-string thrown errors.
- Raw `ipcMain.handle` / `webContents.send` outside `typedHandle` / `typedSend`.
- Importing `swift/*` from facades, lifecycle, Google provider, or settings.
- Auto-opening OAuth on Windows lifecycle (use tray/Settings Connect only).
- Dual-arch single NSIS invocation for official Windows artifacts.
- Overwriting `latest.yml` without `merge:windows-latest-yml`.
- Permanent re-export / `@deprecated` shims after callers retarget.
- Claiming EventKit multi-source parity for Windows Google MVP.
- Clearing Google tokens on transient network/timeout/storage failures.
- Recompiling the Swift helper for timeout/overflow/semantic exits 2/3/4.
- Using unbounded `execFile` maxBuffer or raising buffers instead of streaming bounds.
- Shipping speculative tray/alert/startup optimizations without measurement receipts.

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
bun run perf:report -- --fixture synthetic
bun run perf:workspace-fingerprint
bun run perf:lab
bun run package:mac
bun run package:win:x64
bun run package:win:arm64
bun run merge:windows-latest-yml
bun run verify:macos-release
bun run verify:windows-release
bun run clean
```

## SECURITY GUARDRAILS

Permanent non-goals (plaintext tokens, weak Electron prefs, deleted IPC shims, unbounded buffers, secret traces) are registered in **`docs/security/permanent-guardrails.md`** and enforced by **`bun run guardrails`** (+ freeze tests) on every PR. Active stability/measurement plan: `docs/plans/gogmeet-performance-stability-hardening.md`. Broader feature backlog: `docs/enhancement-development-plan.md`.

## NOTES

- macOS: EventKit permission / AppleScript probes; lifecycle may auto-request when not-determined. Windows: never auto-OAuth.
- Swift protocol: JSON Lines 9 strings; exit codes 0/2/3/4; cache mode `0o700` under `os.tmpdir()/googlemeet`. **UID field** is occurrence-aware (`eventRecordIdentifier`: `calendarItemIdentifier` + occurrence/start date bit-pattern) so recurring instances do not collide. Sources: `googlemeet-events.swift` + `swift/event-occurrence-identity.swift` (both packaged/`asarUnpack`); compile materializes a single temp unit under the cache dir (top-level script mode); integrity `source.hash` digests **identity + `"\n"` + events** (release verifier must match). One-shot: spawn stream 8 MiB/256 KiB/15 s; recompile only after integrity failure. Watch sidecar: same 8 MiB/256 KiB stream ceilings; Swift helper debounce 1000 ms, Node sidecar debounce 2000 ms; stdout overflow terminates child (restart budget, never recompile); stderr past ceiling is suppressed once without restart; **one** `scheduleRestart` per child (error+exit de-duped).
- Google: bounded HTTP (15 s request, 8 MiB body, 60 s poll budget); 401 → force refresh once; credentials preserved on transient failures. Incremental **429** preserves token/index and does **not** same-poll full-window retry (5xx still may).
- Google incremental sync (ADR 0002): after a successful full window list, store opaque `nextSyncToken` per calendar in `calendar-auth/google-sync.enc`; later polls may use `syncToken` + process-local event index; HTTP **410** clears that token/index and full-fetches; disconnect clears tokens + index; cold process always full-fetches. Page chains capped at **50**; remaining `nextPageToken` or mid-chain malformed pages → `pagination-limit` (live partial when any calendar completes; no incomplete token/index/cache commit).
- Windows offline: encrypted cache schema v1 `{version,observedAt,cachedAt,events}`; Google writes only **live complete** snapshots; load rejects legacy/corrupt/future metadata and filters ended events.
- Alert window: prefer hide/show reuse of a single BrowserWindow (`destroyAlertWindow` for shutdown/tests); generation-safe queue handoff (module-owned immediate; gen-mismatch must not clear `isAlertShowing` under concurrent reschedule; FIFO preserves `autoOpenAt`); payload omits `meetUrl` (join via id); force-destroy never cancels browser-open.
- Settings / About / Update canvas is fixed product fill **`#0d1117`** (`DIALOG_BACKGROUND_COLOR` + renderer CSS). Settings 520×760 exposes full schema v3 timing UI (alert lead, late-join, quiet hours times); dependents disable when parent toggles are off; brand mark under title bar uses `about-icon.svg` + shared aurora (calmer **base** tier). About **320×360** data: HTML is not always-on-top (Settings is); compact stack, **no Close** (Esc / traffic lights; GitHub link not auto-focused); decorative **About-tier** aurora (brand blue `#4285F4`) via `appIconWithAuroraHtml` / `APP_ICON_AURORA_CSS`.
- UI phases: `ready` / `empty` / `limited` (partial) / `offline-cached` (with `cacheAgeMs`) / `error` / …
- Settings schema **v3**: includes `showCompletedTodayMeetings` (default `false`, display-only tray rebuild) plus full timing/automation fields surfaced in Settings UI. IPC still restarts scheduler only for TIMING_KEYS; completed-history toggle does not poll/restart.
- Completed-today history (when enabled): same-local-day timed events with `end ≤ now`, newest-ended first; muted non-joinable rows in **tray menu** and **popover**. All-day excluded from tray history. Presentation timer in renderer (next end or local midnight); tray uses display-horizon + signature that includes the toggle.
- Auto-open: non-all-day when `autoOpenEnabled`; `openBeforeMinutes` 0–10; alert ~`alertLeadSeconds` before open; dismiss cancels open. Snapshot state is independent of browser timers (`set-snapshot`).
- Display “In progress” / upcoming lists use wall-clock `start ≤ now < end` / `end > now` (`domain/services/meeting-time.ts`). Providers may still return same-day ended events; UI must re-filter when the clock advances (display-horizon timer + tray/popover open rebuild — not content signature alone).
- Calendar refresh: single-flight coordinator (`refresh-coordinator.ts`); poll and IPC `CALENDAR_GET_EVENTS` share it; at most one queued follow-up; cancel on scheduler stop.
- Poll: 2 min AC / 4 min battery; auto/watch/power `forcePoll` coalesces within 10s; tray **Refresh** uses `forcePoll({ reason: "user" })` (no coalesce) then `requestTrayRebuild({ force: true })`. Power **resume/unlock** and AC/battery use `forcePoll({ reason: "power" })` (no full scheduler restart). Bus-driven list/status updates use microtask-coalesced `requestTrayRebuild`; display-horizon and completed-history toggle use sync `forceTrayMenuRefresh`. Startup `first-poll` trace fires when the first guarded poll **settles**.
- Auto-updater: packaged non-portable only; install policy `full` (mac **Developer ID** / Windows NSIS) vs `feed-only` (ad-hoc/unsigned mac — Open Releases only). Quiet background check (~5s) + single-flight with tray **Check for Updates…**. Manual path presents native **`windows/update-window.ts`** (aurora; checking → result; dismiss-only Esc or action buttons; session dismiss tracking). Portable/unpackaged explain-only. Releases URL pinned to `iWorkforces/GogMeet`.
- Supported hosts: Meet, Zoom (`.zoom.us`), Teams (`teams.microsoft.com` / `teams.live.com`), Webex (`.webex.com`), Calendly. Extract also handles HTML `href=` and scheme-less bare hosts. New wrappers: Swift extract + domain url-extract + allowlist + tests.
- Limited/offline UI: tray shows **Auto-open paused** (automation remains live-complete only) and offline **last synced** age via `cacheAgeMs`. Join failures surface in alert (stay open) and popover banner; Settings calendar is platform-gated (EventKit vs Google).
- Performance / stability plan: `docs/plans/gogmeet-performance-stability-hardening.md` — product hardenings + measurement lab shipped; **no product optimization** from `retained` receipts (separate plan required). Weekly non-PR lab: `measurement.yml` (synthetic + optional native package jobs).
- Packaged measurement probe: `GOGMEET_PERF_PROBE=startup|tray|alert|safe-storage` is **lab/CI only** (never production user env). Requires packaged + `GOGMEET_PERF_TRACE=1` + isolated `--user-data-dir` (`gogmeet-perf-probe-` under tmpdir); private empty calendar; factory fail-closed on bad preflight. Measure scripts: exit **0** blocked/threshold, exit **1** timeout/crash/missing-trace.
- Beta: push to `develop` → `vX.Y.Z-beta-N` pre-release. Official: `v${package.json.version}` from `main`.
