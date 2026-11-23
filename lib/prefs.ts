/**
 * What the app remembers about a person, and where it keeps it.
 *
 * IN THE BROWSER, NOT IN THE DATABASE. There are no accounts in v1, and asking
 * someone to create one before they can see whether the air is bad today would
 * lose most of them at the first screen. localStorage costs nothing, needs no
 * login, and keeps the first run to three questions.
 *
 * The cost is real and should be said out loud in the UI rather than
 * discovered: clearing site data loses these settings, and they do not follow
 * the person to another device. That is the trade v1 makes.
 *
 * NO GEOLOCATION anywhere in this. The user picks a place explicitly — decided
 * 2026-09-21. It avoids a permission prompt, a denial path and an iOS Safari
 * debugging session, and it is also the better product: someone in Delhi
 * checking on family in Chennai is a first-class case, possibly the common one.
 */

import { LAUNCH_KEYS } from "@/lib/launch";
import { tidyStationName } from "@/lib/api/geocode";

export type Measurement = "aqi" | "pm25";

export interface Prefs {
  /** Bumped when the shape changes, so a stale object is discarded not crashed on. */
  version: 2;
  city: string;
  /**
   * The POINT the user dropped on the map, not a station.
   *
   * v1 stored a station the user picked from a dropdown, which asked them to
   * know which CPCB site was nearest their flat. The anchor is now their own
   * place; the stations are derived from it, and `name` is what they called it
   * rather than a monitoring site's name.
   *
   * monitor_id is kept, holding the nearest station at the time of choosing,
   * because several callers still want a single representative station.
   */
  anchor: {
    monitor_id: string;
    /**
     * What the PERSON called this place ("Home", "Amma's flat"). Shown on
     * their own screens only. It is private: it never goes into anything the
     * app shares (see publicPlaceLabel in lib/public-label.ts).
     */
    name: string;
    /**
     * The area name WE give this place: the nearest monitoring station's
     * locality, tidied ("Kherwadi, Bandra East"). This, not `name`, is what a
     * shared image or message calls the place.
     *
     * OPTIONAL because installs set up before 22 Nov 2026 do not have it.
     * Those still load (no version bump, so nobody is sent back through
     * setup); anything that needs a public name falls back to the city, or to
     * the stations the server reports, and never to `name`.
     */
    area?: string;
    latitude: number;
    longitude: number;
  };
  measurement: Measurement;
  /** null means "do not notify me" — an explicit choice, not an absent one. */
  threshold: number | null;
  saved_at: string;
}

// v2 because the anchor changed meaning. A v1 object would load and look
// valid while pointing at a station the person never chose as their "place".
export const PREFS_KEY = "aqi.prefs.v2";

/** How many nearby stations an answer is averaged over. */
export const NEAREST_K = 3;

/**
 * The longest name a person may give a place, in characters.
 *
 * 40 fits "Grandmother's flat, Lajpat Nagar IV" with room to spare and still
 * fits on a pill on a narrow phone. A cap exists at all because the name is
 * free text: without one, a pasted paragraph would be saved and drawn on
 * every screen. Enforced twice — `maxLength` on the input box, and
 * cleanPlaceLabel() when saving — because text can also arrive without
 * typing (a search result fills the box, or an old saved value).
 */
export const MAX_PLACE_LABEL_CHARS = 40;

/**
 * Make a place name safe to store and draw: one line, no invisible
 * characters, at most MAX_PLACE_LABEL_CHARS long.
 *
 * - Line breaks, tabs and other control characters become spaces. They are
 *   never intended in a place name and can break layouts (or, in shared
 *   text, start a new line that looks like it came from the app).
 * - Runs of spaces collapse to one, and the ends are trimmed.
 * - Too long: cut at the last space before the limit if there is one in the
 *   second half (so "Bandra Kurla Complex, Mumbai, Maharashtra" does not end
 *   in half a word), otherwise at the limit itself.
 *
 * Counts characters with Array.from rather than .length so that Devanagari
 * or emoji (which JavaScript can store as two "units") are never cut in half.
 */
export function cleanPlaceLabel(raw: string, max = MAX_PLACE_LABEL_CHARS): string {
  const flat = raw
    // \u0000-\u001F and \u007F-\u009F are the control characters; \u2028 and
    // \u2029 are Unicode's own line and paragraph separators.
    .replace(/[\u0000-\u001F\u007F-\u009F\u2028\u2029]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const chars = Array.from(flat);
  if (chars.length <= max) return flat;
  const cut = chars.slice(0, max).join("");
  const lastSpace = cut.lastIndexOf(" ");
  return (lastSpace >= max / 2 ? cut.slice(0, lastSpace) : cut).replace(/[\s,·-]+$/, "");
}

/**
 * Our name for the area around a place, from the stations nearest it: the
 * first (nearest) station's name, tidied into a locality. Undefined when no
 * station is known, so callers fall back to the city rather than guess.
 */
export function areaFromStations(stations: { name: string }[]): string | undefined {
  const nearest = stations[0]?.name;
  if (!nearest) return undefined;
  const area = cleanPlaceLabel(tidyStationName(nearest));
  return area || undefined;
}

export const MEASUREMENT_COPY: Record<
  Measurement,
  { label: string; short: string; blurb: string; unit: string }
> = {
  aqi: {
    label: "Air Quality Index (AQI)",
    short: "AQI",
    // The honest version: familiar, but not what most people assume it means.
    blurb:
      "AQI is a combined measure of five different pollutants. Its value corresponds to the pollutant with maximum concentration. In most Indian cities, it is dominated by PM10 (coarse dust).",
    unit: "",
  },
  pm25: {
    label: "PM2.5 concentration",
    short: "PM2.5",
    blurb:
      "The PM2.5 concentration tells you how much fine particulate matter is in the air. This is the pollutant with the worst long-term effects on health, especially lung health. It may be lower than AQI (because AQI is the maximum of five different pollutants).",
    unit: "µg/m³",
  },
};

export function loadPrefs(): Prefs | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(PREFS_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Prefs;
    // A shape from an older version is discarded rather than patched: the
    // first run is three questions, so asking them again is cheap.
    if (parsed?.version !== 2 || !parsed.city || !parsed.anchor?.name) return null;
    return parsed;
  } catch {
    // Private windows and blocked site data both throw here.
    return null;
  }
}

export function savePrefs(prefs: Omit<Prefs, "version" | "saved_at">): Prefs | null {
  // Every save passes through here, so this is the one place the name rules
  // are guaranteed to apply, whichever screen did the saving. An empty result
  // (someone saved only spaces) keeps the old behaviour of a non-empty name by
  // falling back to the area, then the city.
  const area = prefs.anchor.area ? cleanPlaceLabel(prefs.anchor.area) || undefined : undefined;
  const name = cleanPlaceLabel(prefs.anchor.name) || area || prefs.city;
  const full: Prefs = {
    ...prefs,
    anchor: { ...prefs.anchor, name, area },
    version: 2,
    saved_at: new Date().toISOString(),
  };
  try {
    window.localStorage.setItem(PREFS_KEY, JSON.stringify(full));
    return full;
  } catch {
    // Saving failed (private window, quota). The caller still gets the object
    // so the session works; it just will not survive a reload.
    return null;
  }
}

/**
 * Forget everything this app has stored on the device.
 *
 * EVERY KEY, not just the preferences. Clearing only the answers left the app
 * in a state no real first-time user is ever in: back at the setup questions,
 * but with the install banner still dismissed and old questions in the Ask
 * tab's history. That makes it impossible to test the first run honestly,
 * which is the main reason this button exists.
 *
 * Any new localStorage key belongs in this list. Prefix-matching everything
 * under "aqi." would catch them automatically, but it would also quietly wipe
 * anything a future version stores that is NOT a preference, so the list is
 * explicit.
 */
export function clearPrefs(): void {
  const keys = [
    PREFS_KEY,
    "aqi.ask.v1", // the Ask tab's cached questions and answers
    "aqi.installHint.dismissed", // the "Add to Home Screen" banner
    ...LAUNCH_KEYS, // install date and last report for the home-screen count (lib/launch.ts)
  ];
  try {
    for (const key of keys) window.localStorage.removeItem(key);
  } catch {
    /* nothing to do */
  }
}

/**
 * The query string that turns a person's anchor into an answer about their
 * neighbourhood. One place, so every screen asks the same question.
 */
export function placeQuery(prefs: Prefs, extra: Record<string, string | number> = {}): string {
  const params = new URLSearchParams({
    lat: String(prefs.anchor.latitude),
    lng: String(prefs.anchor.longitude),
    k: String(NEAREST_K),
    ...Object.fromEntries(Object.entries(extra).map(([k, v]) => [k, String(v)])),
  });
  return params.toString();
}
