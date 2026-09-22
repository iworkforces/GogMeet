# Application Test Suite

## OVERVIEW

Vitest project `application`: Node, no Electron mocks. Covers `src/main/application/use-cases/**` with port fakes. Coverage floors: **80 / 80 / 80 / 70** (L/S/F/B).

## Suites

| Suite                         | Focus                                                                                                                                                                                                                     |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `get-meetings.test.ts`                     | Maps live complete/partial/offline-cache → UI phases (`ready` / `limited` / `offline-cached`) + error; projects Darwin aggregate diagnostics for limited results and clears them for complete, offline, and error results |
| `get-meetings-cancellation.test.ts`        | A provider that resolves after cancel does not project or publish                                                                                                                                                         |
| `join-meeting.test.ts`                     | Explicit join from lastKnown or fetch; any ok provenance with events is joinable                                                                                                                                          |
| `disconnect-calendar.test.ts`              | Disconnect port path + related clear hooks, including Darwin diagnostic clearing                                                                                                                                          |
| `get-calendar-permission-status.test.ts`   | Abort and late-resolve cancellation only                                                                                                                                                                                  |
| `request-calendar-access.test.ts`          | Abort and late-resolve cancellation only                                                                                                                                                                                  |

Settings load/get/update have no suite here. Facade coverage is `tests/main/settings.test.ts`. The permission and request-access files in this folder only lock cancellation.

## RULES

- Inject fake ports; do not import Electron or real facades.
- Prefer pure arrangement/assert over module-level binds.
- New use cases get a suite here before wiring into facades/graph.
- Join cancels pending auto-open only after `opener.open` succeeds. An open failure leaves the browser timer armed.
