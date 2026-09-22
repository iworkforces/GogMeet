# System — OS Integration Adapters

Leaf modules wrapping Electron/OS platform APIs. Mostly one OS surface per file. Lifecycle/orchestration stays in `app/lifecycle.ts`.

## FILES

| File                 | Role                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `power.ts`           | Battery-aware `getPollInterval()` (2min AC / 4min battery), ref-counted sleep prevention, `initPowerManagement(onChange: PowerChangeReason)`, `initPowerEvents` / `isOnBattery`. Reasons: `battery` \| `ac` \| `resume` \| `unlock`. Lifecycle maps these to `forcePoll({ reason: "power" })` (no full scheduler restart).                                                                                                                                                                        |
| `display-horizon.ts` | Single wall-clock timer: `setDisplayHorizonEvents` / `clearDisplayHorizon` / `onDisplayHorizonTick`; lifecycle wires ticks to `graph.scheduler.republishUiForDisplayTick()` plus tray force rebuild, with no automation                                                                                                                                                                                                                                                                           |
| `auto-launch.ts`     | Login items: `getAutoLaunchStatus` / `setAutoLaunch` / `syncAutoLaunch` via `app.setLoginItemSettings()`                                                                                                                                                                                                                                                                                                                                                                                          |
| `auto-updater.ts`    | `initAutoUpdater()` (quiet background ~5s) + `checkForUpdatesManual()` (native update window + tray labels) + `getUpdaterMenuPresentation()`; install policy `full` \| `feed-only` \| portable/unpackaged; mac full only with **Developer ID**; single-flight check; portable via `PORTABLE_EXECUTABLE_*` / `GOGMEET_PORTABLE=1`; **`beginUpdateDialogSession` each manual entry**; dialogs via `windows/update-window.ts` (`presentUpdateDialog` default; injectable `showMessageBox` for tests) |
| `notification.ts`    | `checkNotificationPermission` probe + `getNotificationSettingsDeepLink` (`x-apple…` / `ms-settings:…`)                                                                                                                                                                                                                                                                                                                                                                                            |
| `shortcuts.ts`       | `registerShortcuts(graph)` — CmdOrCtrl+Shift+M joins next meeting via `pickJoinTarget` + `graph.join.byId`                                                                                                                                                                                                                                                                                                                                                                                        |

## CONVENTIONS

- Prefer leaf modules with narrow dependencies.
- Each `init*` / `register*` is called from lifecycle (or settings IPC for auto-launch sync).
- OS branching via `platform/os.ts`.
- Shortcuts take `AppGraph` (not free-function calendar/scheduler imports).

## ANTI-PATTERNS

- Never import scheduler internals (`index`, `state`, `poll`) — facade or graph only.
- Never call `allowSleep()` without a matching prior `preventSleep()`.
- Never request notification permission here; `notification.ts` is probe-only.
- Never **download/install** outside `getUpdateInstallPolicy().kind === "full"` (feed-only/portable/unpackaged may still show explain dialogs).
- Manual check surfaces the native **update window** (aurora; `phase` is `checking` or `result`, and download stays on `checking`; session dismiss tracking; sticky-dismiss cleared per tray entry). Background startup check stays log-only (no Restart spam) and joins single-flight with manual.
- macOS **full** only when `codesign` reports Developer ID Application (not ad-hoc). Otherwise **feed-only**: no autoDownload / autoInstallOnAppQuit; Open Releases.
- Windows: `publisherName` absent skips Authenticode (sha512 still enforced); `GOGMEET_UNSIGNED=1` forces skip only when packaged (dogfood).
- Releases open: allowlisted `shell.openExternal` to pinned `github.com/iWorkforces/GogMeet/releases` only.
- Never call raw `shell.openExternal` for meetings from shortcuts — use `graph.join.byId`.
- Do not hard-code macOS-only settings URIs in `notification.ts`; use `getNotificationSettingsDeepLink()`.
