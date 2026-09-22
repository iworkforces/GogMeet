# Renderer Layer

Vanilla TypeScript for three BrowserWindows. No framework. HTML templates escape user strings with `escapeHtml()` from `shared/utils/escape-html.js`. The tray menu is the primary meeting list. This process must not import `src/main/`.

## ENTRY POINTS

| Entry | HTML | Window | Role |
|-------|------|--------|------|
| `index.ts` | `index.html` | Popover 360×480. `setHeight` clamps 220–480 | Meeting list |
| `settings/index.ts` | `settings/index.html` | 520×760, canvas `#0d1117` | Schema v3, auto-save |
| `alert/index.ts` | `alert/index.html` | Starts 500×480, clamps to 280–480. Page fill `#0d0d0d` | Alert card, fade and zoom |

About and Update are main-process `data:` HTML, not renderer entries.

## STRUCTURE

`events/delegation.ts` (`data-action`), `lib/apply-events-push.ts`, `rendering/body.ts`, `settings/`, `alert/`, `styles/`, `utils/dom.ts` (`queryRequiredElement` returns null on a tag mismatch).

## LIST

`AppState` in `shared/app-state.ts`: `loading` | `no-permission` | `no-events` | `has-events` | `error`. Tray phases `limited` and `offline-cached` are not popover states. Partial results render retained events, or the ordinary empty state. No diagnostic labels or tokens.

`loadEvents()` → `calendar.getEvents()`. `loadGeneration` drops stale publications. On show, `render()` uses `Date.now()` immediately; network refresh waits until `lastPollTime` is at least 5s old. `applyEventsPush` drops tomorrow unless `showTomorrowMeetings`, then compares `eventListSignature` (`description` excluded). `onResultUpdated` still calls `render()` when that signature is unchanged so clock labels move.

Visible titles use `truncateMiddle` at 25, then `escapeHtml`. CSS `.meeting-title` sets `min-width: 0`. Completed-today rows (when enabled) are muted, have no join control, and re-render from a local timer at the next end or local midnight.

Actions on `#app`: `refresh`, `retry`, `grant-access`, `join-meeting` via `data-event-id`. Join failures show a banner.

## SETTINGS

Every `AppSettings` field except `schemaVersion` auto-saves. Dependents disable when Auto-Open, Meeting Alert, or Quiet Hours is off. Toggles are native checkboxes. A failed save reverts the toggle and escapes the error. Darwin versus Google is a user-agent `/Mac/i` test: every other host gets the Google block. Brand mark is the aurora **base** tier (`app-icon-aurora--settings` has no extra CSS). `color-scheme` meta says `light dark`; `settings/styles.css` forces dark `#0d1117`.

## ALERT

Payload has `hasMeetUrl` and optional `autoOpenAt`, and no `meetUrl`. `alert/index.ts` does not read `autoOpenAt`. Join uses `app.joinMeeting(id)` and keeps the card open on failure. Dismiss calls `alert.notifyDismissed(id)`. Escape dismisses. Main owns hide/reuse (`windows/AGENTS.md`).

## RULES

- Escape user strings in templates, including history titles. Banners that use `textContent` do not need `escapeHtml`.
- Full re-render on state change. No cross-render DOM refs.
- History expiry uses the local timer plus settings and horizon pushes, not an extra calendar poll.
