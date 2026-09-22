# Scheduler State — Sliced State Composition

Private to `scheduler/`. `.sentrux` rule `state-internal-only` is not CI. Do not import `state/*` from outside `scheduler/`.

## FILES

| File | Role |
|------|------|
| `index.ts` | `SchedulerState` and `createSchedulerState()`. Re-exports cleanup helpers, `ScheduledEventSnapshot`, `PowerCallbacks`. No singleton and no `replaceState` |
| `state-cleanup.ts` | `clearSchedulerResources` (`preserveFiredState`, `preserveLastKnownEvents`) |
| `state-timers.ts` | Timer maps, `scheduledEventData`, fired / alert-fired / `cancelledEvents`. `FIRED_EVENT_TTL_MS` is 15 min |
| `state-display.ts` | Active title and in-meeting ids, dirty flags |
| `state-poll.ts` | `pollTimeout`, `pollEpoch`, `consecutiveErrors`, `lastKnownEvents`. Cap constant is 4 |
| `state-runtime.ts` | `win`, `onTrayTitleUpdate`, `powerCallbacks` |

## NOTES

- `createSchedulerState()` spreads timers, display, poll, and runtime.
- Stop/restart replacement is `resetRuntimeState` in `facade.ts`. It keeps the window, tray callback, and power callbacks, preserves `lastKnownEvents`, and copies fired sets when `preserveFiredState` is set.
- `poll.ts` increments `consecutiveErrors` and caps it at 4. The warn threshold is 3. There is no `incrementConsecutiveErrors()`.
- `firedEvents` / `alertFiredEvents` suppress browser open and alert re-fire. `cancelledEvents` is title-countdown bookkeeping only.
- The interpreter writes `scheduledEventData` (`set-snapshot`, `start-in-meeting`, `update-snapshot`). `browser-timer` does not.
- Scheduler code reads `runtime.state` directly. `index.ts` has no getter layer.
- `lastKnownEvents` stores the `CalendarResult` unchanged, including a Darwin live partial.

## WHERE TO LOOK

| Task | Location |
|------|----------|
| Add a timer map | `state-timers.ts` → `TimersState` |
| Add a tray scalar | `state-display.ts` → `DisplayState` |
| Error cap or `pollEpoch` | `state-poll.ts` |
| Runtime callback | `state-runtime.ts` → `RuntimeState` |
| Add a slice | spread it in `createSchedulerState()` |

`pollEpoch` is the stale-callback guard. `PowerCallbacks` is re-exported for power wiring. Facade methods are the access path from outside this folder.
