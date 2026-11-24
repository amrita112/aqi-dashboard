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
  nearestMonitors,
  resolveLocation,
  getCurrentMany,
  getForecastMany,
  averageForecastDays,
  getHistoryMany,
  meanAcross,
  DataError,
  type HistoryPoint,
  type MonitorRow,
  type NearbyMonitor,
  type ResolvedLocation,
} from "@/lib/api/data";
import { resolveCity, minStationsOf } from "@/lib/api/place";
import type { ForecastDay } from "@/lib/api/forecast";
import { computeSubIndex, getAqiLabel } from "@/lib/aqi-utils";
import { istToday, toIstClock, toIstHour } from "@/lib/api/time";
import { searchNominatim } from "@/lib/api/nominatim";
import { NEAREST_K } from "@/lib/prefs";

const LOCATION_PARAM = {
  type: "string",
  description:
    "City or station name, e.g. 'Delhi', 'Mumbai', 'Bengaluru', or a specific station like 'Anand Vihar'.",
};

const POLLUTANT_PARAM = {
  type: "string",
  enum: ["aqi", "pm25"],
  description:
    "'aqi' is the composite 0-500 index. 'pm25' is the fine-particle concentration in ug/m3. Leave this out unless the person names one: the app then uses the measure they chose in their settings.",
};

/**
 * For history and compare, which also cover single pollutants.
 *
 * AQI IS INCLUDED. These used to say "composite AQI is not stored
 * historically", which was true once; it is now derived from the measured
 * pollutants (see getHistoryAqi). The stale line made the model refuse "how
 * was last week?" outright, without trying, for anyone reading AQI.
 */
const PAST_POLLUTANT_PARAM = {
  type: "string",
  enum: ["aqi", "pm25", "pm10", "no2", "so2"],
  description:
    "Leave this out unless the person names a measure or pollutant: the app then uses the measure they chose in their settings.",
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
        properties: { location: LOCATION_PARAM, pollutant: POLLUTANT_PARAM },
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
        "Tomorrow hour by hour for a place, in Indian Standard Time: the full 24-hour curve plus the cleanest and dirtiest hours. Use for 'when should I go out tomorrow' AND for any request to see or graph tomorrow's hourly values — the curve is charted for the reader automatically, so describe its shape and name the key hours rather than saying you cannot show a series. For today, this evening, or the next few hours, use rest_of_today instead. Returns nothing usable if no hourly profile has been fitted for that city and month.",
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
      name: "rank_places",
      description:
        "Rank the monitoring stations in or near a place from cleanest to dirtiest for TODAY. Use for 'where in Mumbai is best for a run' or 'which part of Delhi is cleanest' — open questions about a whole city. NOT for two places the person names ('Baner vs Hinjewadi'): use compare for that, because the named places usually have no station of their own and will not appear in this list. Returns station names with values, so you can name the actual places. Note that only places with a monitoring station can be ranked — if someone names a neighbourhood with no station, say so rather than guessing.",
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
          pollutant: PAST_POLLUTANT_PARAM,
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
        "Compare two places over one past window, as two averages. Use for ANY two places the person names against each other — 'Baner vs Hinjewadi', 'is Delhi worse than Mumbai this week' — including neighbourhoods with no station of their own, which are averaged over their nearest stations. Leave pollutant out unless they name one. It returns one number per place, NOT a trend: if the question is about how two places compare OVER TIME — day by day, or across the forecast — say that the Trends tab plots two places together and let them do that there, rather than reading out a series.",
      parameters: {
        type: "object",
        properties: {
          location_a: LOCATION_PARAM,
          location_b: LOCATION_PARAM,
          pollutant: PAST_POLLUTANT_PARAM,
          days: { type: "integer", minimum: 1, maximum: 365, description: "Default 7." },
        },
        required: ["location_a", "location_b"],
      },
    },
  },
];

export const TOOL_NAMES = TOOL_DEFINITIONS.map((t) => t.function.name);

type ToolResult = Record<string, unknown>;

/**
 * The place a tool argument refers to.
 *
 * Tries the named place first, so "Mumbai" still means Mumbai. Falls back to
 * the person's own coordinates when the name resolves to nothing — which is
 * the common case for a neighbourhood with no station of its own, and exactly
 * the case the home screen already handles by averaging the nearest three.
 */
async function resolveFor(
  supabase: SupabaseClient,
  text: string,
  ctx: AskContext,
): Promise<ResolvedLocation | null> {
  const asked = text.trim();
  const named = asked ? await resolveLocation(supabase, asked) : null;
  // A CITY means the whole city: every active monitoring station filed under
  // it, the same stations the app's city average uses (resolveCity). This
  // used to answer from the first 8 stations in table order -- not even the
  // central ones -- and on 23 Nov 2026 it answered "no history" for Delhi
  // NCR's last 30 days of PM2.5, while the app charted 26 of them.
  if (named?.kind === "city") {
    const pool = await resolveCity(supabase, named.city);
    return { ...named, monitors: pool.monitors };
  }
  if (named) return named;

  // THE PERSON'S OWN PLACE, by name or by leaving the location out.
  const own = typeof ctx.latitude === "number" && typeof ctx.longitude === "number";
  if (own && (!asked || isOwnPlace(asked, ctx))) {
    return pointNear(supabase, ctx.latitude!, ctx.longitude!, asked || ctx.label, ctx.city);
  }
  if (!asked) return null;

  // ANYWHERE ELSE THEY NAMED, looked up the way the search box does.
  //
  // This used to fall back to the person's OWN coordinates for any name it
  // did not recognise. So "Baner vs Hinjewadi" from someone in Baner either
  // failed outright (compare had no fallback at all, and the model told them
  // Hinjewadi was outside the covered cities) or, in the other tools, would
  // have reported Baner's numbers under Hinjewadi's name.
  //
  // Near the person first, so "Sector 5" means the one in their city; then
  // anywhere in India, for a neighbourhood in another covered city.
  const near = own ? { lat: ctx.latitude!, lng: ctx.longitude! } : null;
  let hits = near ? await searchNominatim(asked, near) : [];
  if (!hits.length) hits = await searchNominatim(asked, null);
  for (const hit of hits.slice(0, 3)) {
    // nearestMonitors stops at its own distance cap, so a place outside the
    // covered cities finds nothing here and falls through to "not found".
    const found = await pointNear(supabase, hit.latitude, hit.longitude, asked, null);
    if (found) return found;
  }
  return null;
}

/**
 * Whether a name is the person's own place: "Baner" when they set up
 * "Baner, Pune", or words like "home" and "my area".
 */
function isOwnPlace(asked: string, ctx: AskContext): boolean {
  const norm = (t: string) => t.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const a = norm(asked);
  if (/^(here|home|my (area|place|home|location|neighbourhood|neighborhood)|near me)$/.test(a)) {
    return true;
  }
  const mine = norm(ctx.label ?? "");
  return Boolean(mine) && (mine.includes(a) || a.includes(mine));
}

/** The stations nearest a point, as the home screen picks them: the three nearest. */
async function pointNear(
  supabase: SupabaseClient,
  lat: number,
  lng: number,
  label: string | undefined,
  city: string | undefined | null,
): Promise<ResolvedLocation | null> {
  const monitors = await nearestMonitors(supabase, lat, lng, NEAREST_K);
  if (!monitors.length) return null;
  return {
    kind: "point",
    city: city ?? monitors[0].city,
    // Named as the person named it, so the answer says "Mayur Vihar" rather
    // than the nearest CPCB site, which they did not ask about.
    label: label?.trim() || monitors[0].name,
    monitors,
  };
}

function notFound(location: string): ToolResult {
  return {
    error: "unknown_location",
    message: `Could not find "${location}" in or near the covered cities: Delhi NCR, Mumbai, Bangalore, Hyderabad, Chennai, Kolkata, Pune. If it sounds like a place in one of them, ask the person for a nearby landmark or PIN code rather than saying it is not covered.`,
  };
}

/**
 * rank_places on a whole city ranks EVERY station (Delhi NCR: 79), but a list
 * that long would cost tokens and draw an unreadable bar chart. Above this
 * many, `all` holds only the RANK_EACH_END cleanest and dirtiest.
 */
const RANK_LIST_ALL_UP_TO = 12;
const RANK_EACH_END = 5;

/** Each station's forecast days, in the location's station order. */
async function forecastsFor(
  supabase: SupabaseClient,
  monitors: MonitorRow[],
  pollutant: string,
  days: number,
  opts: { includeToday?: boolean } = {},
): Promise<ForecastDay[][]> {
  const byStation = await getForecastMany(supabase, monitors, pollutant, days, opts);
  return monitors.map((m) => byStation.get(m.id) ?? []);
}

/**
 * The stations in the shape averageForecastDays wants.
 *
 * averageForecastDays wants each station's distance, only to list the
 * contributing stations nearest first; these tools report just a count, so a
 * missing distance (a whole-city lookup has none) is filled with 0.
 */
function withDistances(monitors: MonitorRow[], perStation: ForecastDay[][]) {
  return monitors.map((m, i) => ({
    monitor: { ...m, distance_km: (m as Partial<NearbyMonitor>).distance_km ?? 0 },
    days: perStation[i],
  }));
}

/** averageForecastDays is asked for exactly one day by the two hourly tools. */
const ONE_DAY = 1;

/**
 * ONE DAY averaged across stations EXACTLY as the app's forecast chart does it.
 *
 * best_hour and rest_of_today each answer about a single date (tomorrow's
 * earliest row, or today). Each station's rows are cut down to that date
 * first, so averageForecastDays cannot pick a different "first day", and then
 * the app's own function does the averaging. That function leaves out any
 * station that only has a seasonal estimate ("seasonal_normal", the long-run
 * average for the date) whenever another station has a real forecast, and
 * labels the result "seasonal_normal" only when none does. The hourly curve,
 * the day value, the mode and the headline therefore match the chart.
 *
 * Returns null when no station has a row for that date.
 */
function averageOneDay(
  monitors: MonitorRow[],
  perStation: ForecastDay[][],
  pollutant: string,
  date: string,
): { day: ForecastDay; stationsUsed: number } | null {
  const onDate = perStation.map((days) => days.filter((d) => d.target_date === date));
  const averaged = averageForecastDays(withDistances(monitors, onDate), ONE_DAY, pollutant);
  if (!averaged || !averaged.value.length) return null;
  return { day: averaged.value[0], stationsUsed: averaged.stations.length };
}

/** Each station's daily history, in the location's station order. */
async function historiesFor(
  supabase: SupabaseClient,
  monitors: MonitorRow[],
  pollutant: string,
  from: string,
  to: string,
): Promise<HistoryPoint[][]> {
  const byStation = await getHistoryMany(supabase, monitors, pollutant, from, to);
  return monitors.map((m) => byStation.get(m.id) ?? []);
}

function daysAgo(n: number): string {
  return new Date(Date.parse(`${istToday()}T00:00:00Z`) - n * 86_400_000)
    .toISOString()
    .slice(0, 10);
}

/** "10 Oct" — unambiguous next to a weekday or the word "tomorrow". */
function humanDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return iso;
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${Number(m[3])} ${months[Number(m[2]) - 1]}`;
}

/** "today" / "tomorrow" / "Saturday", computed here rather than inferred. */
function describeDay(iso: string): string {
  const today = istToday();
  if (iso === today) return "today";
  const t = Date.parse(`${today}T00:00:00+05:30`);
  const d = Date.parse(`${iso}T00:00:00+05:30`);
  const days = Math.round((d - t) / 86_400_000);
  if (days === 1) return "tomorrow";
  if (days === 2) return "the day after tomorrow";
  return new Date(`${iso}T12:00:00+05:30`).toLocaleDateString("en-IN", { weekday: "long" });
}

/** Enough to show a shape; few enough not to dominate the prompt. */
const MAX_SERIES_POINTS = 30;

/**
 * One value per calendar day, evenly thinned to at most `cap` points.
 *
 * Thinned by stride rather than truncated, so a 90-day request still shows the
 * whole 90 days instead of its first month.
 */
/**
 * A city's history, keeping only days when enough of its stations reported.
 *
 * WHY. Only complete days count (readings_daily.is_complete), so on a day when
 * OpenAQ lost hours for most stations, a "Mumbai average" could rest on one
 * station -- and on 18 Oct 2026 that one station read 297 µg/m³ against ~60
 * elsewhere, which an answer then charted as a city-wide spike. Trends already
 * drops such days for city views (CITY_MIN_REPORTING_SHARE); this applies the
 * same rule here. Points and named stations are not filtered, as on Trends:
 * they describe a neighbourhood, not a city.
 *
 * The minimum is 10% of the city's stations, which are now exactly the
 * stations asked (loc.monitors, from resolveCity) -- the same pool on both
 * sides of the rule, as on Trends.
 */
export function wellCoveredHistory(
  loc: ResolvedLocation,
  perStation: HistoryPoint[][],
): { rows: HistoryPoint[]; daysDropped: number } {
  const rows = perStation.flat();
  if (loc.kind !== "city") return { rows, daysDropped: 0 };
  const need = minStationsOf(loc.monitors.length);
  const stationsOn = new Map<string, number>();
  for (const series of perStation) {
    for (const d of Array.from(new Set(series.map((p) => p.date)))) {
      stationsOn.set(d, (stationsOn.get(d) ?? 0) + 1);
    }
  }
  const keep = new Set(Array.from(stationsOn.entries()).filter(([, n]) => n >= need).map(([d]) => d));
  return {
    rows: rows.filter((p) => keep.has(p.date)),
    daysDropped: stationsOn.size - keep.size,
  };
}

function dailySeries(
  rows: { date: string; mean: number | null }[],
  cap: number,
): { date: string; value: number }[] {
  const byDate = new Map<string, number[]>();
  for (const r of rows) {
    if (r.mean === null || !Number.isFinite(r.mean)) continue;
    const arr = byDate.get(r.date) ?? [];
    arr.push(r.mean);
    byDate.set(r.date, arr);
  }
  const daily = Array.from(byDate.entries())
    .sort((x, y) => x[0].localeCompare(y[0]))
    .map(([date, vals]: [string, number[]]) => ({
      date,
      value: Math.round((vals.reduce((sum: number, v: number) => sum + v, 0) / vals.length) * 10) / 10,
    }));
  if (daily.length <= cap) return daily;
  const stride = Math.ceil(daily.length / cap);
  return daily.filter((_, i) => i % stride === 0);
}

/**
 * Who is asking, and from where.
 *
 * WITHOUT THIS THE TOOLS ONLY KNEW TEXT. "Which hours are cleanest in Mayur
 * Vihar?" was declined, because Mayur Vihar has no monitoring station and
 * resolveLocation matches only city and station names — while the person
 * asking had dropped a pin there at setup and the app was already showing them
 * a number for it, averaged over the three nearest stations. Declining to
 * answer a question about the place you are standing in, which the home screen
 * answers, is the kind of inconsistency that makes the whole thing feel broken.
 *
 * It also carries the chosen measure, so `history` stops defaulting to PM2.5
 * for someone reading AQI everywhere else.
 */
export interface AskContext {
  latitude?: number;
  longitude?: number;
  /** What the person calls the place, e.g. "Mayur Vihar Delhi". */
  label?: string;
  city?: string;
  measurement?: string;
  /**
   * True when the question itself names AQI or PM2.5. Only then may the
   * model's own choice of measure override the person's setting.
   */
  measurementNamed?: boolean;
}

/**
 * Whether a question asks for AQI or PM2.5 by name ("pm2.5", "PM 2.5", "pm25",
 * "AQI"). Lives here, not in the ask route, because Next.js refuses extra
 * exports from a route file.
 */
export function namesMeasure(question: string): boolean {
  const asked = question.split("\n\n(I am in")[0];
  return /\baqi\b|\bpm\s*2\.?5\b/i.test(asked);
}

/**
 * Which measure a tool should report: the person's setting, unless they asked
 * for the other one in so many words.
 *
 * WHY NOT JUST THE MODEL'S ARGUMENT. `pollutant` is optional, but the model
 * fills it in anyway, and it reaches for "aqi" — the word it has seen most.
 * Someone who chose PM2.5 then got AQI charts for every question, because an
 * explicit argument beat the setting. Other pollutants (PM10, NO2) are never
 * overridden: asking for those is always deliberate.
 */
export function measureFor(args: Record<string, unknown>, ctx: AskContext): string {
  const asked = typeof args.pollutant === "string" ? args.pollutant : undefined;
  const isMeasure = asked === undefined || asked === "aqi" || asked === "pm25";
  if (ctx.measurement && isMeasure && !ctx.measurementNamed) return ctx.measurement;
  return asked ?? ctx.measurement ?? "aqi";
}

/**
 * What the numbers in a result ARE, in words the model can copy.
 *
 * THE MODEL LABELLED PM2.5 AS AQI. Asked "cleanest station in Mumbai right
 * now?" with the setting on PM2.5, it passed pollutant "aqi", the setting
 * rightly overrode that (see measureFor), the data came back in µg/m³ — and
 * the sentence still said "an AQI of 63". It names the number after what it
 * ASKED for, not what came back; a bare `pollutant: "pm25"` field was not
 * enough to correct it. A sentence first in the result is.
 */
const VALUES_ARE: Record<string, string> = {
  pm25: "PM2.5 concentrations in µg/m³, NOT AQI. Call them PM2.5 and give the unit µg/m³.",
  aqi: "AQI values on the CPCB 0-500 scale. Call them AQI; they have no unit.",
};

export async function executeTool(
  supabase: SupabaseClient,
  name: string,
  args: Record<string, unknown>,
  ctx: AskContext = {},
): Promise<ToolResult> {
  let result: ToolResult;
  try {
    result = await runTool(supabase, name, args, ctx);
  } catch (err) {
    // THE DATABASE COULD NOT BE READ, which is not the same as "no data".
    // Caught here, once, for every tool: before, a failed history read came
    // back as an empty series and the tool reported `no_history`, so the model
    // told the person nothing had been measured. The model gets a distinct
    // error to relay; the raw database error goes to the server log only.
    if (!(err instanceof DataError)) throw err;
    console.error(`[tool ${name}] ${err.message}:`, err.detail);
    return {
      error: "data_unavailable",
      message:
        "The air-quality database could not be read just now. Say so plainly and suggest trying again in a few minutes. Do not say that nothing was measured.",
    };
  }
  const valuesAre = typeof result.pollutant === "string" ? VALUES_ARE[result.pollutant] : undefined;
  // First in the object, so it is read before any number.
  return valuesAre ? { values_are: valuesAre, ...result } : result;
}

async function runTool(
  supabase: SupabaseClient,
  name: string,
  args: Record<string, unknown>,
  ctx: AskContext,
): Promise<ToolResult> {
  switch (name) {
    case "current_aqi": {
      const loc = await resolveFor(supabase, String(args.location ?? ""), ctx);
      if (!loc) return notFound(String(args.location ?? ""));
      // One request for every station (getCurrentMany), not two per station.
      const current = await getCurrentMany(supabase, loc.monitors);
      const readings = loc.monitors
        .map((m) => current.get(m.id) ?? null)
        .filter((r): r is NonNullable<typeof r> => r !== null);
      if (!readings.length) {
        return { location: loc.label, error: "no_recent_data", message: "No readings held for this place." };
      }
      // IN THE PERSON'S OWN MEASURE. This tool used to return the AQI only,
      // so someone reading PM2.5 everywhere else was told "AQI 169" for
      // "what is it like now". Each reading already carries its PM2.5
      // concentration; the index is just the larger number made from it.
      const pollutant = measureFor(args, ctx);
      const pm25 =
        pollutant === "pm25"
          ? meanAcross(
              readings.map((r) => r.pollutants.find((p) => p.pollutant === "pm25")?.value ?? NaN),
            )
          : null;
      const value = pollutant === "pm25" ? pm25 : meanAcross(readings.map((r) => r.aqi));
      const oldest = Math.max(...readings.map((r) => r.age_hours));
      return {
        location: loc.label,
        kind: loc.kind,
        stations_used: readings.length,
        pollutant,
        value,
        unit: pollutant === "pm25" ? "ug/m3" : "CPCB AQI (0-500)",
        // THE BAND NAME HAS TO COME FROM HERE. Handed a bare number, the model
        // reaches for the scale it knows best and answers "unhealthy" or
        // "unhealthy for sensitive groups" -- US EPA categories, which do not
        // exist on India's CPCB scale and do not match what every other screen
        // in the app shows for the same value. AQI 169 is "Moderate" here.
        // A PM2.5 concentration is banded by its sub-index: the same six
        // bands, at the 30/60/90/120/250 µg/m³ breakpoints.
        band:
          value === null
            ? null
            : getAqiLabel(pollutant === "pm25" ? computeSubIndex("pm25", value) : value),
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
      const loc = await resolveFor(supabase, String(args.location ?? ""), ctx);
      if (!loc) return notFound(String(args.location ?? ""));
      const pollutant = measureFor(args, ctx);
      const days = Math.min(7, Math.max(1, Number(args.days ?? 1)));
      const perStation = await forecastsFor(supabase, loc.monitors, pollutant, days);

      // THE APP'S OWN AVERAGING, so the answer and the forecast chart cannot
      // disagree. This tool used to average the stations itself and kept
      // every one of them, including stations that only had a seasonal
      // estimate ("seasonal_normal", the long-run average for the date). The
      // chart (/api/forecast) drops those whenever a neighbour has a real
      // forecast, because blending the long-run average in pulls tomorrow's
      // prediction toward "a typical day". Calling the same function, on the
      // same rows (getForecastMany, which already expands each row with
      // expandDay exactly as the chart's route does), gives the same numbers.
      const averaged = averageForecastDays(withDistances(loc.monitors, perStation), days, pollutant);
      if (!averaged) {
        return { location: loc.label, error: "no_forecast", message: "No forecast stored for this place yet." };
      }

      // The SAME compact shape as before, so the model's prompt does not grow:
      // one entry per day, the hourly curve as 24 rounded numbers.
      const byDay = averaged.value.map((d) => ({
        date: d.target_date,
        date_label: `${describeDay(d.target_date)} (${humanDate(d.target_date)})`,
        value: d.value,
        band: pollutant === "aqi" ? getAqiLabel(d.value) : null,
        // Averaged across the same stations as `value`. Carried so the chart
        // can show the within-day swing, which is the half of the model a
        // daily line throws away -- these cities move by a factor of two
        // inside a day. The model is told not to recite it.
        hourly: Array.from({ length: 24 }, (_, hour) => {
          const v = d.hourly?.[hour]?.value;
          return v === null || v === undefined || !Number.isFinite(v) ? null : Math.round(v);
        }),
        // "seasonal_normal" only when NO station had a real forecast for this
        // day; then the number is the seasonal average and the model must say
        // so (see the tool description).
        mode: d.mode,
        // The band of the AVERAGED value (audit §6.3), recomputed by
        // averageForecastDays on the app's scale.
        band_label: d.band.label,
        // Averaged over the contributing stations, as the app's chart and its
        // data-quality note do, so both describe the same input age.
        data_age_days: d.data_age_days,
      }));
      // The stations that actually fed the numbers: a seasonal-only station
      // that was left out is not counted.
      return { location: loc.label, pollutant, stations_used: averaged.stations.length, days: byDay };
    }

    case "best_hour": {
      const loc = await resolveFor(supabase, String(args.location ?? ""), ctx);
      if (!loc) return notFound(String(args.location ?? ""));
      const pollutant = measureFor(args, ctx);
      const forecasts = await forecastsFor(supabase, loc.monitors, pollutant, 1);
      // Every station's row for the SAME day -- the earliest any of them has.
      // Taking each station's first row mixed days when one lacked a row.
      const firstDate = forecasts
        .map((f) => f[0]?.target_date)
        .filter((d): d is string => Boolean(d))
        .sort()[0];
      // THE APP'S OWN AVERAGING for that day (see averageOneDay). This used to
      // average every station's curve itself, seasonal-only ones included, and
      // so could name a different cleanest hour than the chart shows.
      const averaged = firstDate ? averageOneDay(loc.monitors, forecasts, pollutant, firstDate) : null;
      if (!averaged) return { location: loc.label, error: "no_forecast" };
      const { day, stationsUsed } = averaged;
      // Flat only if every CONTRIBUTING station is flat, as on the chart.
      if (day.hourly_is_flat) {
        return {
          location: loc.label,
          error: "no_hourly_profile",
          message:
            "No hourly profile has been fitted for this city and month, so every hour is the same. Do not recommend a time.",
        };
      }
      // The averaged hourly curve (already averaged across the contributing
      // stations), then pick.
      const hours = Array.from({ length: 24 }, (_, h) => day.hourly?.[h]?.value ?? NaN);
      const best = hours.indexOf(Math.min(...hours));
      const worst = hours.indexOf(Math.max(...hours));
      const stamp = (h: number) => toIstClock(`${day.target_date}T${String(h).padStart(2, "0")}:00:00+05:30`);
      return {
        location: loc.label,
        date: day.target_date,
        pollutant,
        // Only the stations that fed the numbers; a seasonal-only station that
        // was left out is not counted.
        stations_used: stationsUsed,
        // The WHOLE day, so the answer can be shown as a curve. "3 pm is
        // cleanest" is not actionable on its own: the reader needs to see
        // whether the clean window lasts an hour or five, and how much worse
        // the alternatives are.
        hourly: hours.map((value, hour) => ({
          hour,
          clock: stamp(hour),
          value: Number.isFinite(value) ? Math.round(value) : null,
        })),
        // THE DATE SPELLED OUT, because the model wrote "tomorrow (9 Oct)"
        // while using the 10 Oct numbers. Given only an ISO string next to the
        // word "tomorrow" in its own prompt, it reached for the wrong one.
        date_label: `${describeDay(day.target_date)} (${humanDate(day.target_date)})`,
        cleanest_hour_ist: best,
        cleanest_clock: stamp(best),
        cleanest_value: Math.round(hours[best]),
        // BANDS FROM OUR SCALE. Without them the model labelled an AQI of 74
        // "Moderate", which is the US scale; on CPCB 74 is Satisfactory, and
        // that is what every other screen shows for the same number.
        cleanest_band: pollutant === "aqi" ? getAqiLabel(hours[best]) : null,
        dirtiest_hour_ist: worst,
        dirtiest_clock: stamp(worst),
        dirtiest_value: Math.round(hours[worst]),
        dirtiest_band: pollutant === "aqi" ? getAqiLabel(hours[worst]) : null,
        timezone: "Asia/Kolkata",
      };
    }

    case "rest_of_today": {
      const loc = await resolveFor(supabase, String(args.location ?? ""), ctx);
      if (!loc) return notFound(String(args.location ?? ""));
      const pollutant = measureFor(args, ctx);
      const today = istToday();
      const forecasts = await forecastsFor(supabase, loc.monitors, pollutant, 1, { includeToday: true });
      // includeToday only guarantees today is not excluded; if the nightly job
      // has not run, the first row is still tomorrow. Match the date rather
      // than trusting the position, or "today" silently becomes tomorrow --
      // which is the exact failure this tool exists to fix.
      //
      // Then THE APP'S OWN AVERAGING for today (see averageOneDay). This used
      // to average every station, seasonal-only ones included, and took the
      // first station's mode and headline, so a real forecast could be
      // labelled a seasonal estimate or the other way round.
      const averaged = averageOneDay(loc.monitors, forecasts, pollutant, today);
      if (!averaged) {
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
          message:
            "Too little of today is left to advise on. Do NOT answer with that alone: call current_aqi for the most recent measured reading and give it with its age, and offer tomorrow via best_hour.",
        };
      }

      const { day, stationsUsed } = averaged;
      const flat = day.hourly_is_flat;
      const remaining = Array.from({ length: hoursLeft }, (_, i) => {
        const h = nowHour + i;
        const v = day.hourly?.[h]?.value;
        const value = v === undefined || v === null || !Number.isFinite(v) ? null : v;
        return { hour_ist: h, clock: toIstClock(`${today}T${String(h).padStart(2, "0")}:00:00+05:30`), value };
      }).filter((x) => x.value !== null);

      if (!remaining.length) return { location: loc.label, error: "no_hourly_values" };

      const sorted = [...remaining].sort((a, b) => (a.value as number) - (b.value as number));
      const dayValue = Number.isFinite(day.value) ? day.value : null;
      const withBand = (x: { hour_ist: number; clock: string; value: number | null }) =>
        pollutant === "aqi" && x.value !== null ? { ...x, band: getAqiLabel(x.value) } : x;
      return {
        location: loc.label,
        date: today,
        pollutant,
        // Only the stations that fed the numbers, as in best_hour.
        stations_used: stationsUsed,
        now_hour_ist: nowHour,
        // "seasonal_normal" only when NO station had a real forecast for today.
        mode: day.mode,
        // Pass the headline through as well as the mode. The forecast tool
        // reliably gets the seasonal-normal disclosure right and this one did
        // not, and the difference between them was this string: given only
        // mode:'seasonal_normal' the model treats it as metadata, given the
        // sentence it repeats the point to the user.
        headline: day.headline,
        day_value: dayValue,
        day_band: dayValue === null || pollutant !== "aqi" ? null : getAqiLabel(dayValue),
        // Averaged over the contributing stations, as on the chart.
        data_age_days: day.data_age_days,
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

    case "rank_places": {
      const loc = await resolveFor(supabase, String(args.location ?? ""), ctx);
      if (!loc) return notFound(String(args.location ?? ""));
      const pollutant = measureFor(args, ctx);
      const today = istToday();
      // EVERY station of the place: a whole city is ranked in full (it used
      // to be the first 8 stations in table order, so most of Delhi NCR could
      // never be named as cleanest or dirtiest).
      const picks = loc.monitors;
      const days = await forecastsFor(supabase, picks, pollutant, 1, { includeToday: true });
      const ranked: { station: string; value: number; band: string | null; mode: string }[] = [];
      picks.forEach((m, i) => {
        const d = days[i].find((x) => x.target_date === today) ?? days[i][0];
        if (d && typeof d.value === "number") {
          ranked.push({
            station: m.name,
            value: Math.round(d.value),
            band: pollutant === "aqi" ? getAqiLabel(d.value) : null,
            mode: d.mode,
          });
        }
      });
      if (ranked.length < 2) {
        return {
          location: loc.label,
          error: "not_enough_stations",
          message: `Only ${ranked.length} station here has a value for today, so there is nothing to rank.`,
        };
      }
      ranked.sort((a, b) => a.value - b.value);
      return {
        location: loc.label,
        date: today,
        pollutant,
        stations_ranked: ranked.length,
        // Both ends, not the whole list: a two-sentence answer names the best
        // and the worst, and twenty rows of middle would only cost tokens.
        cleanest: ranked.slice(0, 3),
        dirtiest: ranked.slice(-3).reverse(),
        // The whole ranking for a few stations; for a big city only both ends
        // (see RANK_LIST_ALL_UP_TO), cleanest first either way.
        all:
          ranked.length <= RANK_LIST_ALL_UP_TO
            ? ranked
            : [...ranked.slice(0, RANK_EACH_END), ...ranked.slice(-RANK_EACH_END)],
        all_is:
          ranked.length <= RANK_LIST_ALL_UP_TO
            ? "every ranked station"
            : `the ${RANK_EACH_END} cleanest and the ${RANK_EACH_END} dirtiest of ${ranked.length} stations`,
        note: "Only places with a monitoring station appear here. A neighbourhood with no station cannot be ranked.",
      };
    }

    case "history": {
      const loc = await resolveFor(supabase, String(args.location ?? ""), ctx);
      if (!loc) return notFound(String(args.location ?? ""));
      // Follows the person's own setting rather than defaulting to PM2.5,
      // which is why "compare with last week" reported no AQI data for
      // someone reading AQI on every other screen.
      const pollutant = measureFor(args, ctx);
      const days = Math.min(365, Math.max(1, Number(args.days ?? 7)));
      const series = await historiesFor(supabase, loc.monitors, pollutant, daysAgo(days), istToday());
      const { rows: flat, daysDropped } = wellCoveredHistory(loc, series);
      if (!flat.length) return { location: loc.label, error: "no_history" };
      const mean = meanAcross(flat.map((d) => d.mean));
      return {
        location: loc.label,
        pollutant,
        days_requested: days,
        days_with_data: new Set(flat.map((d) => d.date)).size,
        // Days left out because too few of the city's stations had a complete
        // day -- an average of one or two stations does not describe a city.
        days_left_out_for_low_coverage: daysDropped,
        mean,
        // The category of the average, worked out here. Without it the model
        // named one itself and got it wrong: an AQI average of 133 came back
        // as "Poor", when 101-200 is Moderate.
        band: pollutant === "aqi" && mean !== null ? getAqiLabel(mean) : null,
        // Whole numbers, as everywhere else: "3.98-269.57" was being read out.
        min: Math.round(Math.min(...flat.map((d) => d.min))),
        max: Math.round(Math.max(...flat.map((d) => d.max))),
        // A short daily series so the answer can be shown as a chart. Capped
        // and down-sampled rather than returned whole: a year of history is 365
        // numbers, which would cost more tokens than the rest of the request
        // and tell the model nothing the mean/min/max do not already say.
        series: dailySeries(flat, MAX_SERIES_POINTS),
      };
    }

    case "compare": {
      // Follows the person's own setting rather than defaulting to PM2.5,
      // which is why "compare with last week" reported no AQI data for
      // someone reading AQI on every other screen.
      const pollutant = measureFor(args, ctx);
      const days = Math.min(365, Math.max(1, Number(args.days ?? 7)));
      const sides = await Promise.all(
        [args.location_a, args.location_b].map(async (raw) => {
          const loc = await resolveFor(supabase, String(raw ?? ""), ctx);
          if (!loc) return { input: String(raw ?? ""), error: "unknown_location" as const };
          const { rows: series } = wellCoveredHistory(
            loc,
            await historiesFor(supabase, loc.monitors, pollutant, daysAgo(days), istToday()),
          );
          const mean = meanAcross(series.map((d) => d.mean));
          return {
            location: loc.label,
            days_with_data: new Set(series.map((d) => d.date)).size,
            mean,
            // Named here for the same reason as in history: left to itself the
            // model picks the wrong category.
            band: pollutant === "aqi" && mean !== null ? getAqiLabel(mean) : null,
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
