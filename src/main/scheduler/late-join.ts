import type { MeetingEvent } from "../../domain/entities/meeting-event.js";
import type { EventId } from "../../domain/entities/brand.js";

/** Minimal state surface for late-join eligibility (avoids coupling to full SchedulerState). */
export interface LateJoinStateView {
  readonly firedEvents: ReadonlyMap<EventId, number>;
}

/**
 * Whether an in-progress meeting may still auto-open within the grace window.
 * Uses `firedEvents` only for suppression — never title-countdown `cancelledEvents`.
 */
export function isLateJoinEligible(
  event: MeetingEvent,
  startMs: number,
  endMs: number,
  now: number,
  graceMs: number,
  s: LateJoinStateView,
): boolean {
  if (event.isAllDay || !event.meetUrl) return false;
  if (s.firedEvents.has(event.id)) return false;
  if (endMs <= now) return false;
  if (graceMs <= 0) return false;
  return startMs <= now && now < startMs + graceMs;
}
