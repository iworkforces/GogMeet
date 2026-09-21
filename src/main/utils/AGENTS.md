# Main Utils — Process Utilities

**Parent:** `src/main/AGENTS.md`

## FILES

| File                        | Role                                                                                   | Key Exports                                                                                                                                     |
| --------------------------- | -------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `browser-window.ts`         | BrowserWindow config factory, CSP enforcement (incl. base-uri/object/frame/form)       | `SECURE_WEB_PREFERENCES`, `getPreloadPath()`, `loadWindowContent()`, `setupCspHeaders()`                                                        |
| `window-chrome.ts`          | Platform chrome + dialog canvas `#0d1117` + alert always-on-top                        | `DIALOG_BACKGROUND_COLOR`, `platformWindowChrome()`, `windowsSolidBackgroundColor()`, `bindWindowsThemeBackground()`, `applyAlertAlwaysOnTop()` |
| `secure-fs.ts`              | Owner-only dir/file modes for secret and cache paths                                   | `ensureSecureDir()`, `writeSecureFile()`, `SECURE_DIR_MODE` / `SECURE_FILE_MODE`                                                                |
| `packageInfo.ts`            | Lazy-load + cache `package.json`                                                       | `getPackageInfo()`, `PackageInfo`, `clearPackageInfoCache`, `isPackageInfoLoaded`                                                               |
| `log.ts`                    | electron-log bootstrap + scopes                                                        | `configureMainLogging()`, `mainLog`, `schedulerLog`, `calendarLog`                                                                              |
| `system-settings.ts`        | Open OS settings (non-meeting egress)                                                  | `openSystemSettings()`                                                                                                                          |
| `performance-trace.ts`      | Opt-in redacted bounded buffer (rows/bytes caps, startup-phase enum, terminal reserve) | `perfTrace`, `MAX_PERF_TRACE_ROWS` (1024), `MAX_PERF_TRACE_SERIALIZED_BYTES` (1 MiB), `PERF_TRACE_STARTUP_PHASES`                               |
| `performance-trace-file.ts` | Fixed atomic JSONL sink under Electron `userData`                                      | `flushPerfTraceToUserData`, `PERF_TRACE_FILENAME`, `registerPerfTraceBeforeQuitFlush`                                                           |

## Window chrome notes

- **Popover:** Darwin vibrancy; Windows opaque `#1c1c1e`.
- **Settings / About / Update:** solid **`DIALOG_BACKGROUND_COLOR` (`#0d1117`)** on Darwin and Windows (no vibrancy — hex must read true). Matches renderer settings CSS and About/Update inline styles. Chrome kind union includes `"update"`.
- **Alert:** Darwin `titleBarStyle: hiddenInset` only; always-on-top via `applyAlertAlwaysOnTop`.
- `bindWindowsThemeBackground` keeps Windows solid fills updated; for settings/about/update the fill is fixed `#0d1117`.

## Performance trace

- Enabled **only** when `GOGMEET_PERF_TRACE=1`.
- Finite allowlist: operation enum, outcome, errorClass, numeric fields, coarse platform/arch/powerMode.
- `startup-phase` requires `PERF_TRACE_STARTUP_PHASES` value; `probe-terminal` is flush-synthesized (not caller-inserted into the data buffer).
- Caps: **1024** data rows and **1 MiB** serialized bytes (terminal capacity reserved); drop-new with numeric drop counters.
- File sink: fixed `gogmeet-perf-trace-v1.jsonl` under `app.getPath("userData")` only — same-dir temp → fsync → rename; before-quit fallback; disabled creates no file; never throws into product paths.
- No caller/env path, no arbitrary string bags, no secrets (tokens, titles, URLs, bodies).
- Aggregate offline with `bun run perf:report`.

## CANONICAL HOMES (not in this package)

| Concern                                   | Canonical home                                                               |
| ----------------------------------------- | ---------------------------------------------------------------------------- |
| URL allowlist + validate                  | `domain/services/url-validation.ts`, `domain/policies/meet-url-allowlist.ts` |
| buildMeetUrl / detectPlatform             | `domain/services/build-meet-url.ts`, `platform.ts`                           |
| URL extract / clean description           | `domain/services/url-extract.ts`, `clean-description.ts`                     |
| Shell opener factory                      | `infrastructure/electron/shell-meeting-opener.ts`                            |
| Explicit join use case                    | `application/use-cases/join-meeting.ts`, exposed as `graph.join.byId`        |
| Unchecked casts                           | `shared/utils/as.ts`                                                         |
| Brand-icon aurora (About/Settings/Update) | `shared/utils/app-icon-aurora.ts`                                            |

## RULES

- Before meeting URL egress, use `graph.opener` or `graph.join.byId`.
- Join paths must use `graph.join.byId` rather than raw unenriched `openExternal`.
- Do not re-export domain or infrastructure modules from this package.
- `createAppGraph(overrides?: AppGraphOverrides)` owns one graph-local opener. It exposes it as `graph.opener` and injects the same object into scheduler auto-open and the join use case.
- Do not leave default-on tracing or secret-bearing metadata in product paths.
