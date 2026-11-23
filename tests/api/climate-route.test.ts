/**
 * /api/climate, end to end against a FAKE database (no network).
 *
 * The regression this guards (Nov 2026): Delhi NCR's city average showed
 * "1 year (2026)". The route drew on the 10 stations nearest the city centre
 * but required 10% of ALL 79 Delhi stations (8) to report in a month, so only
 * 2026 -- when 8 of those 10 finally overlapped -- survived. The fix draws a
 * city average from the whole city's network (resolveCity in
 * lib/api/place.ts, shared by every city view) and takes the 10% of that
 * same pool.
 *
 * The fake also enforces Supabase's 1000-row cap per request, so a city's
 * thousands of rows only arrive in full if the route really pages.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { minStationsOf } from "@/lib/api/place";

/** Supabase's "max rows" setting: no request returns more than this. */
const ROW_CAP = 1000;

type Row = Record<string, unknown>;

// The fake database's tables, refilled by each test.
const db: { monitors: Row[]; station_monthly_climate: Row[]; nearest: Row[] } = {
  monitors: [],
  station_monthly_climate: [],
  nearest: [],
};
/** How many pages of station_monthly_climate the route asked for. */
let climatePages = 0;

/**
 * A minimal stand-in for the supabase-js query builder: records filters,
 * then answers when awaited. Only the calls the route makes are supported.
 */
function query(table: keyof typeof db) {
  const filters: ((r: Row) => boolean)[] = [];
  let range: [number, number] | null = null;
  const q = {
    select: () => q,
    eq: (col: string, v: unknown) => (filters.push((r) => r[col] === v), q),
    is: (col: string, v: unknown) => (filters.push((r) => (r[col] ?? null) === v), q),
    // Only the form the code uses: .not(col, "is", null).
    not: (col: string, _op: string, v: unknown) => (filters.push((r) => (r[col] ?? null) !== v), q),
    in: (col: string, vs: unknown[]) => (filters.push((r) => vs.includes(r[col])), q),
    // Rows are stored already in (monitor_id, year, month) order.
    order: () => q,
    range: (lo: number, hi: number) => ((range = [lo, hi]), q),
    then: (resolve: (v: { data: Row[]; error: null }) => void) => {
      if (table === "station_monthly_climate") climatePages++;
      let rows = db[table].filter((r) => filters.every((f) => f(r)));
      const [lo, hi] = range ?? [0, rows.length - 1];
      rows = rows.slice(lo, Math.min(hi + 1, lo + ROW_CAP));
      resolve({ data: rows, error: null });
    },
  };
  return q;
}

const client = {
  from: (t: keyof typeof db) => query(t),
  rpc: async (fn: string) =>
    fn === "nearest_monitors" ? { data: db.nearest, error: null } : { data: null, error: { message: fn } },
};
vi.mock("@/lib/supabase/server", () => ({ createClient: () => client }));

/** A city of `n` stations: the first `nearN` are central and new (2026 only); the rest have 2010-2024. */
function buildCity(n: number, nearN: number) {
  const id = (i: number) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`;
  db.monitors = Array.from({ length: n }, (_, i) => ({
    id: id(i), name: `S${i}`, city: "Bigcity", latitude: 28 + i * 0.01, longitude: 77, disabled_at: null,
  }));
  db.nearest = db.monitors.slice(0, nearN).map((m, i) => ({
    monitor_id: m.id, name: m.name, city: m.city, latitude: m.latitude, longitude: m.longitude, distance_km: i,
  }));
  const rows: Row[] = [];
  db.monitors.forEach((m, i) => {
    const years = i < nearN ? [2026] : Array.from({ length: 15 }, (_, y) => 2010 + y);
    for (const year of years) {
      for (let month = 1; month <= 12; month++) {
        rows.push({
          monitor_id: m.id, metric: "pm25", year, month, n_days: 25,
          mean_of_means: 100 + month, mean_of_mins: 50, mean_of_maxes: 200, sources: "xkdr",
        });
      }
    }
  });
  db.station_monthly_climate = rows;
}

async function get(qs: string) {
  const { GET } = await import("@/app/api/climate/route");
  const res = await GET(new Request(`http://test/api/climate?${qs}`));
  return res.json();
}

describe("/api/climate city average", () => {
  beforeEach(() => {
    climatePages = 0;
  });

  it("draws on the whole city and pages past the 1000-row cap (Delhi NCR regression)", async () => {
    // 30 stations: 10 central ones only from 2026, 20 with 2010-2024.
    // 20 x 15 x 12 + 10 x 12 = 3,720 rows: four pages at 1000.
    buildCity(30, 10);
    const b = await get("lat=28&lng=77&k=10&max_km=60&city=Bigcity&metric=pm25");
    expect(climatePages).toBe(4);
    expect(b.meta.stations_used).toBe(30);
    expect(b.meta.min_stations).toBe(3); // 10% of the pool of 30
    expect(b.meta.city_pool).toBe("city");
    expect(b.data.n_years).toBe(16);
    expect([b.data.first_year, b.data.last_year]).toEqual([2010, 2026]);
    expect(b.data.months.every((m: { enough_years: boolean }) => m.enough_years)).toBe(true);
  });

  it("a point (no city) keeps its nearest stations and has no minimum", async () => {
    buildCity(30, 3);
    const b = await get("lat=28&lng=77&k=3&metric=pm25");
    expect(b.meta.stations_used).toBe(3);
    expect(b.meta.min_stations).toBeNull();
    expect(b.data.n_years).toBe(1);
  });
});

describe("minStationsOf", () => {
  it("is 10% of the pool, rounded up, at least 1", () => {
    expect(minStationsOf(79)).toBe(8);
    expect(minStationsOf(10)).toBe(1);
    expect(minStationsOf(3)).toBe(1);
    expect(minStationsOf(0)).toBe(1);
  });
});
