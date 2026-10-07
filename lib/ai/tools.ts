/**
 * The five things the model is allowed to do.
 *
 * A fixed tool list rather than text-to-SQL, per docs/llm-integration-research.md:
 * a curated set is deterministic, constrainable, and cannot be talked into
 * reading a table it should not. The model picks a tool and writes a sentence;
 * **every number in the answer comes out of the database.**
 *
 * Each executor returns a compact object. Compact is deliberate — a free-tier
 * token budget is spent mostly on tool results, and a 24-point hourly array
 * per station would dominate the context while adding nothing the answer uses.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { ToolDefinition } from "@/lib/ai/provider";
import {
  resolveLocation,
  getCurrent,
  getForecast,
  getHistory,
  meanAcross,
  MAX_STATIONS_PER_CITY_QUERY,
  type ResolvedLocation,
} from "@/lib/api/data";
import type { ForecastDay } from "@/lib/api/forecast";
import { getAqiLabel } from "@/lib/aqi-utils";
import { istToday, toIstClock, toIstHour } from "@/lib/api/time";

const LOCATION_PARAM = {
  type: "string",
  description:
    "City or station name, e.g. 'Delhi', 'Mumbai', 'Bengaluru', or a specific station like 'Anand Vihar'.",
};

const POLLUTANT_PARAM = {
  type: "string",
  enum: ["aqi", "pm25"],
  description: "'aqi' is the composite 0-500 index. 'pm25' is the fine-particle concentration in ug/m3.",
};

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    type: "function",
    function: {
      name: "current_aqi",
      description:
        "The most recent measured reading for a place, and how old it is. Use for 'what is it like right now'. Readings are typically 17-24 hours behind, so always mention the age if it is over a day.",
      parameters: {
        type: "object",
        properties: { location: LOCATION_PARAM },
        required: ["location"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "forecast",
      description:
        "The forecast for the next 1-7 days. Each day has a mode: 'forecast' and 'outlook' are predictions, but 'seasonal_normal' means there is no recent data and the number is just the seasonal average — say so plainly and do not call it a forecast.",
      parameters: {
        type: "object",
        properties: {
          location: LOCATION_PARAM,
          pollutant: POLLUTANT_PARAM,
          days: { type: "integer", minimum: 1, maximum: 7, description: "Default 1 (tomorrow)." },
        },
        required: ["location"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "best_hour",
      description:
        "The cleanest and dirtiest hours of TOMORROW for a place, in Indian Standard Time. For today, this evening, or the next few hours, use rest_of_today instead. Returns nothing usable if no hourly profile has been fitted for that city and month.",
      parameters: {
        type: "object",
        properties: { location: LOCATION_PARAM, pollutant: POLLUTANT_PARAM },
        required: ["location"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "rest_of_today",
      description:
        "What is left of TODAY, hour by hour, in Indian Standard Time — the hours from now to midnight, the cleanest and dirtiest among them, and the day's overall level. Use for 'right now', 'this evening', 'later today', 'should I go out now'. Like forecast, each day has a mode: 'seasonal_normal' means the number is the seasonal average, not a prediction. Returns an error near midnight when too little of the day remains.",
      parameters: {
        type: "object",
        properties: { location: LOCATION_PARAM, pollutant: POLLUTANT_PARAM },
        required: ["location"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "history",
      description:
        "Daily averages for a place over a past window. Use for 'how was last week' or 'is it worse than last month'.",
      parameters: {
        type: "object",
        properties: {
          location: LOCATION_PARAM,
          pollutant: {
            type: "string",
            enum: ["pm25", "pm10", "no2", "so2"],
            description: "Measured pollutants only; composite AQI is not stored historically.",
          },
          days: { type: "integer", minimum: 1, maximum: 365, description: "Days back from today. Default 7." },
        },
        required: ["location"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "compare",
      description:
        "Compare two places over the same past window. Use for 'is Delhi worse than Mumbai'.",
      parameters: {
        type: "object",
        properties: {
          location_a: LOCATION_PARAM,
          location_b: LOCATION_PARAM,
          pollutant: {
            type: "string",
            enum: ["pm25", "pm10", "no2", "so2"],
          },
          days: { type: "integer", minimum: 1, maximum: 365, description: "Default 7." },
        },
        required: ["location_a", "location_b"],
      },
    },
  },
];

export const TOOL_NAMES = TOOL_DEFINITIONS.map((t) => t.function.name);

type ToolResult = Record<string, unknown>;

function notFound(location: string): ToolResult {
  return {
    error: "unknown_location",
    message: `No station or city matching "${location}". Known cities: Delhi NCR, Mumbai, Bangalore, Hyderabad, Chennai, Kolkata, Pune.`,
  };
}

/** Cap the fan-out: a city question must not become 73 station queries. */
function sample(loc: ResolvedLocation) {
  return loc.monitors.slice(0, MAX_STATIONS_PER_CITY_QUERY);
}

function daysAgo(n: number): string {
  return new Date(Date.parse(`${istToday()}T00:00:00Z`) - n * 86_400_000)
    .toISOString()
    .slice(0, 10);
}

export async function executeTool(
  supabase: SupabaseClient,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  switch (name) {
    case "current_aqi": {
      const loc = await resolveLocation(supabase, String(args.location ?? ""));
      if (!loc) return notFound(String(args.location ?? ""));
      const readings = (
        await Promise.all(sample(loc).map((m) => getCurrent(supabase, m)))
      ).filter((r): r is NonNullable<typeof r> => r !== null);
      if (!readings.length) {
        return { location: loc.label, error: "no_recent_data", message: "No readings held for this place." };
      }
      const aqi = meanAcross(readings.map((r) => r.aqi));
      const oldest = Math.max(...readings.map((r) => r.age_hours));
      return {
        location: loc.label,
        kind: loc.kind,
        stations_used: readings.length,
        aqi,
        // THE BAND NAME HAS TO COME FROM HERE. Handed a bare number, the model
        // reaches for the scale it knows best and answers "unhealthy" or
        // "unhealthy for sensitive groups" -- US EPA categories, which do not
        // exist on India's CPCB scale and do not match what every other screen
        // in the app shows for the same value. AQI 169 is "Moderate" here.
        band: aqi === null ? null : getAqiLabel(aqi),
        // Which pollutant drives the index surprises people: it is PM10 most
        // of the time in these cities, not PM2.5.
        dominant_pollutant: readings[0].dominant_pollutant,
        data_age_hours: oldest,
        caveat:
          oldest > 24
            ? `This reading is ${Math.round(oldest)} hours old, not live.`
            : null,
      };
    }

    case "forecast": {
      const loc = await resolveLocation(supabase, String(args.location ?? ""));
      if (!loc) return notFound(String(args.location ?? ""));
      const pollutant = (args.pollutant as string) ?? "aqi";
      const days = Math.min(7, Math.max(1, Number(args.days ?? 1)));
      const perStation = await Promise.all(
        sample(loc).map((m) => getForecast(supabase, m, pollutant, days)),
      );
      const usable = perStation.filter((d) => d.length);
      if (!usable.length) {
        return { location: loc.label, error: "no_forecast", message: "No forecast stored for this place yet." };
      }
      const byDay = [];
      for (let i = 0; i < days; i++) {
        const slice = usable.map((d) => d[i]).filter(Boolean);
        if (!slice.length) continue;
        // If ANY station is serving the seasonal normal, say so rather than
        // hiding it behind an average that looks like a prediction.
        const modes = new Set(slice.map((d) => d.mode));
        byDay.push({
          date: slice[0].target_date,
          value: meanAcross(slice.map((d) => d.value)),
          mode: modes.has("forecast")
            ? "forecast"
            : modes.has("outlook")
              ? "outlook"
              : "seasonal_normal",
          band_label: slice[0].band.label,
          data_age_days: slice[0].data_age_days,
        });
      }
      return { location: loc.label, pollutant, stations_used: usable.length, days: byDay };
    }

    case "best_hour": {
      const loc = await resolveLocation(supabase, String(args.location ?? ""));
      if (!loc) return notFound(String(args.location ?? ""));
      const pollutant = (args.pollutant as string) ?? "aqi";
      const forecasts = await Promise.all(
        sample(loc).map((m) => getForecast(supabase, m, pollutant, 1)),
      );
      const days = forecasts.map((f) => f[0]).filter(Boolean);
      if (!days.length) return { location: loc.label, error: "no_forecast" };
      if (days.every((d) => d.hourly_is_flat)) {
        return {
          location: loc.label,
          error: "no_hourly_profile",
          message:
            "No hourly profile has been fitted for this city and month, so every hour is the same. Do not recommend a time.",
        };
      }
      // Average the hourly curves across stations, then pick.
      const hours = Array.from({ length: 24 }, (_, h) =>
        meanAcross(days.map((d) => d.hourly?.[h]?.value ?? NaN)) ?? NaN,
      );
      const best = hours.indexOf(Math.min(...hours));
      const worst = hours.indexOf(Math.max(...hours));
      const stamp = (h: number) => toIstClock(`${days[0].target_date}T${String(h).padStart(2, "0")}:00:00+05:30`);
      return {
        location: loc.label,
        date: days[0].target_date,
        pollutant,
        cleanest_hour_ist: best,
        cleanest_clock: stamp(best),
        cleanest_value: hours[best],
        dirtiest_hour_ist: worst,
        dirtiest_clock: stamp(worst),
        dirtiest_value: hours[worst],
        timezone: "Asia/Kolkata",
      };
    }

    case "rest_of_today": {
      const loc = await resolveLocation(supabase, String(args.location ?? ""));
      if (!loc) return notFound(String(args.location ?? ""));
      const pollutant = (args.pollutant as string) ?? "aqi";
      const today = istToday();
      const forecasts = await Promise.all(
        sample(loc).map((m) => getForecast(supabase, m, pollutant, 1, { includeToday: true })),
      );
      // includeToday only guarantees today is not excluded; if the nightly job
      // has not run, the first row is still tomorrow. Match the date rather
      // than trusting the position, or "today" silently becomes tomorrow --
      // which is the exact failure this tool exists to fix.
      const days = forecasts.map((f) => f.find((d) => d.target_date === today)).filter(Boolean) as ForecastDay[];
      if (!days.length) {
        return {
          location: loc.label,
          error: "no_forecast_for_today",
          message: "There is no forecast row for today. Say so; do not answer with tomorrow's.",
        };
      }

      const nowHour = toIstHour(new Date());
      // Below this, "the rest of today" is a handful of sleeping hours and any
      // recommendation drawn from it would be a technicality.
      const MIN_HOURS_LEFT = 3;
      const hoursLeft = 24 - nowHour;
      if (hoursLeft < MIN_HOURS_LEFT) {
        return {
          location: loc.label,
          error: "day_nearly_over",
          now_hour_ist: nowHour,
          message: "Too little of today is left to advise on. Offer tomorrow instead.",
        };
      }

      const flat = days.every((d) => d.hourly_is_flat);
      const remaining = Array.from({ length: hoursLeft }, (_, i) => {
        const h = nowHour + i;
        const value = meanAcross(days.map((d) => d.hourly?.[h]?.value ?? NaN));
        return { hour_ist: h, clock: toIstClock(`${today}T${String(h).padStart(2, "0")}:00:00+05:30`), value };
      }).filter((x) => x.value !== null);

      if (!remaining.length) return { location: loc.label, error: "no_hourly_values" };

      const sorted = [...remaining].sort((a, b) => (a.value as number) - (b.value as number));
      const dayValue = meanAcross(days.map((d) => d.value));
      const withBand = (x: { hour_ist: number; clock: string; value: number | null }) =>
        pollutant === "aqi" && x.value !== null ? { ...x, band: getAqiLabel(x.value) } : x;
      return {
        location: loc.label,
        date: today,
        pollutant,
        now_hour_ist: nowHour,
        mode: days[0].mode,
        // Pass the headline through as well as the mode. The forecast tool
        // reliably gets the seasonal-normal disclosure right and this one did
        // not, and the difference between them was this string: given only
        // mode:'seasonal_normal' the model treats it as metadata, given the
        // sentence it repeats the point to the user.
        headline: days[0].headline,
        day_value: dayValue,
        day_band: dayValue === null || pollutant !== "aqi" ? null : getAqiLabel(dayValue),
        data_age_days: days[0].data_age_days,
        hours_remaining: remaining.length,
        hourly: remaining,
        // With a flat profile every hour is identical, so naming a "cleanest"
        // one would be picking noise and presenting it as advice.
        cleanest: flat ? null : withBand(sorted[0]),
        dirtiest: flat ? null : withBand(sorted[sorted.length - 1]),
        hourly_is_flat: flat,
        timezone: "Asia/Kolkata",
      };
    }

    case "history": {
      const loc = await resolveLocation(supabase, String(args.location ?? ""));
      if (!loc) return notFound(String(args.location ?? ""));
      const pollutant = (args.pollutant as string) ?? "pm25";
      const days = Math.min(365, Math.max(1, Number(args.days ?? 7)));
      const series = await Promise.all(
        sample(loc).map((m) => getHistory(supabase, m, pollutant, daysAgo(days), istToday())),
      );
      const flat = series.flat();
      if (!flat.length) return { location: loc.label, error: "no_history" };
      return {
        location: loc.label,
        pollutant,
        days_requested: days,
        days_with_data: new Set(flat.map((d) => d.date)).size,
        mean: meanAcross(flat.map((d) => d.mean)),
        min: Math.min(...flat.map((d) => d.min)),
        max: Math.max(...flat.map((d) => d.max)),
      };
    }

    case "compare": {
      const pollutant = (args.pollutant as string) ?? "pm25";
      const days = Math.min(365, Math.max(1, Number(args.days ?? 7)));
      const sides = await Promise.all(
        [args.location_a, args.location_b].map(async (raw) => {
          const loc = await resolveLocation(supabase, String(raw ?? ""));
          if (!loc) return { input: String(raw ?? ""), error: "unknown_location" as const };
          const series = (
            await Promise.all(
              sample(loc).map((m) => getHistory(supabase, m, pollutant, daysAgo(days), istToday())),
            )
          ).flat();
          return {
            location: loc.label,
            days_with_data: new Set(series.map((d) => d.date)).size,
            mean: meanAcross(series.map((d) => d.mean)),
          };
        }),
      );
      const [a, b] = sides;
      const bothHave = "mean" in a && "mean" in b && a.mean !== null && b.mean !== null;
      return {
        pollutant,
        days_requested: days,
        a,
        b,
        // Stated rather than left for the model to infer from two numbers.
        difference: bothHave ? Math.round(((a.mean as number) - (b.mean as number)) * 10) / 10 : null,
        // Uneven coverage makes a comparison misleading; flag it.
        uneven_coverage:
          bothHave && Math.abs((a.days_with_data ?? 0) - (b.days_with_data ?? 0)) > days * 0.3,
      };
    }

    default:
      return { error: "unknown_tool", message: `No tool named ${name}` };
  }
}
