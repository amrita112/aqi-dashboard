/**
 * GET /api/forecast?monitor_id=&pollutant=&days=&hourly=
 *
 * The app's headline. Returns the stored daily forecast expanded to IST hours
 * via the per-city diurnal shape, with the serving mode carried through.
 *
 * The home screen leads with this rather than the last reading, because
 * OpenAQ runs ~17h behind: "what will it be like tomorrow" is answerable,
 * "what is it right now" mostly is not.
 *
 * The `mode` on each day is not decoration. It comes from a backtest of what
 * this city's stations actually achieve at this data age, and a screen must
 * honour it:
 *
 *   forecast         show as a forecast
 *   outlook          wider band, softer language
 *   seasonal_normal  say "typical for this time of year" — NOT a prediction
 *
 * Each day carries a `headline` string already matched to its mode, so the
 * four screens cannot each invent their own wording and drift apart.
 */

import { createClient } from "@/lib/supabase/server";
import { ok, fail, notFound, badRequest, parseMonitorId, parseNumber } from "@/lib/api/respond";
import { istToday } from "@/lib/api/time";
import {
  indexShape,
  expandDay,
  bestHour,
  type ForecastDailyRow,
  type ShapeRow,
} from "@/lib/api/forecast";

export const revalidate = 300;

const ALLOWED_POLLUTANTS = new Set(["aqi", "pm25"]);

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;

  const monitorId = parseMonitorId(params);
  if (!monitorId) return badRequest("monitor_id is required and must be a UUID");

  const pollutant = params.get("pollutant") ?? "aqi";
  if (!ALLOWED_POLLUTANTS.has(pollutant)) {
    return badRequest(
      `pollutant must be one of: ${Array.from(ALLOWED_POLLUTANTS).join(", ")}`,
      { received: pollutant },
    );
  }

  const days = parseNumber(params, "days", 7, 1, 7);
  const wantHourly = (params.get("hourly") ?? "true") !== "false";

  const supabase = createClient();

  // The station's city decides which diurnal shape applies; the shape is
  // regional, not per-station.
  const { data: monitor, error: monErr } = await supabase
    .from("monitors")
    .select("id, name, city, latitude, longitude")
    .eq("id", monitorId)
    .maybeSingle();

  if (monErr) return fail("Could not load the station", 502, monErr.message);
  if (!monitor) return notFound("No such station");

  const today = istToday();

  const { data: rows, error: fErr } = await supabase
    .from("forecast_daily")
    .select(
      "monitor_id, pollutant, target_date, horizon_days, value, band_p50, band_p80, mode, model, based_on_date, data_age_days",
    )
    .eq("monitor_id", monitorId)
    .eq("pollutant", pollutant)
    .gt("target_date", today)
    .order("target_date", { ascending: true })
    .limit(days);

  if (fErr) return fail("Could not load the forecast", 502, fErr.message);
  if (!rows?.length) {
    return notFound(
      "No forecast stored for this station and pollutant. The nightly job may not have run since it was added.",
    );
  }

  // monitors.city is the app's spelling; diurnal_shape uses the analysis
  // spelling. Bangalore/Bengaluru is the one that differs.
  const analysisCity = APP_TO_ANALYSIS[monitor.city] ?? monitor.city;

  const { data: shapeRows, error: sErr } = await supabase
    .from("diurnal_shape")
    .select("city, pollutant, month, hour, ratio")
    .eq("city", analysisCity)
    .eq("pollutant", pollutant);

  if (sErr) return fail("Could not load the diurnal shape", 502, sErr.message);

  const shape = indexShape((shapeRows ?? []) as ShapeRow[]);
  const forecast = (rows as ForecastDailyRow[]).map((r) =>
    expandDay(r, analysisCity, shape, { hourly: wantHourly }),
  );

  const tomorrow = forecast[0];
  return ok(
    {
      station: {
        monitor_id: monitor.id,
        name: monitor.name,
        city: monitor.city,
        latitude: monitor.latitude,
        longitude: monitor.longitude,
      },
      pollutant,
      today,
      days: forecast,
      // Pulled out because it is what the home screen leads with.
      tomorrow: tomorrow ?? null,
      best_hour: tomorrow ? bestHour(tomorrow) : null,
    },
    {
      hourly: wantHourly,
      // Flagged rather than hidden: a flat profile means no fitted shape for
      // this city-month, so every hour carries the daily number.
      hourly_is_flat: forecast.some((d) => d.hourly_is_flat),
    },
  );
}

const APP_TO_ANALYSIS: Record<string, string> = {
  "Delhi NCR": "Delhi",
  Bangalore: "Bengaluru",
};
