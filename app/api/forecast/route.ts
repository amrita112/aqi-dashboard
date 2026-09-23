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
import { bestHour } from "@/lib/api/forecast";
import { getForecast } from "@/lib/api/data";

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
  // regional, not per-station. APP_TO_ANALYSIS maps the app's spelling to the
  // analysis one (Bangalore -> Bengaluru) inside getForecast.
  const { data: monitor, error: monErr } = await supabase
    .from("monitors")
    .select("id, name, city, latitude, longitude")
    .eq("id", monitorId)
    .maybeSingle();

  if (monErr) return fail("Could not load the station", 502, monErr.message);
  if (!monitor) return notFound("No such station");

  const today = istToday();

  // Shared with the `forecast` AI tool via lib/api/data.ts, so the question
  // "what is tomorrow's forecast" has exactly one implementation and the two
  // surfaces cannot drift into answering it differently.
  const forecast = await getForecast(supabase, monitor, pollutant, days);
  if (!forecast.length) {
    return notFound(
      "No forecast stored for this station and pollutant. The nightly job may not have run since it was added.",
    );
  }
  if (!wantHourly) forecast.forEach((d) => (d.hourly = null));

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

