/**
 * The pure parts of place lookup, kept out of the route so they can be tested.
 *
 * A Next.js route file may only export its handlers and a few config values,
 * so anything worth asserting on has to live somewhere else. These three are
 * where the user-visible behaviour actually is.
 */

export interface GeocodeHit {
  label: string;
  latitude: number;
  longitude: number;
  /** Where it came from, so the UI can say "a monitoring station". */
  kind: "station" | "place";
}

/** An Indian PIN code: exactly six digits, never starting with zero. */
export const PIN = /^[1-9]\d{5}$/;

/** Great-circle distance in km. */
export function distanceKm(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const R = 6371;
  const dLat = ((bLat - aLat) * Math.PI) / 180;
  const dLng = ((bLng - aLng) * Math.PI) / 180;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((aLat * Math.PI) / 180) * Math.cos((bLat * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

/**
 * Tidy a station name into the locality someone would recognise.
 *
 * "Kherwadi_Bandra East, Mumbai - MPCB" is a monitoring site's full name. What
 * a person searching for their area wants is "Kherwadi, Bandra East" — the
 * network suffix and the city are noise in a list already filtered to their
 * city, and the underscore is a database artefact nobody should ever see.
 */
export function tidyStationName(name: string): string {
  return name
    .split(" - ")[0]
    .split(",")[0]
    .replace(/_/g, ", ")
    .trim();
}

/**
 * Collapse results that are the same answer.
 *
 * BY NAME FIRST, POSITION SECOND, and the order matters. Position alone got
 * both cases wrong in Mumbai: two stations called "Bandra Kurla Complex" 350m
 * apart survived as two identical-looking rows, while "Kherwadi, Bandra East"
 * sat 70m from one of them and was silently dropped — taking with it the only
 * name in the list someone from Bandra would recognise.
 *
 * What a person is choosing is a PLACE. The same name twice is one answer
 * however far apart the instruments are; two different names are two answers
 * however close.
 */
export function dedupe(all: GeocodeHit[], max: number): GeocodeHit[] {
  const seenLabel = new Set<string>();
  const seenPos = new Set<string>();
  const out: GeocodeHit[] = [];
  for (const h of all) {
    const label = h.label.toLowerCase();
    if (seenLabel.has(label)) continue;
    // Position is still checked ACROSS sources: the external geocoder's name
    // for a place we hold a station in will differ, and two rows ~100m apart
    // from different sources are the same spot.
    const pos = `${h.latitude.toFixed(3)},${h.longitude.toFixed(3)}`;
    if (h.kind === "place" && seenPos.has(pos)) continue;
    seenLabel.add(label);
    seenPos.add(pos);
    out.push(h);
    if (out.length >= max) break;
  }
  return out;
}
