# Platform — OS helpers

**Parent:** `src/main/AGENTS.md`

OS process-platform helpers. Do **not** confuse with `domain/services/platform.ts` (meeting host: Meet vs Zoom).

## FILES

| File    | Role                          | Key Exports               |
| ------- | ----------------------------- | ------------------------- |
| `os.ts` | `process.platform` predicates | `isDarwin()`, `isWin32()` |

## NOTES

- Prefer these helpers over raw `process.platform === "…"` (testable via module mock).
- Leaf package: no calendar or Electron window logic here.
- Factory/tray/chrome/notifications/auto-updater branch on these helpers for dual-platform behavior.
- Tests: `tests/main/platform-os.test.ts`.
- `isDarwin()` is macOS and `isWin32()` is Windows. Every other `process.platform` is neither, and the calendar factory then selects Google.
- Tests should mock this module. Do not stub `process.platform` at each call site.
