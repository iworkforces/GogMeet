# Domain Test Suite

## OVERVIEW

Vitest project `domain`: Node, no Electron, high coverage floors on `src/domain/**`.

## FILES (representative)

| Suite                                                                          | Covers                                                                                                                       |
| ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| `brand.test.ts`                                                                | EventId / MeetUrl / IsoUtc / WindowHeight validators                                                                         |
| `calendar-result.test.ts`                                                      | exhaustive provenance, helpers, timestamps, automation eligibility, and the fixed six-count Darwin partial-refresh aggregate |
| `url-validation.test.ts` / `meet-url.test.ts`                                  | allowlist (Meet/Zoom/Teams/Webex/Calendly) + buildMeetUrl                                                                    |
| `url-extract.test.ts` / `url-extract-google-map.test.ts`                       | free-text priority + HTML href + bare hosts                                                                                  |
| `clean-description.test.ts`                                                    | notes cleaner                                                                                                                |
| `pick-join-target.test.ts`                                                     | next joinable meeting                                                                                                        |
| `event-signature.test.ts`                                                      | stable signatures                                                                                                            |
| `meeting-time.test.ts`                                                         | in-progress / not-ended / upcoming / **completed-today** / display horizon                                                   |
| `truncate-middle.test.ts`                                                      | code-point middle-truncate; `MEETING_TITLE_DISPLAY_MAX_CHARS` (**25**)                                                       |
| `parse-json.test.ts`                                                           | parseJsonObject / AppResult                                                                                                  |
| `settings-defaults.test.ts` / `settings-parse.test.ts` / `quiet-hours.test.ts` | schema **v3** defaults + parse/migrate + quiet hours                                                                         |
| `time-utils.test.ts`                                                           | day boundaries / remaining time                                                                                              |

## RULES

- Import from `src/domain/**` only (plus test helpers). Do not import `electron` or `src/main`.
- Assert on `Result` discriminants (`ok` / `kind`), not thrown strings.
- Use `asTest*` helpers for known-good brands; call production validators for failure paths.
- Suffix hosts (`.zoom.us`, `.webex.com`) belong to allowlist tests. `MEETING_URL_ALLOWLIST` is exact-host prefixes only.
- Quiet-hours and settings migration stay here. IPC restart behavior stays in `tests/main`.
