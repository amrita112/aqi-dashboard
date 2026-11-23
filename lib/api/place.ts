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
  DataError,
  DEFAULT_NEAREST_K,
  DEFAULT_MAX_KM,
  type NearbyMonitor,
  type MonitorRow,
} from "@/lib/api/data";
import { parseNumber } from "@/lib/api/respond";

export interface PlaceRequest {
  kind: "station" | "point";
  monitors: NearbyMonitor[];
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
        query: { monitor_id: m.id },
      },
    };
  }

  if (latRaw === null || lngRaw === null) {
    return {
      error: {
        message: "Provide either monitor_id, or lat and lng for a location average",
        status: 400,
      },
    };
  }

  const lat = Number(latRaw);
  const lng = Number(lngRaw);
  if (!Number.isFinite(lat) || lat < -90 || lat > 90) {
    return { error: { message: "lat must be between -90 and 90", status: 400 } };
  }
  if (!Number.isFinite(lng) || lng < -180 || lng > 180) {
    return { error: { message: "lng must be between -180 and 180", status: 400 } };
  }

  const k = parseNumber(params, "k", DEFAULT_NEAREST_K, 1, 10);
  const maxKm = parseNumber(params, "max_km", DEFAULT_MAX_KM, 1, 200);
  const city = params.get("city");

  // A failed lookup must not read as "no stations within N km" (see
  // DataError): that is a 404 about the place, and this is a 502 about us.
  let monitors: Awaited<ReturnType<typeof nearestMonitors>>;
  try {
    monitors = await nearestMonitors(supabase, lat, lng, k, maxKm, city);
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
      query: { lat, lng, k, max_km: maxKm, city: city ?? null },
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
 * How many monitors must report before a city average counts, or null when the
 * request is not for a city (a point or a station is never hidden this way).
 *
 * The denominator is every active monitor filed under the city, not just the
 * ones nearest its centre that the average is drawn from: the claim being
 * protected is "this describes the city".
 */
export async function cityMinStations(
  supabase: SupabaseClient,
  city: string | null,
): Promise<number | null> {
  if (!city) return null;
  const { count, error } = await supabase
    .from("monitors")
    .select("id", { count: "exact", head: true })
    .eq("city", city)
    .is("disabled_at", null);
  if (error || count === null) return null;
  return minStationsOf(count);
}

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
 * Every active monitoring station filed under a city (not disabled), nearest
 * to (lat, lng) first, with its distance from that point.
 *
 * The same stations cityMinStations counts, so "10% of the city's stations"
 * is measured against the very stations the average can draw on. Throws
 * DataError when the database cannot be read, so an empty list always means
 * "no stations filed under this city".
 */
export async function cityMonitors(
  supabase: SupabaseClient,
  city: string,
  lat: number,
  lng: number,
): Promise<NearbyMonitor[]> {
  const { data, error } = await supabase
    .from("monitors")
    .select("id, name, city, latitude, longitude")
    .eq("city", city)
    .is("disabled_at", null)
    .order("id", { ascending: true });
  if (error) throw new DataError("Could not load the city's monitoring stations", error);
  return ((data ?? []) as MonitorRow[])
    .map((m) => ({
      ...m,
      distance_km: Math.round(distanceKm(lat, lng, m.latitude, m.longitude) * 100) / 100,
    }))
    .sort((a, b) => a.distance_km - b.distance_km);
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
