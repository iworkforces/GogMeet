/**
 * Packaged alert lifecycle probe — production showAlert / destroy paths.
 * Synthetic events only; no payload content in traces.
 */

import { asEventId, asIsoUtc } from "../../../domain/entities/brand.js";
import type { MeetingEvent } from "../../../domain/entities/meeting-event.js";
import { showAlert, destroyAlertWindow } from "../../windows/alert-window.js";
import { flushPerfTraceToUserData } from "../../utils/performance-trace-file.js";
import { isPerfTraceEnabled, perfTrace } from "../../utils/performance-trace.js";

const onSyntheticAlertDismiss = (): void => undefined;
const canShowSyntheticAlert = (): boolean => true;

function syntheticMeeting(seed: number): MeetingEvent {
  const now = Date.now();
  const start = new Date(now + 60_000).toISOString();
  const end = new Date(now + 120_000).toISOString();
  const id = asEventId(`syn-alert-${seed}`);
  const s = asIsoUtc(start);
  const e = asIsoUtc(end);
  if (!id.ok || !s.ok || !e.ok) {
    throw new Error("synthetic meeting brand failed");
  }
  // Long / CJK synthetic titles for layout stress (not logged to traces).
  const title =
    seed % 3 === 0 ? `会議 ${seed} ` + "漢".repeat(40) : `syn-alert-${seed}-` + "x".repeat(80);
  return {
    id: id.value,
    title,
    startDate: s.value,
    endDate: e.value,
    calendarName: "probe",
    isAllDay: false,
  };
}

async function settle(): Promise<void> {
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
}

/**
 * 100 functional hide/reuse cycles + 30 measured; then destroy-between baseline.
 */
export async function runAlertProbe(userDataPath: string): Promise<void> {
  const functional = 100;
  const measured = 30;

  // Hide/reuse sequence
  for (let i = 0; i < functional; i++) {
    const t0 = performance.now();
    showAlert(syntheticMeeting(i), onSyntheticAlertDismiss, undefined, canShowSyntheticAlert);
    await settle();
    // User-dismiss path via force hide: destroy only for baseline sequence.
    // Functional path uses generation-safe hide via destroy only at end of block.
    if (isPerfTraceEnabled() && i >= functional - measured) {
      perfTrace({
        operation: "alert-lifecycle",
        outcome: "ok",
        startMs: t0,
        durationMs: Math.max(0, performance.now() - t0),
        count: 1, // hide-reuse sequence
      });
    }
  }
  destroyAlertWindow();
  await settle();

  // Destroy-between-cycles baseline (measurement only — not a product path)
  for (let i = 0; i < measured; i++) {
    const t0 = performance.now();
    showAlert(
      syntheticMeeting(1000 + i),
      onSyntheticAlertDismiss,
      undefined,
      canShowSyntheticAlert,
    );
    await settle();
    destroyAlertWindow();
    await settle();
    perfTrace({
      operation: "alert-lifecycle",
      outcome: "ok",
      startMs: t0,
      durationMs: Math.max(0, performance.now() - t0),
      count: 2, // destroy-between sequence marker
    });
  }

  flushPerfTraceToUserData(userDataPath);
}
