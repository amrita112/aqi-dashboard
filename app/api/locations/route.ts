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
  const [locations, defaults] = await Promise.all([
    supabase.rpc("list_locations"),
    // Shipped alongside so the first-run setup is a single round trip: the
    // threshold step needs a sensible number for the city the user just
    // picked, and it would be absurd to make them wait again for it.
    supabase.from("alert_defaults").select("city, pollutant, threshold, source"),
  ]);

  if (locations.error) return fail("Could not load locations", 502, locations.error.message);

  // Keyed per pollutant, including the provenance string. Flattening `source`
  // onto the city would let whichever pollutant was read last describe both —
  // so Delhi's PM2.5 threshold of 290 would cite the AQI figure of 383.
  const thresholds = new Map<
    string,
    { aqi?: { threshold: number; source: string }; pm25?: { threshold: number; source: string } }
  >();
  for (const row of defaults.data ?? []) {
    const entry = thresholds.get(row.city) ?? {};
    entry[row.pollutant as "aqi" | "pm25"] = { threshold: row.threshold, source: row.source };
    thresholds.set(row.city, entry);
  }

  const rows = (locations.data ?? []) as LocationRow[];
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
      // Prefilled notification threshold: the median daily maximum over
      // October–February, so someone who keeps the default hears from the app
      // on roughly half the days of the bad season. That makes the number
      // self-describing — "a typical bad-season day here" — and gives an
      // obvious direction to move it in.
      alert_default: thresholds.get(city) ?? null,
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
