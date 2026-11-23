/**
 * The names the app uses for a place in anything that LEAVES THE DEVICE — a
 * shared chart image, the message that goes with it.
 *
 * THE RULE: a shared thing names a place only in words WE chose, never in the
 * words the person typed. The "Call this place" box is free text; people put
 * "Home", "Riya's school" or a full street address in it, and that is fine on
 * their own screen. Sent to a WhatsApp group it says where they live, and a
 * recipient cannot tell the person's words from the app's. So the share uses
 * the nearest monitoring station's area name ("Near Kherwadi, Bandra East,
 * Mumbai") — coarse enough to say nothing about a doorstep, specific enough to
 * be useful.
 *
 * Everything here is pure (no browser, no network) so it can be tested.
 */

import { cleanPlaceLabel } from "@/lib/prefs";

/**
 * "Near <area>, <city>", or just the city when the area is unknown.
 *
 * The city is left off when the area name already contains it, so a station
 * called "Mumbai Central" does not become "Near Mumbai Central, Mumbai".
 */
export function nearLabel(area: string | undefined | null, city: string): string {
  const a = area ? cleanPlaceLabel(area) : "";
  if (!a) return areaUnknownLabel(city);
  return a.toLowerCase().includes(city.toLowerCase()) ? `Near ${a}` : `Near ${a}, ${city}`;
}

/**
 * What to call a person's place when we do not know its area yet (an install
 * from before areas were saved, and the server has not answered).
 *
 * NOT JUST THE CITY NAME. "Mumbai" alone would read as the city average,
 * which is a different number; this says it is one part of the city.
 */
export function areaUnknownLabel(city: string): string {
  return `A neighbourhood in ${city}`;
}

/**
 * The short "which stations" note for the shared MESSAGE (not the image
 * legend, where space is tight): "3 monitoring stations within 2.1 km".
 * Null when there is nothing to say.
 */
export function stationsNote(count: number | undefined, furthestKm: number | undefined): string | null {
  if (!count || count < 1) return null;
  const what = count === 1 ? "1 monitoring station" : `${count} monitoring stations`;
  if (typeof furthestKm !== "number" || !Number.isFinite(furthestKm) || furthestKm <= 0) return what;
  return `${what} within ${furthestKm.toFixed(1)} km`;
}

/**
 * The sentence shared with a Trends chart.
 *
 *   "The air quality forecast, from AirGyaan — Near Kherwadi, Bandra East,
 *    Mumbai (3 monitoring stations within 2.1 km); Delhi (city average).
 *    See the forecast for your area: https://airgyaan.in"
 *
 * Semicolons between places, because a public label already contains commas
 * ("Near Kherwadi, Bandra East, Mumbai") and "A, B and C" would be ambiguous.
 */
export function trendsShareText(
  lead: string,
  places: { label: string; note?: string | null }[],
  closing: string,
): string {
  const where = places.map((p) => (p.note ? `${p.label} (${p.note})` : p.label)).join("; ");
  return `${lead}, from AirGyaan${where ? ` — ${where}` : ""}. ${closing}`;
}

/**
 * The span of years behind a Historical trends chart: "2016–2026", or
 * "2026" for a single year. Null when there are none.
 */
export function yearSpan(first: number | null | undefined, last: number | null | undefined): string | null {
  if (!first || !last) return null;
  return first === last ? String(first) : `${first}–${last}`;
}

/**
 * The note shared with a Historical trends chart, per place: how many years
 * and how many monitoring stations stand behind it, e.g.
 * "11 years, 2016–2026; 73 monitoring stations" or
 * "12 years, 2015–2026; 3 monitoring stations within 2.1 km".
 *
 * Years first, because the long view is the point of this chart. The
 * distance is left off for a city average (`isCity`), where "within 40 km"
 * says nothing useful.
 */
export function climateNote(
  nYears: number,
  first: number | null | undefined,
  last: number | null | undefined,
  stationsUsed: number | undefined,
  furthestKm: number | null | undefined,
  isCity: boolean,
): string | null {
  const span = yearSpan(first, last);
  const years = nYears > 0 ? `${nYears} ${nYears === 1 ? "year" : "years"}${span ? `, ${span}` : ""}` : null;
  const stations = stationsNote(stationsUsed, isCity ? undefined : (furthestKm ?? undefined));
  const parts = [years, stations].filter(Boolean);
  return parts.length ? parts.join("; ") : null;
}
