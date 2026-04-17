/**
 * Database query functions.
 *
 * ALL database queries go through this file. This is intentional — it creates
 * a single place to swap out data sources later. For example, when you move to
 * hourly pre-computed snapshots (ETL), you'd change these functions to read from
 * a different table, and the rest of the app wouldn't need to change at all.
 *
 * Think of this like a data access layer — similar to how you might have a
 * separate module in Python that handles all your pandas DataFrame operations.
 */

import { SupabaseClient } from "@supabase/supabase-js";
import { Reading, ReadingInsert, DataSource } from "./types";

/**
 * Fetch all readings, newest first.
 * Optionally filter by data sources (e.g., only show OpenAQ and user data).
 * If no sources are specified, all readings are returned.
 */
export async function getReadings(
  supabase: SupabaseClient,
  limit: number = 1000,
  sources?: DataSource[]
): Promise<Reading[]> {
  let query = supabase
    .from("readings")
    .select("*")
    .order("recorded_at", { ascending: false })
    .limit(limit);

  // If specific sources are requested, filter to only those.
  // "in" means "where source is one of these values" — like Python's `in` operator.
  if (sources && sources.length > 0) {
    query = query.in("source", sources);
  }

  const { data, error } = await query;

  if (error) throw error;
  return data as Reading[];
}

/**
 * Fetch readings within a time range.
 * Useful for the dashboard: "show me readings from the last 24 hours."
 *
 * @param startTime - ISO timestamp string (e.g., "2026-04-14T00:00:00Z")
 * @param endTime - ISO timestamp string
 */
export async function getReadingsByTimeRange(
  supabase: SupabaseClient,
  startTime: string,
  endTime: string
): Promise<Reading[]> {
  const { data, error } = await supabase
    .from("readings")
    .select("*")
    .gte("recorded_at", startTime)   // gte = "greater than or equal" (i.e., after startTime)
    .lte("recorded_at", endTime)     // lte = "less than or equal" (i.e., before endTime)
    .order("recorded_at", { ascending: true });

  if (error) throw error;
  return data as Reading[];
}

/**
 * Fetch readings near a specific location.
 * Uses PostGIS to find readings within a given radius (in meters).
 * This calls a database function (RPC) that we'll create in the SQL migration.
 *
 * @param lat - Latitude of the center point
 * @param lng - Longitude of the center point
 * @param radiusMeters - Search radius in meters (default: 5000 = 5 km)
 */
export async function getReadingsNearLocation(
  supabase: SupabaseClient,
  lat: number,
  lng: number,
  radiusMeters: number = 5000
): Promise<Reading[]> {
  const { data, error } = await supabase
    .rpc("readings_within_radius", {
      lat,
      lng,
      radius_meters: radiusMeters,
    });

  if (error) throw error;
  return data as Reading[];
}

/**
 * Insert a new AQI reading into the database.
 * The user_id is automatically set by Supabase based on who's logged in
 * (via Row Level Security policies).
 */
export async function insertReading(
  supabase: SupabaseClient,
  reading: ReadingInsert
): Promise<Reading> {
  const { data, error } = await supabase
    .from("readings")
    .insert(reading)
    .select()       // Return the inserted row (so we can show it to the user)
    .single();      // We're inserting one row, so return a single object (not an array)

  if (error) throw error;
  return data as Reading;
}
