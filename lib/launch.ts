/**
 * "Do people open the app after installing it?" -- counted without knowing who.
 *
 * When the app is opened FROM THE HOME SCREEN (standalone mode), it records one
 * anonymous `opened` event per device per day. The event carries only how long
 * ago this phone installed the app, in coarse buckets:
 *
 *   d0        installed today
 *   d1_7      1-7 days ago
 *   d8_30     8-30 days ago
 *   d31_plus  more than 30 days ago
 *
 * The install date never leaves the phone: it is kept in this browser's own
 * storage (localStorage), and only the bucket is sent. No identifier, no
 * location, nothing that ties two days' events to the same person. Summed
 * over a week, the buckets answer "are people who installed weeks ago still
 * opening it?".
 *
 * INSTALL DATE, WHEN WE HAVE IT. It is stamped when the install event fires
 * (lib/analytics.ts, trackInstalled). Phones that installed before Nov 2026,
 * or on iPhone (Safari reports no install event), have no stamp; for those the
 * date of the first home-screen open we see is used instead, and the bucket is
 * prefixed "seen_" (e.g. seen_d8_30) -- an UNDER-estimate of how long they have
 * had the app, kept separate so it does not blur the exact buckets.
 *
 * Every storage access is wrapped: storage can be blocked or cleared, and a
 * missing count must never break the app.
 */

import { toIstDate, daysBetweenIst } from "@/lib/api/time";

const INSTALLED_AT_KEY = "aqi.launch.installedAt";   // IST date, exact
const FIRST_SEEN_KEY = "aqi.launch.firstSeen";       // IST date, fallback
const LAST_REPORTED_KEY = "aqi.launch.lastReported"; // IST date of last report

/** Every key this module stores; Settings → Reset everything clears them. */
export const LAUNCH_KEYS = [INSTALLED_AT_KEY, FIRST_SEEN_KEY, LAST_REPORTED_KEY];

export type LaunchBucket = "d0" | "d1_7" | "d8_30" | "d31_plus";

/** Which bucket `days` since install falls in. */
export function bucketFor(days: number): LaunchBucket {
  if (days <= 0) return "d0";
  if (days <= 7) return "d1_7";
  if (days <= 30) return "d8_30";
  return "d31_plus";
}

function read(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* storage blocked: the count is lost, nothing else */
  }
}

/** Remember today's date as the install date. Called when an install happens. */
export function stampInstallDate(now: Date = new Date()): void {
  if (!read(INSTALLED_AT_KEY)) write(INSTALLED_AT_KEY, toIstDate(now));
}

/**
 * The detail to report for a home-screen launch today, or null if this
 * device has already reported today. Marks today as reported.
 */
export function launchDetailForToday(now: Date = new Date()): string | null {
  const today = toIstDate(now);
  if (read(LAST_REPORTED_KEY) === today) return null;

  let since = read(INSTALLED_AT_KEY);
  let prefix = "";
  if (!since) {
    since = read(FIRST_SEEN_KEY);
    if (!since) {
      since = today;
      write(FIRST_SEEN_KEY, today);
    }
    prefix = "seen_";
  }
  write(LAST_REPORTED_KEY, today);
  return prefix + bucketFor(daysBetweenIst(since, today));
}
