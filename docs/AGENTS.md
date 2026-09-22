# docs/

Status, decisions, and plans. Architecture rules live in the nested `AGENTS.md` files. When `STATUS.md` and `package.json` disagree on the version, `package.json` wins.

## WHERE TO LOOK

| Question | File |
|----------|------|
| Shipped vs open | `STATUS.md` |
| Permanent don'ts | `security/permanent-guardrails.md` (`bun run guardrails`) |
| Decisions | `adr/0001-clean-architecture-multi-wave.md`, `adr/0002-google-incremental-sync.md` |
| Active plans | `plans/calendar-partial-refresh-diagnostics.md`, `plans/gogmeet-performance-stability-hardening.md` |
| Measurement lab | `performance/measurement-lab.md` |
| Deferred packaging notes | `performance/packaging-startup-notes.md` |

## HISTORICAL

`STATUS.md` already marks these as archive. Do not reopen them as current bugs:

- `enhancement-development-plan.md` (written against 1.16.0)
- `clean-architecture-refactor-plan.md`
- `windows-platform-support-design.md` (opens as macOS-only at 1.16.0)

`windows-dogfood.md` is not in that table and is stale. It still describes branch `feature/windows-platform-support`, no official NSIS, no Windows CI, and no auto-update. Current packaging and CI are `build/AGENTS.md` and `.github/workflows/AGENTS.md`.

## NOTES

- STATUS says app version **1.19.0** (refreshed 2026-08-13). `package.json` is **2.0.1**.
- Plans and `security/permanent-guardrails.md` cite `plans/gogmeet-out-of-scope-follow-on.md` and `plans/gogmeet-performance-enhancement.md`. Those files are not in the tree.
