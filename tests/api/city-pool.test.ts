/**
 * A CITY AVERAGE USES EVERY ACTIVE MONITORING STATION IN THE CITY -- in every
 * route and in the AI box (owner's decision, 23 Nov 2026).
 *
 * The bug this guards. The Trends screen asked for a city as "the 10 stations
 * nearest the centre" (k=10), while the rule that hides thin days asked for
 * 10% of ALL the city's stations (8 of Delhi NCR's 79). So 8 of those 10 had
 * to report on the same day, and days went blank. The AI box was worse: it
 * answered from the first 8 stations in table order.
 *
 * The fake database below behaves like Supabase where it matters:
 *   - filters (eq, in, is, not, gt/gte/lte) are applied;
 *   - ordering is applied, so paging is only correct if the order is stable;
 *   - no response holds more than 1000 rows (the project's "max rows"), so a
 *     route that does not page silently loses rows and these tests fail;
 *   - the two nested ("embedded") reads the code makes are supported:
 *     a station with its newest readings, and readings with one pollutant's
 *     measurement.
 * It also counts requests, so a return to one-request-per-station shows up.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { istToday } from "@/lib/api/time";

const ROW_CAP = 1000;
type Row = Record<string, unknown>;

const db: Record<string, Row[]> & { nearest: Row[] } = {
  monitors: [],
  forecast_daily: [],
  diurnal_shape: [],
  readings_daily: [],
  readings: [],
  measurements: [],
  station_monthly_climate: [],
  nearest: [],
};
/** Requests per table, reset before each test. */
let requests: Record<string, number> = {};

function compare(a: unknown, b: unknown): number {
  if (a === b) return 0;
  if (a === null || a === undefined) return 1;
  if (b === null || b === undefined) return -1;
  return String(a) < String(b) ? -1 : 1;
}

/** A small stand-in for the supabase-js query builder (only what the code uses). */
function query(table: string) {
  let columns = "";
  const filters: ((r: Row) => boolean)[] = [];
  const nestedEq: Record<string, unknown> = {};
  const orders: { col: string; asc: boolean }[] = [];
  const nestedOrders: { col: string; asc: boolean }[] = [];
  let nestedLimit: number | null = null;
  let limit: number | null = null;
  let range: [number, number] | null = null;
  const q: Record<string, unknown> = {
    select: (c: string) => ((columns = c), q),
    eq: (col: string, v: unknown) => {
      if (col.includes(".")) nestedEq[col] = v;
      else filters.push((r) => r[col] === v);
      return q;
    },
    in: (col: string, vs: unknown[]) => (filters.push((r) => vs.includes(r[col])), q),
    is: (col: string, v: unknown) => (filters.push((r) => (r[col] ?? null) === v), q),
    not: (col: string, _op: string, v: unknown) => (filters.push((r) => (r[col] ?? null) !== v), q),
    gt: (col: string, v: unknown) => (filters.push((r) => compare(r[col], v) > 0), q),
    gte: (col: string, v: unknown) => (filters.push((r) => compare(r[col], v) >= 0), q),
    lte: (col: string, v: unknown) => (filters.push((r) => compare(r[col], v) <= 0), q),
    order: (col: string, o: { ascending?: boolean; referencedTable?: string } = {}) => {
      (o.referencedTable ? nestedOrders : orders).push({ col, asc: o.ascending !== false });
      return q;
    },
    limit: (n: number, o: { referencedTable?: string } = {}) => {
      if (o.referencedTable) nestedLimit = n;
      else limit = n;
      return q;
    },
    range: (lo: number, hi: number) => ((range = [lo, hi]), q),
    then: (resolve: (v: { data: Row[]; error: null }) => void) => {
      requests[table] = (requests[table] ?? 0) + 1;
      let rows = db[table].filter((r) => filters.every((f) => f(r)));

      // A station with its newest readings nested (getCurrentMany).
      if (table === "monitors" && columns.includes("readings(")) {
        rows = rows.map((m) => {
          let rs = db.readings.filter(
            (r) => r.monitor_id === m.id && (nestedEq["readings.source"] === undefined || r.source === nestedEq["readings.source"]),
          );
          for (const o of [...nestedOrders].reverse()) {
            rs = [...rs].sort((a, b) => compare(a[o.col], b[o.col]) * (o.asc ? 1 : -1));
          }
          if (nestedLimit !== null) rs = rs.slice(0, nestedLimit);
          return {
            id: m.id,
            readings: rs.map((r) => ({
              id: r.id,
              recorded_at: r.recorded_at,
              measurements: db.measurements.filter((x) => x.reading_id === r.id),
            })),
          };
        });
      }
      // Readings with one pollutant's value nested; `!inner` drops readings without it.
      if (table === "readings" && columns.includes("measurements!inner")) {
        rows = rows
          .map((r) => ({
            ...r,
            measurements: db.measurements
              .filter((x) => x.reading_id === r.id && x.pollutant === nestedEq["measurements.pollutant"])
              .map((x) => ({ value: x.value })),
          }))
          .filter((r) => (r.measurements as unknown[]).length > 0);
      }

      for (const o of [...orders].reverse()) {
        rows = [...rows].sort((a, b) => compare(a[o.col], b[o.col]) * (o.asc ? 1 : -1));
      }
      if (limit !== null) rows = rows.slice(0, limit);
      const [lo, hi] = range ?? [0, rows.length - 1];
      rows = rows.slice(lo, Math.min(hi + 1, lo + ROW_CAP));
      resolve({ data: rows, error: null });
    },
  };
  return q;
}

const client = {
  from: (t: string) => query(t),
  rpc: async (fn: string) => {
    requests[`rpc:${fn}`] = (requests[`rpc:${fn}`] ?? 0) + 1;
    return fn === "nearest_monitors" ? { data: db.nearest, error: null } : { data: null, error: { message: fn } };
  },
};
vi.mock("@/lib/supabase/server", () => ({ createClient: () => client }));
// Never the real geocoder from a test.
vi.mock("@/lib/api/nominatim", () => ({ searchNominatim: vi.fn(async () => []) }));

// ─── The fake city ──────────────────────────────────────────────────────────
//
// "Bigcity": 25 active stations, plus 2 disabled ones and 1 in another city
// that must never be counted. 10% of 25, rounded up, is 3.

const CITY = "Bigcity";
const N = 25;
const id = (i: number) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`;
const ACTIVE = Array.from({ length: N }, (_, i) => id(i));

function addDays(iso: string, n: number): string {
  return new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
}

function buildMonitors() {
  db.monitors = [
    ...ACTIVE.map((mid, i) => ({
      id: mid, name: `Station ${i}`, city: CITY, latitude: 28 + i * 0.01, longitude: 77, disabled_at: null,
    })),
    { id: id(90), name: "Retired A", city: CITY, latitude: 28.5, longitude: 77, disabled_at: "2026-01-01" },
    { id: id(91), name: "Retired B", city: CITY, latitude: 28.6, longitude: 77, disabled_at: "2026-02-01" },
    { id: id(92), name: "Elsewhere", city: "Othercity", latitude: 19, longitude: 72.8, disabled_at: null },
  ];
  // The three nearest to the point the tests use, as the RPC would return them.
  db.nearest = db.monitors.slice(0, 3).map((m, i) => ({
    monitor_id: m.id, name: m.name, city: m.city, latitude: m.latitude, longitude: m.longitude, distance_km: i,
  }));
}

beforeEach(() => {
  for (const k of Object.keys(db)) db[k] = [];
  requests = {};
  buildMonitors();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

async function call(route: string, qs: string) {
  const mod = await import(`@/app/api/${route}/route`);
  const res: Response = await mod.GET(new Request(`http://test/api/${route}?${qs}`));
  return { status: res.status, body: await res.json() };
}

/** How a city average is asked for by the Trends screen (k/max_km are now ignored). */
const CITY_QS = `lat=28&lng=77&k=10&max_km=60&city=${CITY}`;

// ─── The shared resolver ────────────────────────────────────────────────────

describe("resolveCity / resolvePlace", () => {
  it("a city is every ACTIVE station filed under it, and the minimum is 10% of that same pool", async () => {
    const { resolvePlace } = await import("@/lib/api/place");
    const r = await resolvePlace(client as never, new URLSearchParams(CITY_QS));
    if (!("place" in r)) throw new Error("expected a place");
    expect(r.place.kind).toBe("city");
    expect(r.place.monitors.map((m) => m.id).sort()).toEqual([...ACTIVE].sort());
    expect(r.place.minStations).toBe(3);
    // Nearest the given centre first.
    expect(r.place.monitors[0].id).toBe(id(0));
    // k=10 is NOT a cap for a city, and the nearest-stations search is not used.
    expect(requests["rpc:nearest_monitors"]).toBeUndefined();
  });

  it("a city can be asked for by name alone (centre = mean of its stations)", async () => {
    const { resolvePlace } = await import("@/lib/api/place");
    const r = await resolvePlace(client as never, new URLSearchParams(`city=${CITY}`));
    if (!("place" in r)) throw new Error("expected a place");
    expect(r.place.monitors).toHaveLength(N);
  });

  it("an unknown city is a 404, not an empty average", async () => {
    const { resolvePlace } = await import("@/lib/api/place");
    const r = await resolvePlace(client as never, new URLSearchParams("city=Atlantis"));
    expect("error" in r && r.error.status).toBe(404);
  });

  it("a point keeps its 3 nearest stations and no minimum", async () => {
    const { resolvePlace } = await import("@/lib/api/place");
    const r = await resolvePlace(client as never, new URLSearchParams("lat=28&lng=77&k=3"));
    if (!("place" in r)) throw new Error("expected a place");
    expect(r.place.kind).toBe("point");
    expect(r.place.monitors).toHaveLength(3);
    expect(r.place.minStations).toBeNull();
  });

  it("a single station stays a single station", async () => {
    const { resolvePlace } = await import("@/lib/api/place");
    // The station lookup uses maybeSingle(); give the fake that one method.
    const one = {
      from: () => {
        const q = query("monitors") as Record<string, unknown>;
        q.maybeSingle = async () => ({ data: db.monitors[4], error: null });
        return q;
      },
    };
    const r = await resolvePlace(one as never, new URLSearchParams(`monitor_id=${id(4)}`));
    if (!("place" in r)) throw new Error("expected a place");
    expect(r.place.kind).toBe("station");
    expect(r.place.monitors.map((m) => m.id)).toEqual([id(4)]);
    expect(r.place.minStations).toBeNull();
  });
});

// ─── /api/forecast ──────────────────────────────────────────────────────────

function buildForecast() {
  const today = istToday();
  const rows: Row[] = [];
  ACTIVE.forEach((mid, i) => {
    for (let h = 0; h <= 7; h++) {
      rows.push({
        monitor_id: mid, pollutant: "pm25", target_date: addDays(today, h), horizon_days: Math.max(1, h),
        // Station i reads 100 + i, so the city mean is 100 + mean(0..24) = 112.
        value: 100 + i, band_p50: 0.1, band_p80: 0.2, mode: "forecast", model: "blend",
        based_on_date: addDays(today, -1), data_age_days: 1, computed_at: null,
      });
    }
  });
  db.forecast_daily = rows;
}

describe("/api/forecast for a city", () => {
  it("averages every station in the city, in a handful of requests", async () => {
    buildForecast();
    const { status, body } = await call("forecast", `${CITY_QS}&pollutant=pm25&days=3&include_today=true`);
    expect(status).toBe(200);
    expect(body.meta.stations_used).toBe(N);
    expect(body.data.days).toHaveLength(3);
    expect(body.data.days[0].value).toBe(112);
    // One request for 25 stations' rows (not 25), one for the city's hourly shape.
    expect(requests.forecast_daily).toBe(1);
    expect(requests.diurnal_shape).toBe(1);
  });

  it("each station still gets only its next `days` rows (what .limit(days) did)", async () => {
    buildForecast();
    const { body } = await call("forecast", `${CITY_QS}&pollutant=pm25&days=7`);
    // Today excluded by default: the 7 days after it.
    expect(body.data.days.map((d: { target_date: string }) => d.target_date)).toEqual(
      Array.from({ length: 7 }, (_, i) => addDays(istToday(), i + 1)),
    );
  });
});

// ─── /api/history ───────────────────────────────────────────────────────────

const FROM = "2026-10-01";
const TO = "2026-10-31";

/** Every station complete every day, except: 5 Oct only 2 stations, 6 Oct exactly 3. */
function buildDaily() {
  const rows: Row[] = [];
  for (let d = 0; d < 31; d++) {
    const date = addDays(FROM, d);
    const reporting = date === "2026-10-05" ? 2 : date === "2026-10-06" ? 3 : N;
    for (let i = 0; i < reporting; i++) {
      for (const pollutant of ["no2", "pm10", "pm25", "so2"]) {
        rows.push({
          monitor_id: ACTIVE[i], date, pollutant, mean: 50 + i, min: 40, max: 90,
          min_ts: null, max_ts: null, count: 84, source: "openaq", is_complete: true,
        });
      }
    }
  }
  db.readings_daily = rows; // ~3,000 rows: three times the row cap
}

describe("/api/history for a city", () => {
  it("uses every station, pages past the row cap, and hides days below 10% of the same pool", async () => {
    buildDaily();
    for (const pollutant of ["pm25", "aqi"]) {
      requests = {};
      const { status, body } = await call("history", `${CITY_QS}&pollutant=${pollutant}&from=${FROM}&to=${TO}`);
      expect(status).toBe(200);
      expect(body.meta.stations_used).toBe(N);
      expect(body.meta.min_stations).toBe(3);
      const dates = body.data.map((d: { date: string }) => d.date);
      expect(dates).not.toContain("2026-10-05"); // 2 of 25 reported: hidden
      expect(dates).toContain("2026-10-06"); // 3 of 25: shown
      expect(body.meta.days_hidden).toBe(1);
      expect(dates).toHaveLength(30);
      // Every station's every day arrived (none lost to the row cap).
      const full = body.data.find((d: { date: string }) => d.date === "2026-10-10");
      expect(full.stations).toBe(N);
      // Batched: far fewer requests than one per station.
      expect(requests.readings_daily).toBeLessThan(N);
    }
  });
});

// ─── /api/history-hourly ────────────────────────────────────────────────────

/**
 * The last two days at 5-minute steps (288 a day), so a request for a few
 * stations passes the row cap and must page. Every station reports every
 * step, except in the hour 6 hours ago, when only 2 do.
 */
function buildHourly() {
  const readings: Row[] = [];
  const measurements: Row[] = [];
  const now = Date.now();
  const start = now - 2 * 86_400_000 + 3_600_000;
  // Hours counted on the Indian clock (UTC+5:30), as the route buckets them.
  const istHour = (t: number) => Math.floor((t + 5.5 * 3_600_000) / 3_600_000);
  const thinHour = istHour(now - 6 * 3_600_000);
  let n = 0;
  for (let t = start; t < now; t += 5 * 60_000) {
    const thin = istHour(t) === thinHour;
    ACTIVE.forEach((mid, i) => {
      if (thin && i >= 2) return;
      const rid = `r${n++}`;
      readings.push({ id: rid, monitor_id: mid, source: "openaq", recorded_at: new Date(t).toISOString(), aqi_value: 100 + i });
      measurements.push({ reading_id: rid, pollutant: "pm25", value: 50 + i });
    });
  }
  db.readings = readings;
  db.measurements = measurements;
  return thinHour;
}

describe("/api/history-hourly for a city", () => {
  it("reads every station's readings in full, for AQI and for a single pollutant", async () => {
    buildHourly();
    for (const [pollutant, mean] of [["aqi", 112], ["pm25", 62]] as const) {
      requests = {};
      const { status, body } = await call("history-hourly", `${CITY_QS}&pollutant=${pollutant}&days=2`);
      expect(status).toBe(200);
      expect(body.meta.stations).toBe(N);
      expect(body.meta.min_stations).toBe(3);
      const points = body.data as { stations: number; value: number }[];
      // Full hours: all 25 stations, and the plain mean of them.
      const full = points.filter((p) => p.stations === N);
      expect(full.length).toBeGreaterThan(40);
      expect(full.filter((p) => p.value !== mean)).toEqual([]);
      // The hour only 2 of 25 reported is left out (needs 3).
      expect(points.some((p) => p.stations === 2)).toBe(false);
      // Batched by station groups, not one request per 400 readings.
      expect(requests.measurements ?? 0).toBe(0);
    }
  });
});

// ─── The AI tools ───────────────────────────────────────────────────────────

describe("AI tools answer a city from every station", () => {
  it("forecast, best_hour and rank_places use all 25 stations", async () => {
    buildForecast();
    // An hourly shape for the city, so best_hour has a curve to read.
    db.diurnal_shape = Array.from({ length: 12 * 24 }, (_, k) => ({
      city: CITY, pollutant: "pm25", month: Math.floor(k / 24) + 1, hour: k % 24,
      ratio: 0.8 + (k % 24) / 60, n_days: 30,
    }));
    const { executeTool } = await import("@/lib/ai/tools");
    const f = await executeTool(client as never, "forecast", { location: CITY, pollutant: "pm25", days: 2 }, { measurementNamed: true });
    expect(f.stations_used).toBe(N);
    expect((f.days as { value: number }[])[0].value).toBe(112);
    expect(requests.forecast_daily).toBe(1);

    const b = await executeTool(client as never, "best_hour", { location: CITY, pollutant: "pm25" }, { measurementNamed: true });
    expect(b.stations_used).toBe(N);

    const r = await executeTool(client as never, "rank_places", { location: CITY, pollutant: "pm25" }, { measurementNamed: true });
    expect(r.stations_ranked).toBe(N);
    // Both ends of a big city, cleanest first: Station 0 (100) ... Station 24 (124).
    const all = r.all as { station: string; value: number }[];
    expect(all).toHaveLength(10);
    expect(all[0].station).toBe("Station 0");
    expect(all[all.length - 1].station).toBe("Station 24");
    expect(String(r.all_is)).toMatch(/of 25 stations/);
  });

  it("history uses all 25 stations and the 10% of that same pool", async () => {
    buildDaily();
    // The tool counts back from today, so move the fixture's month to end today.
    const shift = Math.round((Date.parse(`${istToday()}T00:00:00Z`) - Date.parse(`${TO}T00:00:00Z`)) / 86_400_000);
    db.readings_daily = db.readings_daily.map((r) => ({ ...r, date: addDays(String(r.date), shift) }));
    const { executeTool } = await import("@/lib/ai/tools");
    const h = await executeTool(client as never, "history", { location: CITY, pollutant: "pm25", days: 30 }, { measurementNamed: true });
    expect(h.error).toBeUndefined();
    // 31 days in the fixture, 30 + today asked: 5 Oct's twin (2 of 25) is dropped.
    expect(h.days_left_out_for_low_coverage).toBe(1);
    expect(requests.readings_daily).toBeLessThan(N);
  });

  it("current_aqi reads every station's latest reading in one request", async () => {
    const now = Date.now();
    ACTIVE.forEach((mid, i) => {
      db.readings.push({ id: `c${i}`, monitor_id: mid, source: "openaq", recorded_at: new Date(now - 3_600_000).toISOString(), aqi_value: null });
      db.measurements.push({ reading_id: `c${i}`, pollutant: "pm25", value: 50 + i });
      db.measurements.push({ reading_id: `c${i}`, pollutant: "pm10", value: 60 });
    });
    const { executeTool } = await import("@/lib/ai/tools");
    const c = await executeTool(client as never, "current_aqi", { location: CITY, pollutant: "pm25" }, { measurementNamed: true });
    expect(c.stations_used).toBe(N);
    expect(c.value).toBe(62);
    // Monitors three times: the name lookup, the city's stations, and ONE
    // request for every station's latest readings nested inside it.
    expect(requests.monitors).toBe(3);
    expect(requests.readings ?? 0).toBe(0);
    expect(requests.measurements ?? 0).toBe(0);
  });

  it("retired stations and other cities are never part of the city", async () => {
    const { executeTool } = await import("@/lib/ai/tools");
    buildForecast();
    db.forecast_daily.push(
      ...[id(90), id(91), id(92)].map((mid) => ({
        monitor_id: mid, pollutant: "pm25", target_date: addDays(istToday(), 1), horizon_days: 1,
        value: 999, band_p50: null, band_p80: null, mode: "forecast", model: "blend",
        based_on_date: null, data_age_days: 1, computed_at: null,
      })),
    );
    const f = await executeTool(client as never, "forecast", { location: CITY, pollutant: "pm25", days: 1 }, { measurementNamed: true });
    expect(f.stations_used).toBe(N);
    expect((f.days as { value: number }[])[0].value).toBe(112);
  });
});

describe("batching helpers", () => {
  it("stationsPerQuery keeps a request near one page, between 1 and MONITORS_PER_QUERY", async () => {
    const { stationsPerQuery, MONITORS_PER_QUERY } = await import("@/lib/api/data");
    expect(stationsPerQuery(31 * 4)).toBe(8); // 30-day AQI history
    expect(stationsPerQuery(365 * 4)).toBe(1); // a year: one station per request
    expect(stationsPerQuery(1)).toBe(MONITORS_PER_QUERY); // tiny rows: capped by URL length
  });

  it("mapLimit keeps order and never runs more than the limit at once", async () => {
    const { mapLimit } = await import("@/lib/api/data");
    let running = 0;
    let peak = 0;
    const out = await mapLimit([1, 2, 3, 4, 5, 6, 7], 3, async (x) => {
      running++;
      peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, 5));
      running--;
      return x * 2;
    });
    expect(out).toEqual([2, 4, 6, 8, 10, 12, 14]);
    expect(peak).toBe(3);
  });
});
