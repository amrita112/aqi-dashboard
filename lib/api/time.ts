/**
 * The time base, on the TypeScript side.
 *
 * The pipeline has two clocks and they must not be confused (the same rule is
 * written out in scripts/ingest/lib/config.py and in migration 15):
 *
 *   INSTANTS are stored UTC — `readings.recorded_at`, `min_ts`, `max_ts`.
 *     An instant converts losslessly whenever it is read.
 *
 *   CALENDAR LABELS are IST — `readings_daily.date`, `forecast_daily.target_date`,
 *     `diurnal_shape.hour`. These cannot be converted after the fact.
 *
 * Everything the API returns is presented in IST, because this is an
 * India-only product and the user's calendar is India's. Crucially that means
 * NOT using `toLocaleString()` without a timezone: that renders in the
 * viewer's browser timezone, so someone in London checking on family in Delhi
 * would see Delhi's air labelled in London time. With no geolocation in the
 * product, viewers abroad are an expected case, not an edge one.
 */

export const IST_OFFSET_MINUTES = 5 * 60 + 30;
export const IST_TIME_ZONE = "Asia/Kolkata";

/** The IST calendar day a UTC instant belongs to, as `YYYY-MM-DD`. */
export function toIstDate(instant: Date | string): string {
  const d = typeof instant === "string" ? new Date(instant) : instant;
  // Shift by the offset, then read the UTC parts. India has no daylight
  // saving, so a fixed offset is exact — no zone database needed.
  const shifted = new Date(d.getTime() + IST_OFFSET_MINUTES * 60_000);
  return shifted.toISOString().slice(0, 10);
}

/** The IST hour (0–23) a UTC instant falls in. */
export function toIstHour(instant: Date | string): number {
  const d = typeof instant === "string" ? new Date(instant) : instant;
  return new Date(d.getTime() + IST_OFFSET_MINUTES * 60_000).getUTCHours();
}

/** `2026-09-15T21:30` in IST — for display, never for storage. */
export function toIstLocalString(instant: Date | string): string {
  const d = typeof instant === "string" ? new Date(instant) : instant;
  return new Date(d.getTime() + IST_OFFSET_MINUTES * 60_000)
    .toISOString()
    .slice(0, 16);
}

/** `9:30 pm` — what a person reads on a screen. */
export function toIstClock(instant: Date | string): string {
  const h = toIstHour(instant);
  const d = typeof instant === "string" ? new Date(instant) : instant;
  const m = new Date(d.getTime() + IST_OFFSET_MINUTES * 60_000).getUTCMinutes();
  const suffix = h < 12 ? "am" : "pm";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m).padStart(2, "0")} ${suffix}`;
}

/** Today's date in India, regardless of where the server runs. */
export function istToday(): string {
  return toIstDate(new Date());
}

/** The UTC instants bounding one IST calendar day, half-open [start, end). */
export function istDayBoundsUtc(istDate: string): { start: string; end: string } {
  const startMs = Date.parse(`${istDate}T00:00:00Z`) - IST_OFFSET_MINUTES * 60_000;
  return {
    start: new Date(startMs).toISOString(),
    end: new Date(startMs + 86_400_000).toISOString(),
  };
}

/**
 * Whole days between two IST calendar dates. Used for data age, which decides
 * whether the app shows a forecast or admits it is a seasonal average, so it
 * must count calendar days rather than elapsed hours.
 */
export function daysBetweenIst(fromIstDate: string, toIstDate_: string): number {
  const a = Date.parse(`${fromIstDate}T00:00:00Z`);
  const b = Date.parse(`${toIstDate_}T00:00:00Z`);
  return Math.round((b - a) / 86_400_000);
}

/** How old a reading is, in IST calendar days, relative to today in India. */
export function dataAgeDays(instant: Date | string): number {
  return daysBetweenIst(toIstDate(instant), istToday());
}
