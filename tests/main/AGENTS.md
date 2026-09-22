# Main Process Test Suite

Vitest project `main`: Node, `tests/setup.main.ts` (Electron mock plus `setup.as.ts`). Flat `*.test.ts` files. `swift/` holds only the helper-process, parser, and occurrence-identity suites. Binary-manager, guards, and watch-sidecar tests stay in this directory.

## Areas

| Area | Lock |
|------|------|
| Graph / lifecycle | `app-graph*`, `lifecycle`, `app-bootstrap`, `index-bootstrap` |
| Scheduler | `scheduler-*`, `late-join`. Pure plan has no timers. Re-read Map/Set refs after reset |
| Calendar | `calendar*`, `google-*`, `fixture`, `offline-cache`, `stub-unsupported-provider` |
| Swift | `swift/*` plus top-level binary-manager, guards, watch sidecar |
| IPC | `ipc*`. `ipc-handlers-scheduler.test.ts` asserts the scheduler handler module is absent |
| Tray / windows | `tray*`, `meeting-menu`, `*-window`, `window-chrome`, `dock-visibility` |
| Probes / trace | `performance-probe*`, `performance-trace*`, `guardrails-security`, `after-pack` |

`google-calendar.test.ts` locks 401 refresh, provenance, `pagination-limit`, and incremental 429 (no same-poll full fetch). `calendar-factory.test.ts` locks probe preflight fail-closed. `alert-window.test.ts` locks generation-safe queue handoff and `autoOpenAt` on queued entries. Update-window fixtures follow the current `package.json` version; this file does not pin it.

Domain-pure suites live under `tests/domain/`. `preload.test.ts` is the allowed bridge into `src/preload`.

## Harness

- Default Electron mock is `tests/setup.main.ts` (`/app` or `C:\app`).
- Suites that care about import time re-`vi.mock("electron")`, then `vi.resetModules()` and dynamic `import()`.
- Mock specifiers use `.js`.
- Prefer `testAppGraph` over a partial graph object.
- Scheduler resets expose `_resetForTest` / `_resetForceTestState`.
- OAuth, sync tokens, offline cache, and settings use `mkdtemp` and a mocked `safeStorage`.
- `swift/event-occurrence-identity.test.ts` runs real `swiftc` on Darwin (`describe.skipIf`, long timeout).
- Binary-manager compile retry flushes `setTimeout` with microtasks. Fake timers hang Windows CI.
- Provider tests pass `AbortSignal` into `getEvents`.

## ANTI-PATTERNS

- Do not add `src/main/ipc-handlers/scheduler.ts`, `scheduler:force-poll`, or `calendar:events-updated`.
- Keep `SECURE_WEB_PREFERENCES` on every `BrowserWindow`.
- Keep Swift/watch ceilings, Google 15s/8MiB/60s, `MAX_PAGES=50`, and trace caps (1024 rows / 1MiB / `gogmeet-perf-trace-v1.jsonl`).
- Only live `complete` arms automation. Partial and offline stay joinable.
- Destroying the alert does not cancel a pending browser open.
- Do not hardcode `file:///app/...` senders. Do not import renderer code here.
- Do not retarget the helper-process real `spawn` or the identity `swiftc` test onto a pure mock.
