# App Bootstrap

**Parent:** `src/main/AGENTS.md`

## Overview

`app/` owns main-process startup, shutdown, IPC registration, and private packaged measurement probe dispatch. `src/main/index.ts` selects normal lifecycle or a validated probe mode.

## Files

| File                            | Exports                                                                     | Role                                                                                                                            |
| ------------------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `lifecycle.ts`                  | `initializeApp`, `shutdownApp`, `getActiveAppGraph`, `InitializeAppOptions` | Creates and stores `AppGraph`, owns init order and teardown. `probeSafe` suppresses external mutators during the startup probe. |
| `ipc.ts`                        | `registerIpcHandlers(win, graph)`                                           | Registers graph-backed handlers from `ipc-handlers/`.                                                                           |
| `performance-probe-contract.ts` | `PERF_PROBE_MODES`, preflight and user-data validation                      | Finite private packaged-probe contract.                                                                                         |
| `performance-probe.ts`          | `preflightOrBlock`, `finalizeStartupProbe`, `runNamedProbeSurface`          | Runs preflight, dispatches named surfaces, and flushes the fixed trace.                                                         |
| `performance-probes/*`          | tray, alert, safe-storage drivers                                           | Surface drivers that use synthetic meeting, calendar, and token values.                                                         |

## Lifecycle ownership

- `initializeApp()` calls `createAppGraph()` and stores `activeGraph` before IPC or dependent subsystem work.
- The graph supplies calendar, settings, scheduler, watcher, join, and opener surfaces to lifecycle, tray, shortcuts, and IPC. Lifecycle still owns process-wide wiring such as display horizon, power, notifications, auto-launch, and updater initialization.
- Settings load before scheduler start. Calendar permission status is always checked; only Darwin may request a not-determined permission during lifecycle. Windows OAuth remains user initiated from tray or Settings.
- Display-horizon wiring comes before scheduler start and calls `graph.scheduler.republishUiForDisplayTick()` plus `forceTrayMenuRefresh()`. This repushes display state and never arms automation.
- Shutdown removes power and display-horizon wiring, destroys alert, settings, about, and update windows, stops the active graph's scheduler and watcher, unregisters shortcuts, then clears `activeGraph`. Before initialization, graph teardown is a no-op.
- `probeSafe` suppresses power, shortcuts, notification permission, auto-launch, and updater work. It is startup-probe lifecycle behavior, not a general reduced product mode.

## Packaged measurement probes

- `GOGMEET_PERF_PROBE` accepts only `startup`, `tray`, `alert`, or `safe-storage`. Any set probe environment prevents normal boot, even when its value fails validation.
- `preflightOrBlock()` validates packaged status, `GOGMEET_PERF_TRACE=1`, and the Electron user-data directory before any probe surface starts. The directory must be a real directory below `os.tmpdir()` and both its requested and resolved leaf names must start with `gogmeet-perf-probe-`.
- Invalid preflight blocks the dispatcher. Calendar factory preflight also throws before EventKit, Google, token, or cache adapters can run. `index.ts` owns probe mode selection and the exit path.
- Startup runs the production lifecycle with `probeSafe`, records suppressed external phases as `not-exercised`, then flushes once through `finalizeStartupProbe()`.
- Tray runs production `setupTray`, main-bus updates, and menu rebuilds with synthetic events and `CalendarUiState` data.
- Alert runs production `showAlert` and the alert window hide and reuse lifecycle with synthetic meetings. Its destroy-between sequence is a measurement baseline, not normal product behavior.
- Safe-storage runs real encrypted Google-token and offline-cache adapters with synthetic values, including corruption preservation checks.
- Named surfaces have a 75-second budget and flush their fixed JSONL trace at completion or failure.

## Rules

- Keep lifecycle and probe dispatch in `app/`; do not move provider, scheduler, window, or infrastructure behavior here.
- Both `lifecycle.ts` and `ipc.ts` are called from `index.ts` and tests.
- Fatal initialization shows an error box and quits. Lifecycle aggregates non-fatal failures.
- The packaged updater initializes last among normal non-critical init work and is inactive for unpackaged and portable builds.
