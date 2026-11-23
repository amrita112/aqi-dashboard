/**
 * How a request says which place it means.
 *
 * Two ways, and the routes accept both:
 *
 *   monitor_id=<uuid>        one specific station. Used by the map, where the
 *                            user has clicked a pin and means that pin.
 *
 *   lat=&lng=[&k=&max_km=]   a POINT, answered by averaging the k nearest
 *                            stations. This is the one the app leads with: a
 *                            person is at a place, not at a monitor.
 *
 *   city=<name>[&lat=&lng=]  a CITY AVERAGE: every active monitoring station
 *                            filed under that city (owner's decision, 23 Nov
 *                            2026), never a sample of them. lat/lng, when
 *                            given, only set the order the stations are
 *                            listed in (nearest first) and their distances;
 *                            k and max_km are ignored. See resolveCity.
 *
 * Why the point form is the default for the product: answering from whichever
 * single station is nearest is arbitrary when two sit 800 m apart, and
 * answering from the city mean throws away that Anand Vihar and Lodhi Road are
 * genuinely different air. It also rescues stations too thin to forecast on
 * their own — a monitor with 37 days of history can only serve the seasonal
 * normal, but its neighbours may have years.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  nearestMonitors,
  pageAll,
  DataError,
  DEFAULT_NEAREST_K,
  DEFAULT_MAX_KM,
  type NearbyMonitor,
  type MonitorRow,
} from "@/lib/api/data";
import { parseNumber } from "@/lib/api/respond";

export interface PlaceRequest {
  kind: "station" | "point" | "city";
  monitors: NearbyMonitor[];
  /**
   * City averages only: how many of `monitors` must have reported in a day
   * or hour for the city average to be shown (CITY_MIN_REPORTING_SHARE of
   * that same pool). null for a station or a point, which are never hidden.
   */
  minStations: number | null;
  /** Echoed back so a caller can see what was actually used. */
  query: Record<string, unknown>;
}

export type PlaceError = { message: string; status: number };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Work out which stations answer this request, or why none do.
 *
 * Returns a discriminated result rather than throwing, so each route decides
 * its own status code and wording.
 */
export async function resolvePlace(
  supabase: SupabaseClient,
  params: URLSearchParams,
): Promise<{ place: PlaceRequest } | { error: PlaceError }> {
  const monitorId = params.get("monitor_id");
  const latRaw = params.get("lat");
  const lngRaw = params.get("lng");

  if (monitorId) {
    if (!UUID_RE.test(monitorId)) {
      return { error: { message: "monitor_id must be a UUID", status: 400 } };
    }
    const { data, error } = await supabase
      .from("monitors")
      .select("id, name, city, latitude, longitude")
      .eq("id", monitorId)
      .maybeSingle();
    if (error) {
      return { error: { message: "Could not load the monitoring station", status: 502 } };
    }
    if (!data) return { error: { message: "No such monitoring station", status: 404 } };
    const m = data as MonitorRow;
    return {
      place: {
        kind: "station",
        monitors: [{ ...m, distance_km: 0 }],
        minStations: null,
        query: { monitor_id: m.id },
      },
    };
  }

  const city = params.get("city")?.trim() || null;

  if (!city && (latRaw === null || lngRaw === null)) {
    return {
      error: {
        message: "Provide monitor_id, or lat and lng for a location average, or city for a city average",
        status: 400,
      },
    };
  }

  // Checked whenever given, even for a city (where they only order the list).
  const hasPoint = latRaw !== null && lngRaw !== null;
  const lat = Number(latRaw);
  const lng = Number(lngRaw);
  if (hasPoint && (!Number.isFinite(lat) || lat < -90 || lat > 90)) {
    return { error: { message: "lat must be between -90 and 90", status: 400 } };
  }
  if (hasPoint && (!Number.isFinite(lng) || lng < -180 || lng > 180)) {
    return { error: { message: "lng must be between -180 and 180", status: 400 } };
  }

  // A CITY AVERAGE: the whole city, every time. This used to be "the 10
  // stations nearest the city centre" (k=10 from the Trends screen), while
  // the 10% minimum was taken of ALL the city's stations -- Delhi NCR needed
  // 8 of those 10 to report on the same day, and days went blank.
  if (city) {
    let pool: CityPool;
    try {
      pool = await resolveCity(supabase, city, hasPoint ? { lat, lng } : null);
    } catch (err) {
      if (err instanceof DataError) {
        console.error("[502] Could not load the city's stations:", err.detail);
        return { error: { message: "Could not load the city's monitoring stations", status: 502 } };
      }
      throw err;
    }
    if (!pool.monitors.length) {
      return { error: { message: `No monitoring stations found for ${city}.`, status: 404 } };
    }
    return {
      place: {
        kind: "city",
        monitors: pool.monitors,
        minStations: pool.minStations,
        query: { city, lat: pool.centre.lat, lng: pool.centre.lng },
      },
    };
  }

  const k = parseNumber(params, "k", DEFAULT_NEAREST_K, 1, 10);
  const maxKm = parseNumber(params, "max_km", DEFAULT_MAX_KM, 1, 200);

  // A failed lookup must not read as "no stations within N km" (see
  // DataError): that is a 404 about the place, and this is a 502 about us.
  let monitors: Awaited<ReturnType<typeof nearestMonitors>>;
  try {
    monitors = await nearestMonitors(supabase, lat, lng, k, maxKm);
  } catch (err) {
    if (err instanceof DataError) {
      console.error("[502] Could not look up nearby stations:", err.detail);
      return { error: { message: "Could not look up nearby monitoring stations", status: 502 } };
    }
    throw err;
  }
  if (!monitors.length) {
    return {
      error: {
        // Plain words for the person reading it: the old text told them to
        // "try a wider max_km", which is the name of a URL setting, not
        // something anyone using the app can change.
        message: `No monitoring stations within ${maxKm} km of that point. Try a point closer to the city, or choose the whole city.`,
        status: 404,
      },
    };
  }

  return {
    place: {
      kind: "point",
      monitors,
      minStations: null,
      query: { lat, lng, k, max_km: maxKm },
    },
  };
}

/**
 * A city average is only shown for a day or hour when at least this share of
 * the city's monitors reported in it.
 *
 * WHY. Mumbai, 14-16 Oct 2026: the CPCB monitors had not reached OpenAQ yet,
 * but the US Consulate monitor (AirNow, near real-time) had. The "city
 * average" was that one monitor, afternoon spikes to 980 µg/m³ included, while
 * the four CPCB monitors within 3 km read about 40 when their data arrived.
 * One monitor is a neighbourhood, not a city.
 */
export const CITY_MIN_REPORTING_SHARE = 0.1;

/**
 * The CITY_MIN_REPORTING_SHARE rule for a pool of `count` stations: at least
 * one, else that share of them rounded up (79 stations -> 8, 10 -> 1).
 */
export function minStationsOf(count: number): number {
  return Math.max(1, Math.ceil(count * CITY_MIN_REPORTING_SHARE));
}

/** Straight-line distance in km between two points (the haversine formula). */
export function distanceKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad;
  const dLng = (lng2 - lng1) * rad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLng / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(a));
}

/**
 * A city average's stations: the ONE definition every screen and the AI box
 * share (owner's decision, 23 Nov 2026).
 *
 *   monitors     every ACTIVE monitoring station filed under the city
 *                (monitors.city = city, disabled_at IS NULL), nearest the
 *                centre first. Not a sample, not the nearest few.
 *   minStations  how many of THOSE stations must report in a day or hour for
 *                the city average to be shown: CITY_MIN_REPORTING_SHARE of the
 *                same pool (Delhi NCR: 79 stations -> 8).
 *   centre       the point distances are measured from: the one given, else
 *                the mean position of the city's stations (the same centre
 *                the Trends screen computes from /api/locations).
 *
 * WHY THE SAME POOL FOR BOTH. Until Nov 2026 the average was drawn from the
 * 10 stations nearest the centre while the 10% was taken of all 79, so 8 of
 * those 10 had to report on the same day, and Delhi lost days.
 *
 * Throws DataError when the database cannot be read, so an empty list always
 * means "no active stations filed under this city".
 */
export interface CityPool {
  city: string;
  monitors: NearbyMonitor[];
  minStations: number;
  centre: { lat: number; lng: number };
}

export async function resolveCity(
  supabase: SupabaseClient,
  city: string,
  centre: { lat: number; lng: number } | null = null,
): Promise<CityPool> {
  const rows = await activeCityMonitors(supabase, city);
  const from = centre ?? {
    lat: rows.length ? rows.reduce((t, m) => t + m.latitude, 0) / rows.length : 0,
    lng: rows.length ? rows.reduce((t, m) => t + m.longitude, 0) / rows.length : 0,
  };
  const monitors = rows
    .map((m) => ({
      ...m,
      distance_km: Math.round(distanceKm(from.lat, from.lng, m.latitude, m.longitude) * 100) / 100,
    }))
    // Nearest first; ties broken by id so the order never wobbles.
    .sort((a, b) => a.distance_km - b.distance_km || a.id.localeCompare(b.id));
  return { city, monitors, minStations: minStationsOf(monitors.length), centre: from };
}

/**
 * The active stations filed under a city, straight from the monitors table.
 * Stations without coordinates are left out: they cannot be placed on a map
 * or measured from the centre, and none of them is filed under a city today.
 * A city has tens of stations, far below the 1000-row cap; it is paged anyway
 * so a much larger city cannot be cut off silently.
 */
async function activeCityMonitors(supabase: SupabaseClient, city: string): Promise<MonitorRow[]> {
  const { data, error } = await pageAll<MonitorRow>((lo, hi) =>
    supabase
      .from("monitors")
      .select("id, name, city, latitude, longitude")
      .eq("city", city)
      .is("disabled_at", null)
      .not("latitude", "is", null)
      .not("longitude", "is", null)
      .order("id", { ascending: true })
      .range(lo, hi),
  );
  if (error) throw new DataError("Could not load the city's monitoring stations", error);
  return data;
}

/** Shared `meta` describing which stations answered, and how far away. */
export function placeMeta(place: PlaceRequest, contributing?: { monitor_id: string; name: string; distance_km: number }[]) {
  const used = contributing ?? place.monitors.map((m) => ({
    monitor_id: m.id,
    name: m.name,
    distance_km: m.distance_km,
  }));
  return {
    resolved_by: place.kind,
    stations_used: used.length,
    stations: used,
    furthest_km: used.length ? Math.max(...used.map((s) => s.distance_km)) : 0,
    ...place.query,
  };
}
