/**
 * Pure meeting URL builder with platform-specific identity parameters.
 * - Google Meet: appends `?authuser=email`
 * - Zoom: appends `?uname=email`
 * - Unknown platform: returns base URL as-is
 *
 * URL opening lives in main (`src/main/infrastructure/electron/shell-meeting-opener.ts`).
 */

import type { MeetingEvent } from "../entities/meeting-event.js";
import { isAllowedMeetUrl } from "./url-validation.js";
import { detectPlatform } from "./platform.js";

/**
 * Build the URL to open for a meeting, with platform-specific identity parameters.
 * Returns empty string if URL is not allowed or has no URL.
 */
export function buildMeetUrl(event: MeetingEvent): string {
  if (!event.meetUrl) return "";

  const base = event.meetUrl.startsWith("https://") ? event.meetUrl : `https://${event.meetUrl}`;

  // Validate URL is from an allowed domain
  if (!isAllowedMeetUrl(base)) return "";

  const email = event.userEmail?.trim();
  if (!email || !email.includes("@")) return base;

  const platform = detectPlatform(base);
  const identity = (() => {
    switch (platform) {
      case "google-meet":
        return { name: "authuser", value: email };
      case "zoom":
        return { name: "uname", value: email };
      default:
        return null;
    }
  })();

  if (!identity) return base;

  const parsed = new URL(base);
  parsed.searchParams.set(identity.name, identity.value);
  return parsed.toString();
}
