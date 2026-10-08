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
    name: string;
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
  const full: Prefs = { ...prefs, version: 2, saved_at: new Date().toISOString() };
  try {
    window.localStorage.setItem(PREFS_KEY, JSON.stringify(full));
    return full;
  } catch {
    // Saving failed (private window, quota). The caller still gets the object
    // so the session works; it just will not survive a reload.
    return null;
  }
}

export function clearPrefs(): void {
  try {
    window.localStorage.removeItem(PREFS_KEY);
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
