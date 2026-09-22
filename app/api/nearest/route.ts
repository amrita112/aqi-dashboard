/**
 * GET /api/nearest?lat=&lng=&k=&max_km=&city=
 *
 * The k nearest stations to a point, for the map and for the forecast, which
 * averages over the nearest few rather than trusting one monitor.
 *
 * `max_km` matters and defaults to 25: without a cap, a user in a city with
 * three working stations silently gets a fourth from 200 km away averaged in
 * as though it described their air. Better to return fewer and let the caller
 * fall back to a city-level answer.
 *
 * Note the app has no geolocation — every user picks a place explicitly — so
 * lat/lng here come from a chosen station or city centre, never from a
 * browser permission prompt.
 */

import { createClient } from "@/lib/supabase/server";
import { ok, fail, badRequest, parseNumber } from "@/lib/api/respond";

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const lat = Number(params.get("lat"));
  const lng = Number(params.get("lng"));

  if (!Number.isFinite(lat) || lat < -90 || lat > 90) {
    return badRequest("lat is required and must be between -90 and 90");
  }
  if (!Number.isFinite(lng) || lng < -180 || lng > 180) {
    return badRequest("lng is required and must be between -180 and 180");
  }

  const k = parseNumber(params, "k", 5, 1, 50);
  const maxKm = parseNumber(params, "max_km", 25, 1, 500);
  const city = params.get("city");

  const supabase = createClient();
  const { data, error } = await supabase.rpc("nearest_monitors", {
    lat,
    lng,
    k,
    max_km: maxKm,
    want_city: city,
  });

  if (error) return fail("Could not find nearby stations", 502, error.message);

  return ok(data ?? [], { lat, lng, k, max_km: maxKm, city: city ?? null });
}
