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
      return { error: { message: "Could not load the station", status: 502 } };
    }
    if (!data) return { error: { message: "No such station", status: 404 } };
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

  const monitors = await nearestMonitors(supabase, lat, lng, k, maxKm, city);
  if (!monitors.length) {
    return {
      error: {
        message: `No stations within ${maxKm} km of that point. Try a wider max_km, or pick a city.`,
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
