#!/usr/bin/env node
/**
 * Permanent guardrail static scan.
 * Exit 0 when clean; exit 1 with findings on stdout/stderr.
 *
 * Usage: bun run guardrails
 *        node scripts/guardrails-scan.mjs [--self-test]
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const ROOT = process.cwd();
const SRC = join(ROOT, "src");

/** Files allowed to call shell.openExternal (see docs/security/permanent-guardrails.md). */
const OPEN_EXTERNAL_ALLOW = new Set([
  "src/main/infrastructure/electron/shell-meeting-opener.ts",
  "src/main/calendar/auth/google-oauth.ts",
  "src/main/utils/system-settings.ts",
  "src/main/system/notification.ts",
  "src/main/system/auto-updater.ts",
  "src/main/windows/about-window.ts",
]);

const findings = [];

function rel(p) {
  return relative(ROOT, p).split(sep).join("/");
}

function walk(dir, acc = []) {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist" || name === "lib" || name === "coverage") {
      continue;
    }
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, acc);
    else if (/\.(ts|tsx|js|mjs|cjs)$/.test(name) && !name.endsWith(".d.ts")) acc.push(p);
  }
  return acc;
}

function scanFile(filePath, patterns) {
  const text = readFileSync(filePath, "utf8");
  const lines = text.split(/\r?\n/);
  const pathRel = rel(filePath);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Skip pure comment lines for maxBuffer doc references
    const trimmed = line.trim();
    if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) {
      // still scan for security-critical prefs even in comments? no — code only for most rules
    }
    for (const rule of patterns) {
      if (rule.skipComments && (trimmed.startsWith("//") || trimmed.startsWith("*"))) continue;
      if (rule.fileFilter && !rule.fileFilter(pathRel)) continue;
      if (rule.excludeFile && rule.excludeFile(pathRel)) continue;
      if (rule.pattern.test(line)) {
        if (rule.allowLine && rule.allowLine(line, pathRel)) continue;
        findings.push({
          rule: rule.id,
          file: pathRel,
          line: i + 1,
          text: line.trim().slice(0, 160),
          message: rule.message,
        });
      }
    }
  }
}

const rules = [
  {
    // Push/watch channels remain forbidden; syncToken is allowed only in Google calendar sync modules.
    id: "G1-calendar-watch-api",
    pattern: /calendar\.events\.watch|googleapis\.com\/calendar\/v3\/.*\/watch/,
    skipComments: true,
    message: "Google calendar push/watch is not implemented — requires dedicated design",
    fileFilter: (f) => f.startsWith("src/"),
  },
  {
    id: "G1-syncToken-scope",
    pattern: /\bsyncToken\b|nextSyncToken\b/,
    skipComments: true,
    message: "syncToken persistence/use is limited to google calendar + google-sync-tokens modules",
    fileFilter: (f) => f.startsWith("src/"),
    allowLine: (_line, pathRel) =>
      pathRel.includes("google-calendar.ts") ||
      pathRel.includes("google-sync-tokens.ts") ||
      pathRel.includes("google-shadow.mjs"),
  },
  {
    id: "G2-maxBuffer",
    pattern: /\bmaxBuffer\b\s*:/,
    skipComments: true,
    message: "Do not use execFile maxBuffer; use bounded swift-helper-process",
    fileFilter: (f) => f.startsWith("src/"),
  },
  {
    id: "O3-nodeIntegration-true",
    pattern: /nodeIntegration\s*:\s*true/,
    skipComments: false,
    message: "nodeIntegration must remain false",
    fileFilter: (f) => f.startsWith("src/"),
  },
  {
    id: "O3-contextIsolation-false",
    pattern: /contextIsolation\s*:\s*false/,
    skipComments: false,
    message: "contextIsolation must remain true",
    fileFilter: (f) => f.startsWith("src/"),
  },
  {
    id: "O3-sandbox-false",
    pattern: /sandbox\s*:\s*false/,
    skipComments: false,
    message: "sandbox must remain true for BrowserWindows",
    fileFilter: (f) => f.startsWith("src/"),
  },
  {
    id: "G6-force-poll-channel",
    pattern: /SCHEDULER_FORCE_POLL|scheduler:force-poll/,
    skipComments: true,
    message: "SCHEDULER_FORCE_POLL was deleted — use coordinated CALENDAR_GET_EVENTS",
    // Product source only; tests may mention the string to assert absence.
    fileFilter: (f) => f.startsWith("src/"),
  },
  {
    id: "G6-events-updated-channel",
    pattern: /CALENDAR_EVENTS_UPDATED|calendar:events-updated/,
    skipComments: true,
    message: "CALENDAR_EVENTS_UPDATED was replaced by CALENDAR_RESULT_UPDATED",
    fileFilter: (f) => f.startsWith("src/"),
  },
  {
    id: "G7-raw-ipcMain-handle",
    pattern: /ipcMain\.handle\s*\(/,
    skipComments: true,
    message: "Use typedHandle from ipc-handlers/shared — not raw ipcMain.handle",
    fileFilter: (f) => f.startsWith("src/main/"),
    excludeFile: (f) => f.includes("ipc-handlers/shared.ts"),
  },
  {
    id: "G7-openExternal-allowlist",
    pattern: /shell\.openExternal\s*\(/,
    skipComments: true,
    message: "shell.openExternal only in allowlisted files (see permanent-guardrails.md)",
    fileFilter: (f) => f.startsWith("src/main/"),
    allowLine: (_line, pathRel) => OPEN_EXTERNAL_ALLOW.has(pathRel),
  },
  {
    id: "G9-perf-trace-default",
    pattern: /GOGMEET_PERF_TRACE\s*=\s*["']1["']/,
    skipComments: true,
    message: "Do not hardcode GOGMEET_PERF_TRACE=1 in product source",
    fileFilter: (f) => f.startsWith("src/"),
  },
  {
    id: "G14-app-graph-global-seams",
    pattern:
      /\b(?:skipBind|bindComposition|bindMeetingOpener|rebindMeetingOpenerDefaults|bindJoinMeeting|rebindJoinMeetingDefaults)\b/,
    skipComments: true,
    message: "Removed AppGraph global composition/rebinding seam must not return",
    fileFilter: (f) => f.startsWith("src/"),
  },
];

function runScan() {
  findings.length = 0;
  const files = walk(SRC);
  for (const f of files) {
    scanFile(f, rules);
  }
  return findings;
}

function printFindings(list) {
  for (const f of list) {
    console.error(`[guardrails:${f.rule}] ${f.file}:${f.line}: ${f.message}`);
    console.error(`  ${f.text}`);
  }
}

function selfTest() {
  // Synthetic lines that should match patterns (unit-level)
  const samples = [
    { id: "G1-syncToken-scope", line: "const t = syncToken;" },
    { id: "O3-nodeIntegration-true", line: "nodeIntegration: true," },
    { id: "G6-force-poll-channel", line: 'SCHEDULER_FORCE_POLL: "scheduler:force-poll"' },
    { id: "G14-app-graph-global-seams", line: "skipBind" },
    { id: "G14-app-graph-global-seams", line: "bindComposition" },
    { id: "G14-app-graph-global-seams", line: "bindMeetingOpener" },
    { id: "G14-app-graph-global-seams", line: "rebindMeetingOpenerDefaults" },
    { id: "G14-app-graph-global-seams", line: "bindJoinMeeting" },
    { id: "G14-app-graph-global-seams", line: "rebindJoinMeetingDefaults" },
  ];
  const negativeSamples = ["skipBinding", "bindWindowsThemeBackground"];
  let ok = true;
  for (const s of samples) {
    const rule = rules.find((r) => r.id === s.id);
    if (!rule || !rule.pattern.test(s.line)) {
      console.error(`[guardrails:self-test] rule ${s.id} failed to match sample`);
      ok = false;
    }
  }
  const appGraphSeamRule = rules.find((r) => r.id === "G14-app-graph-global-seams");
  if (appGraphSeamRule) {
    for (const line of negativeSamples) {
      if (appGraphSeamRule.pattern.test(line)) {
        console.error(`[guardrails:self-test] rule ${appGraphSeamRule.id} matched negative sample`);
        ok = false;
      }
    }
  }
  // Allowlist must include shell-meeting-opener
  if (!OPEN_EXTERNAL_ALLOW.has("src/main/infrastructure/electron/shell-meeting-opener.ts")) {
    console.error("[guardrails:self-test] openExternal allowlist missing shell-meeting-opener");
    ok = false;
  }
  if (!ok) process.exit(1);
  console.log("[guardrails:self-test] ok");
}

const args = process.argv.slice(2);
if (args.includes("--self-test")) {
  selfTest();
  process.exit(0);
}

const list = runScan();
if (list.length > 0) {
  printFindings(list);
  console.error(
    `\n[guardrails] ${list.length} finding(s). See docs/security/permanent-guardrails.md`,
  );
  process.exit(1);
}
console.log("[guardrails] clean");
process.exit(0);
