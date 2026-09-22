/**
 * GET /api/locations
 *
 * Every station a user can pick, grouped by city. This powers the first-run
 * setup and the location switcher.
 *
 * Grouped rather than a flat list because Delhi NCR has 73 stations and a flat
 * 168-row dropdown is unusable. The city is the first choice; the station is
 * the second.
 */

import { createClient } from "@/lib/supabase/server";
import { ok, fail } from "@/lib/api/respond";

export const revalidate = 3600; // the station list changes weekly at most

interface LocationRow {
  monitor_id: string;
  name: string;
  city: string;
  latitude: number;
  longitude: number;
}

export async function GET() {
  const supabase = createClient();
  const { data, error } = await supabase.rpc("list_locations");

  if (error) return fail("Could not load locations", 502, error.message);

  const rows = (data ?? []) as LocationRow[];
  const byCity = new Map<string, LocationRow[]>();
  for (const r of rows) {
    if (!r.city) continue; // a monitor with no city cannot be offered as a choice
    const list = byCity.get(r.city);
    if (list) list.push(r);
    else byCity.set(r.city, [r]);
  }

  const cities = Array.from(byCity.entries())
    .map(([city, stations]) => ({
      city,
      station_count: stations.length,
      stations: stations
        .map((s: LocationRow) => ({
          monitor_id: s.monitor_id,
          name: s.name,
          latitude: s.latitude,
          longitude: s.longitude,
        }))
        .sort((a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name)),
    }))
    .sort((a, b) => b.station_count - a.station_count);

  return ok(cities, { city_count: cities.length, station_count: rows.length });
}
