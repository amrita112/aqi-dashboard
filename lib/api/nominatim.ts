/**
 * Nominatim, OpenStreetMap's free geocoder: a place name or PIN code to a
 * point. Shared by the place search on the setup screen (app/api/geocode) and
 * the AI's tools, which need to find "Hinjewadi" the same way a person typing
 * it into the search box would.
 *
 * One module, so the one-request-per-second pacing that Nominatim's usage
 * policy asks for is shared by both callers in an instance, rather than each
 * keeping its own clock and together going over.
 */

import { CONTACT_EMAIL, APP_NAME } from "@/lib/brand";
import { PIN, distanceKm, type GeocodeHit } from "@/lib/api/geocode";

/** How far from the chosen city a result may be before it is noise. */
const MAX_KM_FROM_CITY = 120;

/**
 * One request a second, globally.
 *
 * NOT per IP. Nominatim's limit applies to us as a client, so two visitors
 * searching at once is exactly the case this has to cover — a per-IP limit
 * would let that through. The queue is deliberately crude: wait your turn, up
 * to a point, then give up and return what we have locally.
 */
let nominatimFreeAt = 0;
async function waitForNominatimSlot(maxWaitMs: number): Promise<boolean> {
  const now = Date.now();
  const wait = Math.max(0, nominatimFreeAt - now);
  if (wait > maxWaitMs) return false;
  nominatimFreeAt = Math.max(now, nominatimFreeAt) + 1_100;
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  return true;
}

export async function searchNominatim(
  q: string,
  near: { lat: number; lng: number } | null,
): Promise<GeocodeHit[]> {
  const isPin = PIN.test(q);
  const url = new URL("https://nominatim.openstreetmap.org/search");
  url.searchParams.set("format", "jsonv2");
  url.searchParams.set("countrycodes", "in");
  url.searchParams.set("limit", "10");
  url.searchParams.set("addressdetails", "1");
  if (isPin) url.searchParams.set("postalcode", q);
  else url.searchParams.set("q", q);

  // Waiting up to a second is acceptable for a search someone submitted on
  // purpose; waiting five is not, and we still have the station list.
  if (!(await waitForNominatimSlot(1_500))) return [];

  let rows: unknown;
  try {
    const res = await fetch(url, {
      headers: {
        // Required by Nominatim's usage policy: identify the app, and give
        // them someone to contact rather than blocking an anonymous caller.
        "User-Agent": `${APP_NAME}/1.0 (${CONTACT_EMAIL})`,
        "Accept-Language": "en",
      },
      signal: AbortSignal.timeout(6_000),
    });
    if (!res.ok) return [];
    rows = await res.json();
  } catch {
    // Slow, down, or rate limited. The station results still stand.
    return [];
  }
  if (!Array.isArray(rows)) return [];

  const hits: GeocodeHit[] = [];
  for (const r of rows as Record<string, unknown>[]) {
    const lat = Number(r.lat);
    const lng = Number(r.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    // display_name is the full administrative chain — "Sewri, Mumbai, Mumbai
    // Suburban, Maharashtra, 400015, India". The first three parts are the
    // part anyone reads.
    const label = String(r.display_name ?? "").split(",").slice(0, 3).join(",").trim();
    if (!label) continue;
    hits.push({ label, latitude: lat, longitude: lng, kind: "place" });
  }

  if (near) {
    return hits
      .filter((h) => distanceKm(near.lat, near.lng, h.latitude, h.longitude) <= MAX_KM_FROM_CITY)
      .sort(
        (a, b) =>
          distanceKm(near.lat, near.lng, a.latitude, a.longitude) -
          distanceKm(near.lat, near.lng, b.latitude, b.longitude),
      );
  }
  return hits;
}
