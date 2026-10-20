/**
 * GET /api/geocode?q=...&lat=..&lng=..   find a place by name or PIN code
 *
 * WHY THIS EXISTS. Every one of the first three testers said the same thing
 * about first run: finding your own home on a map of a city you only half
 * recognise, through a 350px window, is hard. A map is a good tool for "is
 * this the right spot?" and a bad one for "where am I?" — so this makes the
 * map the SECOND step. Type where you live, we put the pin there, then nudge
 * it if you like.
 *
 * TWO SOURCES, CHEAPEST FIRST.
 *
 *   1. Our own monitors table. ~170 stations whose names carry the locality
 *      they sit in — "Kherwadi_Bandra East", "Mindspace-Malad West". No
 *      network call, no third party, and for anyone living near a station it
 *      is the best answer available because it is the thing the forecast is
 *      actually built from.
 *
 *   2. Nominatim, OpenStreetMap's geocoder, for everywhere else and for PIN
 *      codes. Free, which is the constraint this project runs under.
 *
 * NOMINATIM'S TERMS ARE A REAL CONSTRAINT, not a formality: at most one
 * request a second, a User-Agent that identifies the app and a way to reach
 * someone, and no per-keystroke autocomplete. All three are honoured below —
 * which is also why the UI searches on submit rather than as you type.
 */

import { createClient } from "@/lib/supabase/server";
import { badRequest, ok, rateLimit, callerKey, tooManyRequests } from "@/lib/api/respond";
import { PIN, dedupe, distanceKm, tidyStationName, type GeocodeHit } from "@/lib/api/geocode";
import { searchNominatim } from "@/lib/api/nominatim";

export const dynamic = "force-dynamic";

const MAX_QUERY = 80;
const MAX_RESULTS = 6;
const PER_IP_PER_MINUTE = 20;
const MINUTE = 60_000;

/**
 * Nominatim asks that results be cached rather than re-fetched. This also
 * makes the common case — everyone in a city searching the same few
 * neighbourhoods — free after the first time.
 */
const cache = new Map<string, { hits: GeocodeHit[]; at: number }>();
const CACHE_TTL = 24 * 60 * 60_000;
const CACHE_MAX = 500;

function cached(key: string): GeocodeHit[] | null {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > CACHE_TTL) {
    cache.delete(key);
    return null;
  }
  return hit.hits;
}

function remember(key: string, hits: GeocodeHit[]): void {
  // Crude eviction: an instance that has done 500 distinct searches starts
  // again. Bounded memory matters more than a perfect LRU here.
  if (cache.size >= CACHE_MAX) cache.clear();
  cache.set(key, { hits, at: Date.now() });
}

async function searchStations(
  q: string,
  near: { lat: number; lng: number } | null,
): Promise<GeocodeHit[]> {
  const supabase = createClient();
  const { data, error } = await supabase
    .from("monitors")
    .select("name, latitude, longitude")
    .ilike("name", `%${q}%`)
    .not("latitude", "is", null)
    .limit(40);
  if (error || !data) return [];

  const hits = data
    .map((m) => ({
      label: tidyStationName(String(m.name)),
      latitude: Number(m.latitude),
      longitude: Number(m.longitude),
      kind: "station" as const,
    }))
    .filter((h) => Number.isFinite(h.latitude) && Number.isFinite(h.longitude));

  // Nearest first when we know where they are, so a "Nagar" in their own city
  // beats one four hundred kilometres away.
  if (near) {
    hits.sort(
      (a, b) =>
        distanceKm(near.lat, near.lng, a.latitude, a.longitude) -
        distanceKm(near.lat, near.lng, b.latitude, b.longitude),
    );
  }
  return hits;
}

export async function GET(request: Request) {
  const limit = rateLimit(`geocode:${callerKey(request)}`, PER_IP_PER_MINUTE, MINUTE);
  if (!limit.allowed) return tooManyRequests(limit.resetAt);

  const params = new URL(request.url).searchParams;
  const q = (params.get("q") ?? "").trim().slice(0, MAX_QUERY);
  if (q.length < 3) return badRequest("Type at least three characters, or a six-digit PIN code");

  const lat = Number(params.get("lat"));
  const lng = Number(params.get("lng"));
  const near =
    Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null;

  const key = `${q.toLowerCase()}|${near ? `${near.lat.toFixed(2)},${near.lng.toFixed(2)}` : ""}`;
  const hit = cached(key);
  if (hit) return ok(hit, { cached: true });

  // A PIN code is never a station name, so there is nothing to ask our own
  // table for and the external lookup is the only route.
  const isPin = PIN.test(q);
  const stations = isPin ? [] : await searchStations(q, near);

  // Only reach outside when our own data did not answer well. Most searches in
  // a covered city will not need to.
  const places = stations.length >= 3 ? [] : await searchNominatim(q, near);

  const hits = dedupe([...stations, ...places], MAX_RESULTS);

  remember(key, hits);
  return ok(hits, { sources: { stations: stations.length, places: places.length } });
}
