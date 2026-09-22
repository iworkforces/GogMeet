# Application Test Suite

## OVERVIEW

Vitest project `application`: Node, no Electron mocks. Covers `src/main/application/use-cases/**` with port fakes. Coverage floors: **80 / 80 / 80 / 70** (L/S/F/B).

## Suites

| Suite                         | Focus                                                                                                                                                                                                                     |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `get-meetings.test.ts`        | Maps live complete/partial/offline-cache → UI phases (`ready` / `limited` / `offline-cached`) + error; projects Darwin aggregate diagnostics for limited results and clears them for complete, offline, and error results |
| `join-meeting.test.ts`        | Explicit join from lastKnown or fetch; any ok provenance with events is joinable                                                                                                                                          |
| `disconnect-calendar.test.ts` | Disconnect port path + related clear hooks, including Darwin diagnostic clearing                                                                                                                                          |

(Other use cases — permission status, request access, load/get/update settings — are covered via facade/main suites when not unit-tested here.)

## RULES

- Inject fake ports; do not import Electron or real facades.
- Prefer pure arrangement/assert over module-level binds.
- New use cases get a suite here before wiring into facades/graph.
- Join cancels pending auto-open only after `opener.open` succeeds. An open failure leaves the browser timer armed.
- Permission, request-access, and settings load/get/update are locked from `tests/main` facade suites when this folder has no file for them.
