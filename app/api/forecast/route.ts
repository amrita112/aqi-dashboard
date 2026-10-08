/**
 * GET /api/forecast?lat=&lng=&k=&pollutant=&days=&hourly=  — location average
 * GET /api/forecast?monitor_id=...                          — one station
 *
 * The app's headline. Returns the stored daily forecast expanded to IST hours
 * via the per-city diurnal shape, with the serving mode carried through.
 *
 * The home screen leads with this rather than the last reading, because OpenAQ
 * runs ~17h behind: "what will it be like tomorrow" is answerable, "what is it
 * right now" mostly is not.
 *
 * Averaging over the nearest stations is what makes this answer a PLACE rather
 * than a monitor, and it rescues thin stations: one with 37 days of history
 * can only ever serve the seasonal normal, but its neighbours may have years.
 * Stations on the seasonal normal are dropped from the blend whenever a
 * neighbour has a real forecast — see averageForecastDays.
 *
 * The `mode` on each day is not decoration. It comes from a backtest of what
 * this city's stations actually achieve at this data age, and a screen must
 * honour it:
 *
 *   forecast         show as a forecast
 *   outlook          wider band, softer language
 *   seasonal_normal  say "typical for this time of year" — NOT a prediction
 *
 * Each day carries a `headline` already matched to its mode, so the four
 * screens cannot each invent their own wording and drift apart.
 */

import { createClient } from "@/lib/supabase/server";
import { ok, fail, notFound, badRequest, parseNumber } from "@/lib/api/respond";
import { resolvePlace, placeMeta } from "@/lib/api/place";
import { getForecast, averageForecastDays } from "@/lib/api/data";
import { bestHour } from "@/lib/api/forecast";
import { istToday } from "@/lib/api/time";
import { assessDataQuality } from "@/lib/api/data-quality";

export const revalidate = 300;

const ALLOWED_POLLUTANTS = new Set(["aqi", "pm25"]);

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;

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
  const resolved = await resolvePlace(supabase, params);
  if ("error" in resolved) return fail(resolved.error.message, resolved.error.status);
  const { place } = resolved;

  // Shared with the `forecast` AI tool via lib/api/data.ts, so the question
  // "what is tomorrow's forecast" has exactly one implementation and the two
  // surfaces cannot drift into answering it differently.
  const perStation = await Promise.all(
    place.monitors.map(async (monitor) => ({
      monitor,
      days: await getForecast(supabase, monitor, pollutant, days),
    })),
  );

  const averaged = averageForecastDays(perStation, days, pollutant);
  if (!averaged) {
    return notFound(
      "No forecast stored for any station near that place. The nightly job may not have run since they were added.",
    );
  }

  const forecast = averaged.value;
  if (!wantHourly) forecast.forEach((d) => (d.hourly = null));

  const tomorrow = forecast[0];

  // Staleness is WHY a day falls back to the seasonal average, so the two are
  // reported together. A user told "typical for this time of year" deserves to
  // know that it is because the nearest monitors last reported days ago — and
  // to be offered something to do about it.
  const servingSeasonalNormal = tomorrow?.mode === "seasonal_normal";
  const ageHours =
    tomorrow?.data_age_days != null ? tomorrow.data_age_days * 24 : null;

  return ok(
    {
      place: {
        kind: place.kind,
        // The nearest contributing station, as a human-readable anchor.
        nearest: averaged.stations[0] ?? null,
      },
      pollutant,
      today: istToday(),
      days: forecast,
      // Pulled out because it is what the home screen leads with.
      tomorrow: tomorrow ?? null,
      best_hour: tomorrow ? bestHour(tomorrow) : null,
      data_quality: assessDataQuality(ageHours, {
        servingSeasonalNormal,
        stationCount: averaged.stations.length,
      }),
    },
    {
      ...placeMeta(place, averaged.stations),
      hourly: wantHourly,
      // Flagged rather than hidden: a flat profile means no fitted shape for
      // this city-month, so every hour carries the daily number.
      hourly_is_flat: forecast.some((d) => d.hourly_is_flat),
      // How many of the requested days came back as a real prediction.
      real_forecast_days: forecast.filter((d) => d.mode !== "seasonal_normal").length,
    },
  );
}
