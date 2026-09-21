import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { parseEvents } from "../../src/main/swift/event-parser.js";
import { cleanDescription } from "../../src/domain/services/clean-description.js";
import {
  createCalendarFacade,
  type CalendarFacade,
} from "../../src/main/facades/calendar.js";
import { resetCalendarProvider } from "../../src/main/calendar/factory.js";
import { createDarwinEventKitProvider } from "../../src/main/calendar/providers/darwin-eventkit.js";

const { ensureBinaryMock, execFileAsyncMock, runSwiftHelperMock } = vi.hoisted(() => ({
  ensureBinaryMock: vi.fn().mockResolvedValue(undefined),
  execFileAsyncMock: vi.fn(),
  runSwiftHelperMock: vi.fn(),
}));
vi.mock("node:child_process", async () => {
  const { promisify } = await import("node:util");
  const fn = Object.assign(vi.fn(), {
    [promisify.custom]: execFileAsyncMock,
  });
  return { execFile: fn };
});
vi.mock("../../src/main/swift/binary-manager.js", () => ({
  runSwiftHelper: runSwiftHelperMock,
  ensureBinary: ensureBinaryMock,
}));
// Domain calendar uses the factory; force Darwin EventKit path in these tests.
vi.mock("../../src/main/platform/os.js", () => ({
  isDarwin: () => true,
  isWin32: () => false,
}));

function makeSwiftLine(
  id: string,
  title: string,
  start: string,
  end: string,
  url: string,
  calendar: string,
  allDay: string,
  email?: string,
  notes?: string,
): string {
  return JSON.stringify([id, title, start, end, url, calendar, allDay, email ?? "", notes ?? ""]);
}

// Helper to get ISO strings for relative times
function isoFromNow(minutesFromNow: number): string {
  return new Date(Date.now() + minutesFromNow * 60 * 1000).toISOString();
}

describe("parseEvents", () => {
  it("parses a valid JSON array record correctly", () => {
    const start = isoFromNow(60);
    const end = isoFromNow(90);
    const input = makeSwiftLine(
      "evt-1",
      "Team Standup",
      start,
      end,
      "https://meet.google.com/abc-def-ghi",
      "Work",
      "false",
      "user@example.com",
    );

    const { events, diagnostics } = parseEvents(input);
    expect(events).toHaveLength(1);
    expect(diagnostics).toEqual([]);
    expect(events[0]).toEqual({
      id: "evt-1",
      title: "Team Standup",
      startDate: start,
      endDate: end,
      meetUrl: "https://meet.google.com/abc-def-ghi",
      calendarName: "Work",
      isAllDay: false,
      userEmail: "user@example.com",
    });
  });

  it("omits an empty email field", () => {
    const start = isoFromNow(60);
    const end = isoFromNow(90);
    const input = makeSwiftLine(
      "evt-2",
      "Quick Sync",
      start,
      end,
      "https://meet.google.com/xyz",
      "Personal",
      "false",
    );

    const { events } = parseEvents(input);
    expect(events).toHaveLength(1);
    expect(events[0]?.userEmail).toBeUndefined();
  });

  it("records a malformed_field_count diagnostic for lines with wrong field count", () => {
    const input = JSON.stringify(["evt-1", "Title", "2024-01-01"]);
    const { events, diagnostics } = parseEvents(input);
    expect(events).toHaveLength(0);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.reason).toBe("malformed_field_count");
    expect(diagnostics[0]?.line).toBe(1);
  });

  it("filters out events before today midnight", () => {
    const pastDate = new Date();
    pastDate.setDate(pastDate.getDate() - 1); // Yesterday
    pastDate.setHours(10, 0, 0, 0);

    const input = makeSwiftLine(
      "evt-past",
      "Past Meeting",
      pastDate.toISOString(),
      new Date(pastDate.getTime() + 30 * 60 * 1000).toISOString(),
      "https://meet.google.com/past",
      "Work",
      "false",
    );

    const { events, diagnostics } = parseEvents(input);
    expect(events).toHaveLength(0);
    // Out-of-range filter is silent, not a diagnostic
    expect(diagnostics).toEqual([]);
  });

  it("filters out events beyond 2 days from today midnight", () => {
    const futureDate = new Date();
    futureDate.setDate(futureDate.getDate() + 3); // 3 days from now
    futureDate.setHours(10, 0, 0, 0);

    const input = makeSwiftLine(
      "evt-future",
      "Future Meeting",
      futureDate.toISOString(),
      new Date(futureDate.getTime() + 30 * 60 * 1000).toISOString(),
      "https://meet.google.com/future",
      "Work",
      "false",
    );

    const { events, diagnostics } = parseEvents(input);
    expect(events).toHaveLength(0);
    expect(diagnostics).toEqual([]);
  });

  it("deduplicates events by id", () => {
    const start = isoFromNow(60);
    const end = isoFromNow(90);
    const line = makeSwiftLine(
      "evt-dup",
      "Same Event",
      start,
      end,
      "https://meet.google.com/dup",
      "Work",
      "false",
    );
    const input = `${line}\n${line}`;

    const { events } = parseEvents(input);
    expect(events).toHaveLength(1);
  });

  it("sorts events by startDate ascending", () => {
    const start1 = isoFromNow(120);
    const end1 = isoFromNow(150);
    const start2 = isoFromNow(30);
    const end2 = isoFromNow(60);

    const input = [
      makeSwiftLine(
        "evt-late",
        "Later",
        start1,
        end1,
        "https://meet.google.com/late",
        "Work",
        "false",
      ),
      makeSwiftLine(
        "evt-early",
        "Earlier",
        start2,
        end2,
        "https://meet.google.com/early",
        "Work",
        "false",
      ),
    ].join("\n");

    const { events } = parseEvents(input);
    expect(events).toHaveLength(2);
    expect(events[0]?.id).toBe("evt-early");
    expect(events[1]?.id).toBe("evt-late");
  });

  it("handles all-day events", () => {
    const start = isoFromNow(60);
    const end = isoFromNow(90);
    const input = makeSwiftLine(
      "evt-allday",
      "All Day Event",
      start,
      end,
      "",
      "Personal",
      "true",
    );

    const { events } = parseEvents(input);
    expect(events).toHaveLength(1);
    expect(events[0]?.isAllDay).toBe(true);
  });

  it("handles optional meetUrl (empty string becomes undefined)", () => {
    const start = isoFromNow(60);
    const end = isoFromNow(90);
    const input = makeSwiftLine(
      "evt-nourl",
      "No URL Event",
      start,
      end,
      "",
      "Work",
      "false",
    );

    const { events } = parseEvents(input);
    expect(events).toHaveLength(1);
    expect(events[0]?.meetUrl).toBeUndefined();
  });

  it("handles optional userEmail (empty/whitespace excluded)", () => {
    const start = isoFromNow(60);
    const end = isoFromNow(90);
    const input = makeSwiftLine(
      "evt-noemail",
      "No Email",
      start,
      end,
      "https://meet.google.com/x",
      "Work",
      "false",
      "   ",
    );

    const { events } = parseEvents(input);
    expect(events).toHaveLength(1);
    expect(events[0]?.userEmail).toBeUndefined();
  });

  it("returns empty result for empty input", () => {
    expect(parseEvents("")).toEqual({ events: [], diagnostics: [] });
  });

  it("records a diagnostic for whitespace-only single-line input", () => {
    const { events, diagnostics } = parseEvents("   ");
    expect(events).toEqual([]);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.reason).toBe("malformed_record");
  });

  it("records an invalid_iso diagnostic for malformed dates", () => {
    const input = makeSwiftLine(
      "evt-bad",
      "Bad Date",
      "not-a-date",
      "also-bad",
      "https://meet.google.com/bad",
      "Work",
      "false",
    );

    const { events, diagnostics } = parseEvents(input);
    expect(events).toHaveLength(0);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.reason).toBe("invalid_iso");
    expect(diagnostics[0]?.line).toBe(1);
  });

  it("collects diagnostics for mixed valid/invalid input with correct line numbers", () => {
    const start = isoFromNow(60);
    const end = isoFromNow(90);
    const validLine = makeSwiftLine(
      "evt-ok",
      "OK",
      start,
      end,
      "https://meet.google.com/ok",
      "Work",
      "false",
    );
    const malformed = JSON.stringify(["too", "few", "fields"]);
    const badIso = makeSwiftLine(
      "evt-badiso",
      "Bad ISO",
      "not-a-date",
      "also-bad",
      "https://meet.google.com/badiso",
      "Work",
      "false",
    );
    const input = [validLine, malformed, badIso].join("\n");

    const { events, diagnostics } = parseEvents(input);
    expect(events).toHaveLength(1);
    expect(events[0]?.id).toBe("evt-ok");
    expect(diagnostics).toHaveLength(2);
    expect(diagnostics[0]).toMatchObject({
      line: 2,
      reason: "malformed_field_count",
    });
    expect(diagnostics[1]).toMatchObject({
      line: 3,
      reason: "invalid_iso",
    });
  });

  it("trims whitespace from fields", () => {
    const start = isoFromNow(60);
    const end = isoFromNow(90);
    const input = makeSwiftLine(
      "  evt-trim  ",
      "  Trimmed Title  ",
      start,
      end,
      "  https://meet.google.com/trim  ",
      "  Work  ",
      "  false  ",
      "  user@example.com  ",
    );

    const { events } = parseEvents(input);
    expect(events).toHaveLength(1);
    expect(events[0]?.id).toBe("evt-trim");
    expect(events[0]?.title).toBe("Trimmed Title");
    expect(events[0]?.meetUrl).toBe("https://meet.google.com/trim");
    expect(events[0]?.calendarName).toBe("Work");
    expect(events[0]?.userEmail).toBe("user@example.com");
  });

  it("handles multiple valid events", () => {
    const start1 = isoFromNow(30);
    const end1 = isoFromNow(60);
    const start2 = isoFromNow(120);
    const end2 = isoFromNow(150);
    const start3 = isoFromNow(240);
    const end3 = isoFromNow(270);

    const input = [
      makeSwiftLine(
        "evt-1",
        "Meeting 1",
        start1,
        end1,
        "https://meet.google.com/1",
        "Work",
        "false",
      ),
      makeSwiftLine(
        "evt-2",
        "Meeting 2",
        start2,
        end2,
        "https://meet.google.com/2",
        "Personal",
        "false",
      ),
      makeSwiftLine(
        "evt-3",
        "Meeting 3",
        start3,
        end3,
        "https://meet.google.com/3",
        "Work",
        "false",
      ),
    ].join("\n");

    const { events } = parseEvents(input);
    expect(events).toHaveLength(3);
    expect(events[0]?.title).toBe("Meeting 1");
    expect(events[1]?.title).toBe("Meeting 2");
    expect(events[2]?.title).toBe("Meeting 3");
  });

  it("handles Windows-style line endings (CRLF)", () => {
    const start = isoFromNow(60);
    const end = isoFromNow(90);
    const input = makeSwiftLine(
      "evt-crlf",
      "CRLF Event",
      start,
      end,
      "https://meet.google.com/crlf",
      "Work",
      "false",
    );
    const inputWithCrLf = `${input}\r\n`;

    const { events } = parseEvents(inputWithCrLf);
    expect(events).toHaveLength(1);
  });

  it("skips empty lines in input", () => {
    const start = isoFromNow(60);
    const end = isoFromNow(90);
    const input = [
      "",
      makeSwiftLine(
        "evt-1",
        "Meeting 1",
        start,
        end,
        "https://meet.google.com/1",
        "Work",
        "false",
      ),
      "   ",
      makeSwiftLine(
        "evt-2",
        "Meeting 2",
        start,
        end,
        "https://meet.google.com/2",
        "Work",
        "false",
      ),
      "",
    ].join("\n");

    const { events, diagnostics } = parseEvents(input);
    expect(events).toHaveLength(2);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.reason).toBe("malformed_record");
  });

  it("parses 9-field input with description", () => {
    const start = isoFromNow(60);
    const end = isoFromNow(90);
    const input = makeSwiftLine(
      "evt-desc",
      "Meeting with Notes",
      start,
      end,
      "https://meet.google.com/desc",
      "Work",
      "false",
      "user@example.com",
      "This is a meeting note",
    );

    const { events } = parseEvents(input);
    expect(events).toHaveLength(1);
    expect(events[0]?.description).toBe("This is a meeting note");
  });

  it("excludes empty or whitespace-only description", () => {
    const start = isoFromNow(60);
    const end = isoFromNow(90);
    const input = makeSwiftLine(
      "evt-nodesc",
      "Meeting No Desc",
      start,
      end,
      "https://meet.google.com/nodesc",
      "Work",
      "false",
      "user@example.com",
      "   ",
    );

    const { events } = parseEvents(input);
    expect(events).toHaveLength(1);
    expect(events[0]?.description).toBeUndefined();
  });
});

describe("getCalendarEventsResult diagnostics", () => {
  let calendarFacade: CalendarFacade;

  beforeEach(() => {
    calendarFacade = createCalendarFacade();
    ensureBinaryMock.mockClear();
    runSwiftHelperMock.mockReset();
    resetCalendarProvider();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetCalendarProvider();
  });

  it("returns a live partial with one count-only aggregate warning for mixed EventKit output", async () => {
    const sentinels = {
      title: "SENTINEL_TITLE",
      email: "SENTINEL_EMAIL",
      url: "SENTINEL_URL",
      notes: "SENTINEL_NOTE",
    };
    const start = isoFromNow(60);
    const end = isoFromNow(90);
    const validLine = makeSwiftLine(
      "evt-valid",
      "Valid Event",
      start,
      end,
      "https://meet.google.com/valid-event",
      "Work",
      "false",
    );
    const malformedOutput = [
      validLine,
      `not-json ${sentinels.title} ${sentinels.email} ${sentinels.url} ${sentinels.notes}`,
      JSON.stringify([sentinels.title, sentinels.email, sentinels.url]),
      makeSwiftLine(
        "evt-invalid-iso",
        sentinels.title,
        "not-a-date",
        "also-not-a-date",
        sentinels.url,
        "Work",
        "false",
        sentinels.email,
        sentinels.notes,
      ),
      makeSwiftLine(
        "   ",
        sentinels.title,
        start,
        end,
        sentinels.url,
        "Work",
        "false",
        sentinels.email,
        sentinels.notes,
      ),
      makeSwiftLine(
        "evt-valid",
        sentinels.title,
        start,
        end,
        sentinels.url,
        "Work",
        "false",
        sentinels.email,
        sentinels.notes,
      ),
    ].join("\n");
    runSwiftHelperMock.mockResolvedValueOnce(malformedOutput);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const result = await createDarwinEventKitProvider().getEvents(new AbortController().signal);

    const aggregate = {
      total: 5,
      malformedRecord: 1,
      malformedFieldCount: 1,
      invalidIso: 1,
      invalidId: 1,
      duplicateUid: 1,
    };
    expect(result).toMatchObject({
      kind: "ok",
      source: "live",
      completeness: "partial",
      events: [
        {
          id: "evt-valid",
          title: "Valid Event",
          startDate: start,
          endDate: end,
        },
      ],
      darwinPartialRefreshDiagnostics: aggregate,
    });
    expect(warn.mock.calls).toEqual([[aggregate]]);
    expect(JSON.stringify(warn.mock.calls)).not.toContain(sentinels.title);
    expect(JSON.stringify(warn.mock.calls)).not.toContain(sentinels.email);
    expect(JSON.stringify(warn.mock.calls)).not.toContain(sentinels.url);
    expect(JSON.stringify(warn.mock.calls)).not.toContain(sentinels.notes);
    expect(runSwiftHelperMock).toHaveBeenCalledTimes(1);
    expect(ensureBinaryMock).not.toHaveBeenCalled();
  });

  it("returns a complete EventKit result without an aggregate warning for clean output", async () => {
    const start = isoFromNow(60);
    const end = isoFromNow(90);
    runSwiftHelperMock.mockResolvedValueOnce(
      makeSwiftLine(
        "evt-clean",
        "Clean Event",
        start,
        end,
        "https://meet.google.com/clean-event",
        "Work",
        "false",
      ),
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const result = await createDarwinEventKitProvider().getEvents(new AbortController().signal);

    expect(result).toMatchObject({
      kind: "ok",
      source: "live",
      completeness: "complete",
      events: [{ id: "evt-clean", title: "Clean Event", startDate: start, endDate: end }],
    });
    expect("darwinPartialRefreshDiagnostics" in result).toBe(false);
    expect(warn).not.toHaveBeenCalled();
    expect(runSwiftHelperMock).toHaveBeenCalledTimes(1);
    expect(ensureBinaryMock).not.toHaveBeenCalled();
  });

  it("clears a Darwin partial summary when a poll-level error retains its events", async () => {
    const start = isoFromNow(60);
    const end = isoFromNow(90);
    const validLine = makeSwiftLine(
      "evt-poll-error",
      "Valid Event",
      start,
      end,
      "https://meet.google.com/poll-error",
      "Work",
      "false",
    );
    runSwiftHelperMock.mockResolvedValueOnce(`${validLine}\nnot-json`);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const result = await calendarFacade.getCalendarEventsResult();
    if (result.kind !== "ok") throw new Error("expected partial calendar result");
    expect(calendarFacade.getCalendarUiState().darwinPartialRefreshDiagnostics).toMatchObject({
      total: 1,
    });

    calendarFacade.reportCalendarPollError("network unavailable", result.events);

    expect(calendarFacade.getCalendarUiState()).toMatchObject({
      phase: "offline-cached",
      darwinPartialRefreshDiagnostics: null,
    });
    warn.mockRestore();
  });
});

describe("cleanDescription", () => {
  it("strips Outlook text-border artifacts (-::~:~::~:...)"
    , () => {
    const input =
      "-::~:~::~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~::~:~::-";
    expect(cleanDescription(input)).toBe("");
  });

  it("strips long underscore separator lines", () => {
    const input = "Hello\n________________________________\nWorld";
    expect(cleanDescription(input)).toBe("Hello\nWorld");
  });

  it("strips long dash separator lines", () => {
    const input = "Agenda\n--------------------------------\n1. Item";
    expect(cleanDescription(input)).toBe("Agenda\n1. Item");
  });

  it("strips Outlook bordered separators (* ___ *)", () => {
    const input = "Notes\n* _______________________________ *\nMore notes";
    expect(cleanDescription(input)).toBe("Notes\nMore notes");
  });

  it("returns empty string when description is only artifacts", () => {
    const input =
      "-::~:~::~:~:~:~:~::~:~::-\n________________________________\n-::~:~::~:~::-";
    expect(cleanDescription(input)).toBe("");
  });

  it("preserves real content mixed with artifacts", () => {
    const input =
      "-::~:~::~:~::~:~::-\nPlease join the meeting\n-::~:~::~:~::~:~::-\nAgenda:\n1. Review Q4 results\n________________________________";
    expect(cleanDescription(input)).toBe(
      "Please join the meeting\nAgenda:\n1. Review Q4 results", 
);
  });

  it("preserves normal descriptions unchanged", () => {
    const input = "Quarterly review meeting.\nPlease prepare your updates.";
    expect(cleanDescription(input)).toBe(input);
  });

  it("does not strip short dashes or meaningful content", () => {
    const input = "Key points:\n- Item 1\n- Item 2";
    expect(cleanDescription(input)).toBe(input);
  });

  it("strips HTML anchor tags from CalDAV-synced descriptions", () => {
    const input = "Join meeting: <a href=\"https://meet.google.com/xxx\">https://meet.google.com/xxx</a>";
    expect(cleanDescription(input)).toBe("Join meeting: https://meet.google.com/xxx");
  });

  it("strips nested HTML tags, keeps inner text", () => {
    const input = "<div><b>Agenda:</b> <a href=\"https://example.com\">Details</a></div>";
    expect(cleanDescription(input)).toBe("Agenda: Details");
  });

  it("strips <br> and self-closing tags", () => {
    const input = "Line one<br>Line two<br/>Line three";
    expect(cleanDescription(input)).toBe("Line oneLine twoLine three");
  });

  it("strips HTML tags mixed with Outlook artifacts", () => {
    const input = "-::~:~::~:~::~:~::-\n<a href=\"https://meet.google.com/abc\">Join</a>\n________________________________";
    expect(cleanDescription(input)).toBe("Join");
  });
});

describe("requestCalendarPermission", () => {
  let calendarFacade: CalendarFacade;

  beforeEach(() => {
    calendarFacade = createCalendarFacade();
    execFileAsyncMock.mockReset();
    resetCalendarProvider();
  });

  it('returns "granted" when AppleScript succeeds', async () => {
    execFileAsyncMock.mockResolvedValueOnce({ stdout: "Calendar1\nCalendar2", stderr: "" });

    const result = await calendarFacade.requestCalendarPermission();
    expect(result).toBe("granted");
  });

  it('returns "denied" when AppleScript throws', async () => {
    execFileAsyncMock.mockRejectedValueOnce(new Error("execution error"));

    const result = await calendarFacade.requestCalendarPermission();
    expect(result).toBe("denied");
  });
});

describe("getCalendarPermissionStatus", () => {
  let calendarFacade: CalendarFacade;

  beforeEach(() => {
    calendarFacade = createCalendarFacade();
    execFileAsyncMock.mockReset();
    resetCalendarProvider();
  });

  it('returns "granted" when AppleScript succeeds', async () => {
    execFileAsyncMock.mockResolvedValueOnce({ stdout: "Work", stderr: "" });

    const result = await calendarFacade.getCalendarPermissionStatus();
    expect(result).toBe("granted");
  });

  it('returns "denied" when error contains "not authorized"', async () => {
    execFileAsyncMock.mockRejectedValueOnce(new Error("not authorized to access Calendar"));

    const result = await calendarFacade.getCalendarPermissionStatus();
    expect(result).toBe("denied");
  });

  it('returns "denied" when error contains "1743"', async () => {
    execFileAsyncMock.mockRejectedValueOnce(new Error("error 1743: permission denied"));

    const result = await calendarFacade.getCalendarPermissionStatus();
    expect(result).toBe("denied");
  });

  it('returns "not-determined" when error contains "2700"', async () => {
    execFileAsyncMock.mockRejectedValueOnce(new Error("error 2700: application not running"));

    const result = await calendarFacade.getCalendarPermissionStatus();
    expect(result).toBe("not-determined");
  });

  it('returns "not-determined" when error contains "not determined"', async () => {
    execFileAsyncMock.mockRejectedValueOnce(new Error("access not determined"));

    const result = await calendarFacade.getCalendarPermissionStatus();
    expect(result).toBe("not-determined");
  });

  it('returns "not-determined" for unknown errors (fallback)', async () => {
    execFileAsyncMock.mockRejectedValueOnce(new Error("something completely unexpected"));

    const result = await calendarFacade.getCalendarPermissionStatus();
    expect(result).toBe("not-determined");
  });
});
