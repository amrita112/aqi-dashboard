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
import { CONTACT_EMAIL, APP_NAME } from "@/lib/brand";
import { PIN, dedupe, distanceKm, tidyStationName, type GeocodeHit } from "@/lib/api/geocode";

export const dynamic = "force-dynamic";

const MAX_QUERY = 80;
const MAX_RESULTS = 6;
const PER_IP_PER_MINUTE = 20;
const MINUTE = 60_000;

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

async function searchNominatim(
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
