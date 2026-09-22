# Preload Script — Context Bridge

Sandboxed preload. The only bridge from renderer code to main IPC. It brands raw renderer inputs before they cross the process boundary.

## Files

| File | Role |
|------|------|
| `index.ts` | `contextBridge.exposeInMainWorld("api", api)` and `export type Api` |
| `tsconfig.json` | Preload project. Electron stays external in `rslib.config.preload.ts` |

`window.api` groups: `calendar` (getEvents, permission, disconnect, getUiState, onResultUpdated), `window.setHeight`, `app` (openExternal, joinMeeting, getVersion), `settings` (get, set, onChanged), `alert` (onShowAlert, notifyDismissed). `getEvents` returns `CalendarPublication` and is the only renderer refresh path.

`export type Api` is declared on `Window` in `src/renderer/env.d.ts`. `src/renderer/settings/env.d.ts` only points at that file.

## Trust boundary

| Input | Check | IPC |
|-------|-------|-----|
| URL string | `brandMeetUrl` (`asMeetUrl` + `isAllowedMeetHostname`) | `APP_OPEN_EXTERNAL` |
| Event id | `asEventId` | `APP_JOIN_MEETING` |
| Height | `clampWindowHeight` → `WindowHeight` | `WINDOW_SET_HEIGHT` |

Invalid URL or id returns `err(...)` and does not invoke. Main egress still rechecks `validateMeetUrl` inside `graph.opener`. Host changes belong in `domain/policies/meet-url-allowlist.ts`, Swift extract, and tests together.

## Transport

- Invoke: calendar, app, settings get/set.
- Send: `WINDOW_SET_HEIGHT`, `ALERT_DISMISSED`.
- On (unsubscribe `() => void`): `CALENDAR_RESULT_UPDATED`, `SETTINGS_CHANGED`, `ALERT_SHOW`.

Pushes from main use `typedSend`. Darwin diagnostics ride inside `CalendarPublication` and add no preload method. Settings v3 fields pass through; preload does not interpret them.

## Imports

Concrete files only: `shared/ipc-channels.js`, `shared/alert.js`, `domain/entities/settings.js`, `calendar-publication.js`, `brand.js`, `result.js`, `policies/meet-url-allowlist.js`.

## Rules

- Do not expose Node APIs or raw `ipcRenderer`.
- Do not add a models barrel.
