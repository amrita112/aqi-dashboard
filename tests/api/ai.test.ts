/**
 * The AI box's guardrails.
 *
 * The model is not tested here — it is a hosted service and its wording will
 * vary. What IS tested is everything around it, because that is what stops a
 * plausible sentence from carrying an invented number:
 *
 *   - the tool contract the model is handed
 *   - the executors, which are the only source of figures
 *   - the provider client's failure handling, especially quota exhaustion
 *
 * A fake `fetch` stands in for the provider, so these run offline and cost
 * nothing — which is rather the point of the whole design.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { TOOL_DEFINITIONS, TOOL_NAMES, executeTool, measureFor, namesMeasure } from "@/lib/ai/tools";
import {
  chat,
  aiConfig,
  AiProviderError,
  DEFAULT_BASE_URL,
  DEFAULT_MODEL,
  undouble,
} from "@/lib/ai/provider";
import {
  resolveLocation,
  meanAcross,
  getForecastMany,
  averageForecastDays,
  type MonitorRow,
} from "@/lib/api/data";
import { searchNominatim } from "@/lib/api/nominatim";

// Never the real geocoder from a test: no network, no load on a free service.
// Each test says what the lookup should find; by default, nothing.
vi.mock("@/lib/api/nominatim", () => ({ searchNominatim: vi.fn(async () => []) }));

/**
 * A Supabase stand-in returning canned rows for the tables we touch.
 *
 * Filters are ignored, with one exception: the current reading is read from
 * `monitors` with each station's readings (and their measurements) NESTED in
 * it (getCurrentMany), so a select naming `readings(` gets every monitor row
 * with the canned readings and measurements attached.
 */
function fakeSupabase(tables: Record<string, unknown[]>) {
  const builder = (t: string) => {
    let columns = "";
    const chain: Record<string, unknown> = {};
    const self = () => chain;
    for (const m of ["eq", "in", "gt", "gte", "lte", "not", "is", "order", "limit", "range"]) {
      chain[m] = vi.fn(self);
    }
    chain.select = vi.fn((c: string) => ((columns = c ?? ""), chain));
    // Awaiting the builder resolves to the rows, as postgrest-js does.
    (chain as { then: unknown }).then = (resolve: (v: unknown) => unknown) => {
      let rows = tables[t] ?? [];
      if (t === "monitors" && columns.includes("readings(")) {
        const measurements = (tables.measurements ?? []) as { reading_id: string }[];
        const readings = ((tables.readings ?? []) as { id: string }[]).map((r) => ({
          ...r,
          measurements: measurements.filter((m) => m.reading_id === r.id),
        }));
        rows = (rows as Record<string, unknown>[]).map((m) => ({ ...m, readings }));
      }
      return resolve({ data: rows, error: null });
    };
    return chain;
  };
  return {
    from: (t: string) => builder(t),
    // nearest_monitors, as the RPC returns it: canned under that name.
    rpc: async () => ({ data: tables.nearest_monitors ?? [], error: null }),
  } as never;
}

const DELHI_MONITORS = [
  { id: "a1", name: "Anand Vihar", city: "Delhi NCR", latitude: 28.6, longitude: 77.3 },
  { id: "a2", name: "R K Puram", city: "Delhi NCR", latitude: 28.5, longitude: 77.1 },
];

describe("tool contract", () => {
  it("exposes exactly the seven agreed tools", () => {
    expect(TOOL_NAMES.sort()).toEqual(
      ["best_hour", "compare", "current_aqi", "forecast", "history", "rank_places",
       "rest_of_today"].sort(),
    );
  });

  it("keeps best_hour and rest_of_today distinguishable to the model", () => {
    // These two are the pair most easily confused, and confusing them is how
    // "should I run this evening" got answered with TOMORROW's cleanest hour.
    // Each description has to name its own day unambiguously.
    const byName = Object.fromEntries(
      TOOL_DEFINITIONS.map((t) => [t.function.name, t.function.description]),
    );
    // Case-insensitive, and no assertion that best_hour avoids the word
    // "today": it legitimately uses it to point at rest_of_today, which is the
    // handoff this test exists to protect.
    expect(byName.best_hour).toMatch(/tomorrow/i);
    expect(byName.best_hour.toLowerCase()).toContain("rest_of_today");
    expect(byName.rest_of_today).toMatch(/today/i);
  });

  it("gives every tool a description and a typed parameter schema", () => {
    for (const t of TOOL_DEFINITIONS) {
      expect(t.type).toBe("function");
      expect(t.function.description.length).toBeGreaterThan(20);
      expect(t.function.parameters).toHaveProperty("type", "object");
      expect(t.function.parameters).toHaveProperty("required");
    }
  });

  it("warns the model about seasonal_normal in the forecast tool description", () => {
    // The single most important thing the model must not do is call the
    // seasonal average a forecast.
    const forecast = TOOL_DEFINITIONS.find((t) => t.function.name === "forecast")!;
    expect(forecast.function.description).toMatch(/seasonal_normal/);
    expect(forecast.function.description).toMatch(/not call it a forecast|do not call it/i);
  });

  it("warns the model that readings lag", () => {
    const current = TOOL_DEFINITIONS.find((t) => t.function.name === "current_aqi")!;
    expect(current.function.description).toMatch(/17-24 hours|behind/i);
  });
});

describe("resolveLocation", () => {
  const supabase = fakeSupabase({ monitors: DELHI_MONITORS });

  it("matches a city, and prefers it over a station name", async () => {
    const loc = await resolveLocation(supabase, "Delhi");
    expect(loc?.kind).toBe("city");
    expect(loc?.monitors).toHaveLength(2);
  });

  it("tolerates the NCR suffix people leave off", async () => {
    expect((await resolveLocation(supabase, "delhi"))?.city).toBe("Delhi NCR");
  });

  it("matches a station by name", async () => {
    const loc = await resolveLocation(supabase, "Anand Vihar");
    expect(loc?.kind).toBe("station");
    expect(loc?.monitors[0].id).toBe("a1");
  });

  it("returns null rather than guessing at an unknown place", async () => {
    // A wrong city silently answered is worse than admitting ignorance.
    expect(await resolveLocation(supabase, "Paris")).toBeNull();
    expect(await resolveLocation(supabase, "")).toBeNull();
  });
});

describe("tool executors", () => {
  it("reports an unknown location as a structured error, not an empty answer", async () => {
    const out = await executeTool(fakeSupabase({ monitors: DELHI_MONITORS }), "current_aqi", {
      location: "Atlantis",
    });
    expect(out.error).toBe("unknown_location");
    expect(String(out.message)).toMatch(/Delhi NCR/);
  });

  it("rejects an unknown tool name", async () => {
    const out = await executeTool(fakeSupabase({}), "drop_tables", {});
    expect(out.error).toBe("unknown_tool");
  });

  it("flags stale data on current_aqi rather than implying it is live", async () => {
    const old = new Date(Date.now() - 40 * 3_600_000).toISOString();
    const supabase = fakeSupabase({
      monitors: [DELHI_MONITORS[0]],
      readings: [{ id: "r1", recorded_at: old }],
      measurements: [
        { reading_id: "r1", pollutant: "pm25", value: 55 },
        { reading_id: "r1", pollutant: "pm10", value: 180 },
      ],
    });
    const out = await executeTool(supabase, "current_aqi", { location: "Anand Vihar" });
    expect(out.data_age_hours).toBeGreaterThan(24);
    expect(String(out.caveat)).toMatch(/hours old/);
    // PM10 drives the index here, which is the common case in these cities.
    expect(out.dominant_pollutant).toBe("pm10");
  });

  it("says in words what the numbers are, so PM2.5 is not called AQI", async () => {
    const supabase = fakeSupabase({
      monitors: [DELHI_MONITORS[0]],
      readings: [{ id: "r1", recorded_at: new Date().toISOString() }],
      // Both PMs: a reading needs them to carry an AQI (the AQI rule).
      measurements: [
        { reading_id: "r1", pollutant: "pm25", value: 55 },
        { reading_id: "r1", pollutant: "pm10", value: 60 },
      ],
    });
    // The model asks for "aqi"; the person's setting is PM2.5 and wins.
    const out = await executeTool(
      supabase,
      "current_aqi",
      { location: "Anand Vihar", pollutant: "aqi" },
      { measurement: "pm25" },
    );
    expect(out.pollutant).toBe("pm25");
    expect(String(out.values_are)).toMatch(/µg\/m³, NOT AQI/);
    // First, so it is read before any number.
    expect(Object.keys(out)[0]).toBe("values_are");
    // Results without a measure (errors) carry no such line.
    const missing = await executeTool(supabase, "current_aqi", { location: "Atlantis" });
    expect(missing.values_are).toBeUndefined();
  });

  it("refuses to recommend a time when no hourly profile exists", async () => {
    const supabase = fakeSupabase({
      monitors: [DELHI_MONITORS[0]],
      forecast_daily: [
        {
          monitor_id: "a1",
          pollutant: "aqi",
          target_date: "2026-11-16",
          horizon_days: 1,
          value: 300,
          band_p50: null,
          band_p80: null,
          mode: "seasonal_normal",
          model: "climatology",
          based_on_date: null,
          data_age_days: null,
        },
      ],
      diurnal_shape: [], // nothing fitted for this city-month
    });
    const out = await executeTool(supabase, "best_hour", { location: "Anand Vihar" });
    expect(out.error).toBe("no_hourly_profile");
    expect(String(out.message)).toMatch(/Do not recommend a time/i);
  });

  it("does not hide seasonal_normal behind a city average", async () => {
    // If any station is serving the seasonal average, the answer must say so
    // rather than presenting a mean that reads like a prediction.
    const supabase = fakeSupabase({
      monitors: [DELHI_MONITORS[0]],
      forecast_daily: [
        {
          monitor_id: "a1",
          pollutant: "aqi",
          target_date: "2099-01-02",
          horizon_days: 1,
          value: 210,
          band_p50: null,
          band_p80: null,
          mode: "seasonal_normal",
          model: "climatology",
          based_on_date: null,
          data_age_days: null,
        },
      ],
      diurnal_shape: [],
    });
    const out = await executeTool(supabase, "forecast", { location: "Anand Vihar" });
    const days = out.days as { mode: string }[];
    expect(days[0].mode).toBe("seasonal_normal");
  });

  it("forecast gives the same numbers as the app's chart, leaving out a seasonal-only station", async () => {
    // Two Delhi stations for the same two days. a1 has a real forecast; a2
    // only has the seasonal estimate (the long-run average for the date). The
    // app's chart (averageForecastDays) leaves a2 out, so the city number is
    // a1's alone -- 200, not the 300 that averaging both used to give here.
    // A fitted hourly shape makes the hourly curve non-trivial, so it is
    // compared too.
    const row = (monitor_id: string, target_date: string, value: number, mode: string) => ({
      monitor_id,
      pollutant: "aqi",
      target_date,
      horizon_days: 1,
      value,
      band_p50: null,
      band_p80: null,
      mode,
      model: mode === "seasonal_normal" ? "climatology" : "blend",
      based_on_date: mode === "seasonal_normal" ? null : "2099-01-01",
      data_age_days: mode === "seasonal_normal" ? null : 1,
      computed_at: null,
    });
    const tables = {
      monitors: DELHI_MONITORS,
      forecast_daily: [
        row("a1", "2099-01-02", 200, "forecast"),
        row("a1", "2099-01-03", 180, "outlook"),
        row("a2", "2099-01-02", 400, "seasonal_normal"),
        row("a2", "2099-01-03", 420, "seasonal_normal"),
      ],
      diurnal_shape: Array.from({ length: 24 }, (_, hour) => ({
        city: "Delhi",
        pollutant: "aqi",
        month: 1,
        hour,
        ratio: hour < 12 ? 1.2 : 0.8,
      })),
    };

    const out = await executeTool(fakeSupabase(tables), "forecast", { location: "Delhi NCR", days: 2 });
    const tool = out.days as { date: string; value: number; mode: string; hourly: (number | null)[]; band_label: string }[];

    // What the app's /api/forecast route computes from the same rows.
    const monitors = DELHI_MONITORS as MonitorRow[];
    const byStation = await getForecastMany(fakeSupabase(tables), monitors, "aqi", 2);
    const app = averageForecastDays(
      monitors.map((m) => ({ monitor: { ...m, distance_km: 0 }, days: byStation.get(m.id) ?? [] })),
      2,
      "aqi",
    )!;

    expect(out.stations_used).toBe(1); // a2 was left out
    expect(tool.map((d) => d.value)).toEqual([200, 180]);
    expect(tool.map((d) => d.value)).toEqual(app.value.map((d) => d.value));
    expect(tool.map((d) => d.date)).toEqual(app.value.map((d) => d.target_date));
    expect(tool.map((d) => d.mode)).toEqual(app.value.map((d) => d.mode));
    expect(tool.map((d) => d.band_label)).toEqual(app.value.map((d) => d.band.label));
    tool.forEach((d, i) => {
      expect(d.hourly).toEqual(app.value[i].hourly!.map((h) => Math.round(h.value)));
    });
  });

  // ── best_hour and rest_of_today use the same averaging (audit N3) ─────────
  //
  // One date, two Delhi stations. a1 only has the seasonal estimate; a2 has a
  // real forecast. The chart leaves a1 out, so the city curve is a2's alone.
  // a1 is deliberately FIRST: the old code took the first station's mode and
  // headline, which would have called a real forecast a seasonal estimate.
  // The hourly shape has a clear low at 15:00 so the curve is not flat.
  const ONE_DAY_DATE = "2099-01-02";
  // 04:30 UTC is 10:00 IST on that date: 14 hours of "today" remain.
  const MORNING_OF_ONE_DAY = new Date(`${ONE_DAY_DATE}T04:30:00Z`);
  const oneDayTables = () => {
    const row = (monitor_id: string, value: number, mode: string) => ({
      monitor_id,
      pollutant: "aqi",
      target_date: ONE_DAY_DATE,
      horizon_days: 1,
      value,
      band_p50: null,
      band_p80: null,
      mode,
      model: mode === "seasonal_normal" ? "climatology" : "blend",
      based_on_date: mode === "seasonal_normal" ? null : "2099-01-01",
      data_age_days: mode === "seasonal_normal" ? null : 1,
      computed_at: null,
    });
    return {
      monitors: DELHI_MONITORS,
      forecast_daily: [row("a1", 400, "seasonal_normal"), row("a2", 200, "forecast")],
      diurnal_shape: Array.from({ length: 24 }, (_, hour) => ({
        city: "Delhi",
        pollutant: "aqi",
        month: 1,
        hour,
        ratio: 0.6 + Math.abs(hour - 15) / 20,
      })),
    };
  };
  /** What the app's /api/forecast route computes for that day from the same rows. */
  const appDay = async (opts: { includeToday?: boolean } = {}) => {
    const monitors = DELHI_MONITORS as MonitorRow[];
    const byStation = await getForecastMany(fakeSupabase(oneDayTables()), monitors, "aqi", 1, opts);
    return averageForecastDays(
      monitors.map((m) => ({ monitor: { ...m, distance_km: 0 }, days: byStation.get(m.id) ?? [] })),
      1,
      "aqi",
    )!;
  };

  describe("hourly tools on a mix of real and seasonal-only stations", () => {
    beforeEach(() => {
      // Only the clock is faked, so promises still resolve normally.
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(MORNING_OF_ONE_DAY);
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it("best_hour picks from the app's averaged curve, leaving out the seasonal-only station", async () => {
      const out = await executeTool(fakeSupabase(oneDayTables()), "best_hour", { location: "Delhi NCR" });
      const app = (await appDay()).value[0];
      const appHours = app.hourly!.map((h) => h.value);

      expect(out.stations_used).toBe(1); // a1 was left out
      expect(out.date).toBe(app.target_date);
      const hourly = out.hourly as { hour: number; value: number | null }[];
      expect(hourly.map((h) => h.value)).toEqual(appHours.map((v) => Math.round(v)));
      expect(out.cleanest_hour_ist).toBe(appHours.indexOf(Math.min(...appHours)));
      expect(out.cleanest_value).toBe(Math.round(Math.min(...appHours)));
      expect(out.dirtiest_value).toBe(Math.round(Math.max(...appHours)));
      // a2 alone: 200 x the shape's lowest ratio (0.6) at 15:00.
      expect(out.cleanest_value).toBe(120);
    });

    it("rest_of_today gives the app's day value, curve and mode, leaving out the seasonal-only station", async () => {
      const out = await executeTool(fakeSupabase(oneDayTables()), "rest_of_today", { location: "Delhi NCR" });
      const app = (await appDay({ includeToday: true })).value[0];

      expect(out.error).toBeUndefined();
      expect(out.stations_used).toBe(1);
      expect(out.day_value).toBe(app.value);
      expect(out.day_value).toBe(200); // a2 alone, not the 300 of both
      expect(out.mode).toBe(app.mode);
      expect(out.mode).not.toBe("seasonal_normal");
      expect(out.headline).toBe(app.headline);
      expect(out.data_age_days).toBe(app.data_age_days);
      const hourly = out.hourly as { hour_ist: number; value: number }[];
      expect(hourly[0].hour_ist).toBe(10);
      for (const h of hourly) expect(h.value).toBe(app.hourly![h.hour_ist].value);
    });
  });
});

describe("meanAcross", () => {
  it("ignores non-finite values instead of poisoning the mean", () => {
    expect(meanAcross([10, 20, NaN])).toBe(15);
    expect(meanAcross([NaN])).toBeNull();
    expect(meanAcross([])).toBeNull();
  });
});

describe("provider client", () => {
  const realFetch = globalThis.fetch;
  const realKey = process.env.AI_API_KEY;

  beforeEach(() => {
    process.env.AI_API_KEY = "test-key";
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    if (realKey === undefined) delete process.env.AI_API_KEY;
    else process.env.AI_API_KEY = realKey;
    delete process.env.AI_BASE_URL;
    delete process.env.AI_MODEL;
  });

  it("defaults to Groq's free tier and a tool-capable model", () => {
    const cfg = aiConfig();
    expect(cfg.baseUrl).toBe(DEFAULT_BASE_URL);
    expect(cfg.model).toBe(DEFAULT_MODEL);
    expect(DEFAULT_BASE_URL).toContain("groq.com");
  });

  it("is swappable to any OpenAI-compatible provider by env alone", () => {
    // Free tiers disappear — GitHub Models was retired in July 2026 — so the
    // cost of moving must stay at two environment variables.
    process.env.AI_BASE_URL = "https://openrouter.ai/api/v1";
    process.env.AI_MODEL = "meta-llama/llama-3.3-70b-instruct:free";
    const cfg = aiConfig();
    expect(cfg.baseUrl).toBe("https://openrouter.ai/api/v1");
    expect(cfg.model).toContain("llama");
  });

  it("sends the OpenAI tools schema and returns the message", async () => {
    let sent: Record<string, unknown> = {};
    globalThis.fetch = vi.fn(async (_url, init) => {
      sent = JSON.parse(String((init as RequestInit).body));
      return new Response(
        JSON.stringify({
          choices: [{ message: { role: "assistant", content: "Delhi is 180 tomorrow." }, finish_reason: "stop" }],
          usage: { prompt_tokens: 100, completion_tokens: 12 },
        }),
        { status: 200 },
      );
    }) as never;

    const res = await chat([{ role: "user", content: "hi" }], { tools: TOOL_DEFINITIONS });
    expect(sent.tools).toHaveLength(7);
    expect(sent.tool_choice).toBe("auto");
    expect(res.message.content).toContain("180");
    expect(res.usage).toEqual({ prompt: 100, cached: 0, completion: 12 });
  });

  it("surfaces quota exhaustion distinctly — the free-tier failure that matters", async () => {
    globalThis.fetch = vi.fn(async () => new Response("rate limited", { status: 429 })) as never;
    await expect(chat([{ role: "user", content: "hi" }])).rejects.toMatchObject({
      status: 429,
      retryable: true,
    });
    await expect(chat([{ role: "user", content: "hi" }])).rejects.toThrow(/quota is exhausted/i);
  });

  it("fails clearly when no key is configured, rather than calling out anonymously", async () => {
    delete process.env.AI_API_KEY;
    delete process.env.GROQ_API_KEY;
    await expect(chat([{ role: "user", content: "hi" }])).rejects.toBeInstanceOf(AiProviderError);
  });

  it("treats a network failure as retryable", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error("ECONNRESET");
    }) as never;
    await expect(chat([{ role: "user", content: "hi" }])).rejects.toMatchObject({
      retryable: true,
    });
  });
});

describe("doubled answers", () => {
  it("removes an exactly doubled sentence", () => {
    const one = "Powai is the cleanest spot in Mumbai today (8 Oct).";
    expect(undouble(one + one)).toBe(one);
  });

  it("removes a doubling separated by a space or newline", () => {
    const one = "Delhi is Moderate at 168.";
    expect(undouble(`${one} ${one}`)).toBe(one);
    expect(undouble(`${one}\n${one}`)).toBe(one);
  });

  it("leaves a normal answer alone", () => {
    const a = "Delhi is 168 today and 175 tomorrow.";
    expect(undouble(a)).toBe(a);
  });

  it("does not truncate an answer that merely repeats a phrase", () => {
    // The dangerous case: halving this would lose real content, which is worse
    // than showing a repetition.
    const a = "Air is bad today. Air is bad tomorrow too, and worse on Friday.";
    expect(undouble(a)).toBe(a);
  });

  it("handles empty and tiny strings", () => {
    expect(undouble("")).toBe("");
    expect(undouble("  ")).toBe("");
  });
});

// A tester who reads PM2.5 got AQI charts: the model filled in pollutant "aqi"
// on its own, and an explicit argument used to beat the setting.
describe("which measure the tools report", () => {
  it("uses the setting when the model picks a measure nobody asked for", () => {
    expect(measureFor({ pollutant: "aqi" }, { measurement: "pm25" })).toBe("pm25");
    expect(measureFor({}, { measurement: "pm25" })).toBe("pm25");
  });

  it("lets the model's choice stand when the question named a measure", () => {
    expect(measureFor({ pollutant: "aqi" }, { measurement: "pm25", measurementNamed: true })).toBe("aqi");
  });

  it("never overrides other pollutants", () => {
    expect(measureFor({ pollutant: "pm10" }, { measurement: "pm25" })).toBe("pm10");
  });

  it("spots AQI and PM2.5 in a question, but not in the appended place note", () => {
    expect(namesMeasure("What will the AQI be tomorrow?")).toBe(true);
    expect(namesMeasure("show me PM 2.5 this week")).toBe(true);
    expect(namesMeasure("pm2.5 levels?")).toBe(true);
    expect(namesMeasure("Should I go for a run?\n\n(I am in Delhi, near AQI Lane.)")).toBe(false);
    expect(namesMeasure("is the air bad today")).toBe(false);
  });
});

describe("current_aqi in the person's measure", () => {
  const fresh = new Date(Date.now() - 2 * 3_600_000).toISOString();
  const supabase = () =>
    fakeSupabase({
      monitors: [DELHI_MONITORS[0]],
      readings: [{ id: "r1", recorded_at: fresh }],
      measurements: [
        { reading_id: "r1", pollutant: "pm25", value: 75 },
        { reading_id: "r1", pollutant: "pm10", value: 180 },
      ],
    });

  it("reports the PM2.5 concentration and its band for a PM2.5 reader", async () => {
    const out = await executeTool(supabase(), "current_aqi", { location: "Anand Vihar" }, { measurement: "pm25" });
    expect(out.pollutant).toBe("pm25");
    expect(out.value).toBe(75);
    // 60-90 µg/m³ is Moderate on the CPCB scale.
    expect(out.band).toBe("Moderate");
  });

  it("reports the index for an AQI reader", async () => {
    const out = await executeTool(supabase(), "current_aqi", { location: "Anand Vihar" }, { measurement: "aqi" });
    expect(out.pollutant).toBe("aqi");
    // PM10 at 180 drives the index above PM2.5's.
    expect(out.value).toBeGreaterThan(100);
  });
});

// "How's Baner compared to Hinjewadi" was answered "Hinjewadi is outside the
// covered cities": compare only knew city and station names. And the other
// tools fell back to the asker's own place for any unknown name, which would
// have given Baner's numbers under Hinjewadi's name.
describe("finding a neighbourhood by name", () => {
  const BANER = { latitude: 18.56, longitude: 73.78, label: "Baner, Pune", city: "Pune" };
  const PUNE_NEAREST = [
    { monitor_id: "p1", name: "Hinjewadi_MIDC", city: "Pune", latitude: 18.59, longitude: 73.73, distance_km: 1.2 },
  ];
  const lookup = vi.mocked(searchNominatim);
  beforeEach(() => lookup.mockReset().mockResolvedValue([]));

  it("looks up a place that is not the asker's own, and keeps its name", async () => {
    lookup.mockResolvedValue([{ label: "Hinjawadi, Pune", latitude: 18.59, longitude: 73.74, kind: "place" }]);
    const supabase = fakeSupabase({ monitors: [], nearest_monitors: PUNE_NEAREST, readings: [] });
    const out = await executeTool(supabase, "current_aqi", { location: "Hinjewadi" }, BANER);
    expect(lookup).toHaveBeenCalled();
    expect(out.error).not.toBe("unknown_location");
    expect(out.location).toBe("Hinjewadi");
  });

  it("uses the asker's own pin for their own place, without a lookup", async () => {
    const supabase = fakeSupabase({ monitors: [], nearest_monitors: PUNE_NEAREST, readings: [] });
    const out = await executeTool(supabase, "current_aqi", { location: "Baner" }, BANER);
    expect(lookup).not.toHaveBeenCalled();
    expect(out.location).toBe("Baner");
  });

  it("says not found, rather than borrowing the asker's place, when nothing matches", async () => {
    const supabase = fakeSupabase({ monitors: [], nearest_monitors: PUNE_NEAREST });
    const out = await executeTool(supabase, "current_aqi", { location: "Atlantis" }, BANER);
    expect(out.error).toBe("unknown_location");
  });
});

describe("reading a provider refusal", () => {
  it("pulls the limit and the refused request's size out of Groq's message", async () => {
    const { rateLimitSizesOf } = await import("@/lib/ai/provider");
    const text =
      "Rate limit reached ... on tokens per minute (TPM): Limit 8000, Used 5673, Requested 3602. Please try again in 9.5s.";
    expect(rateLimitSizesOf(text)).toEqual({ limit: 8000, requested: 3602 });
    expect(rateLimitSizesOf("something else")).toBeNull();
  });
});

describe("AI charts never draw PM10/NO2/SO2 on an AQI or PM2.5 scale (audit §6.2)", () => {
  it("returns no chart for a PM10 history", async () => {
    const { bestChart } = await import("@/lib/ai/chart");
    const series = Array.from({ length: 7 }, (_, i) => ({ date: `2026-11-0${i + 1}`, value: 150 + i }));
    const chart = bestChart([{ name: "history", result: { pollutant: "pm10", series, location: "Delhi" } }]);
    expect(chart).toBeNull();
  });
});

describe("the system prompt names the configured AI provider (audit §2.6)", () => {
  it("derives the name from the base URL", async () => {
    const { providerName } = await import("@/lib/ai/provider");
    expect(providerName("https://openrouter.ai/api/v1")).toBe("OpenRouter");
    expect(providerName("https://api.groq.com/openai/v1")).toBe("Groq");
  });
});

describe("the current reading must be able to carry an AQI (AQI rule)", () => {
  it("skips a newest reading that has only NO2 so far", async () => {
    const now = Date.now();
    const supabase = fakeSupabase({
      monitors: [DELHI_MONITORS[0]],
      // Newest first, as the query orders them.
      readings: [
        { id: "new", recorded_at: new Date(now - 1 * 3_600_000).toISOString() },
        { id: "old", recorded_at: new Date(now - 3 * 3_600_000).toISOString() },
      ],
      measurements: [
        { reading_id: "new", pollutant: "no2", value: 20 },
        { reading_id: "old", pollutant: "pm25", value: 75 },
        { reading_id: "old", pollutant: "pm10", value: 180 },
      ],
    });
    const out = await executeTool(supabase, "current_aqi", { location: "Anand Vihar" }, { measurement: "aqi" });
    expect(out.dominant_pollutant).toBe("pm10");
    expect(out.data_age_hours).toBeGreaterThan(2);
  });
});

describe("AI city history ignores days too few stations reported", () => {
  // The 18 Oct 2026 case: one Mumbai station had a complete day and read 297
  // against ~60 elsewhere; the AI charted it as a city-wide spike.
  const day = (date: string, mean: number) =>
    ({ date, mean, min: mean, max: mean, count: 96, source: "openaq" });
  const perStation = [
    [day("2026-10-17", 60), day("2026-10-18", 297)],
    [day("2026-10-17", 55)],
    [day("2026-10-17", 65)],
    [day("2026-10-17", 58)],
  ];
  // The location carries the city's whole pool (33 stations here), which is
  // what the 10% is taken of: ceil(3.3) = 4 must report.
  const pool = Array.from({ length: 33 }, (_, i) => ({
    id: `m${i}`, name: `S${i}`, city: "Mumbai", latitude: 19, longitude: 72.8,
  }));
  const loc = (kind: "city" | "point") =>
    ({ kind, city: "Mumbai", label: "Mumbai", monitors: pool }) as never;

  it("drops a city day resting on one station (33 monitors -> needs 4)", async () => {
    const { wellCoveredHistory } = await import("@/lib/ai/tools");
    const got = await wellCoveredHistory(loc("city"), perStation);
    expect(new Set(got.rows.map((r) => r.date))).toEqual(new Set(["2026-10-17"]));
    expect(got.daysDropped).toBe(1);
  });

  it("keeps every day for a neighbourhood, as Trends does", async () => {
    const { wellCoveredHistory } = await import("@/lib/ai/tools");
    const got = await wellCoveredHistory(loc("point"), perStation);
    expect(got.daysDropped).toBe(0);
    expect(got.rows).toHaveLength(5);
  });
});
