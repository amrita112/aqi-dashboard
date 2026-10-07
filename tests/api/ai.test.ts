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
import { TOOL_DEFINITIONS, TOOL_NAMES, executeTool } from "@/lib/ai/tools";
import {
  chat,
  aiConfig,
  AiProviderError,
  DEFAULT_BASE_URL,
  DEFAULT_MODEL,
} from "@/lib/ai/provider";
import { resolveLocation, meanAcross } from "@/lib/api/data";

/** A Supabase stand-in returning canned rows for the tables we touch. */
function fakeSupabase(tables: Record<string, unknown[]>) {
  const builder = (rows: unknown[]) => {
    const chain: Record<string, unknown> = {};
    const self = () => chain;
    for (const m of ["select", "eq", "gt", "gte", "lte", "not", "order", "limit"]) {
      chain[m] = vi.fn(self);
    }
    // Awaiting the builder resolves to the rows, as postgrest-js does.
    (chain as { then: unknown }).then = (resolve: (v: unknown) => unknown) =>
      resolve({ data: rows, error: null });
    return chain;
  };
  return { from: (t: string) => builder(tables[t] ?? []) } as never;
}

const DELHI_MONITORS = [
  { id: "a1", name: "Anand Vihar", city: "Delhi NCR", latitude: 28.6, longitude: 77.3 },
  { id: "a2", name: "R K Puram", city: "Delhi NCR", latitude: 28.5, longitude: 77.1 },
];

describe("tool contract", () => {
  it("exposes exactly the six agreed tools", () => {
    expect(TOOL_NAMES.sort()).toEqual(
      ["best_hour", "compare", "current_aqi", "forecast", "history", "rest_of_today"].sort(),
    );
  });

  it("keeps best_hour and rest_of_today distinguishable to the model", () => {
    // These two are the pair most easily confused, and confusing them is how
    // "should I run this evening" got answered with TOMORROW's cleanest hour.
    // Each description has to name its own day unambiguously.
    const byName = Object.fromEntries(
      TOOL_DEFINITIONS.map((t) => [t.function.name, t.function.description]),
    );
    expect(byName.best_hour).toMatch(/TOMORROW/);
    expect(byName.best_hour.toLowerCase()).toContain("rest_of_today");
    expect(byName.rest_of_today).toMatch(/TODAY/);
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
        { pollutant: "pm25", value: 55 },
        { pollutant: "pm10", value: 180 },
      ],
    });
    const out = await executeTool(supabase, "current_aqi", { location: "Anand Vihar" });
    expect(out.data_age_hours).toBeGreaterThan(24);
    expect(String(out.caveat)).toMatch(/hours old/);
    // PM10 drives the index here, which is the common case in these cities.
    expect(out.dominant_pollutant).toBe("pm10");
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
    expect(sent.tools).toHaveLength(6);
    expect(sent.tool_choice).toBe("auto");
    expect(res.message.content).toContain("180");
    expect(res.usage).toEqual({ prompt: 100, completion: 12 });
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
