/**
 * How long Vercel's shared cache may keep /api/history-hourly's answers.
 *
 * Why this exists (Nov 2026): a Delhi 7-day city view reads about 37,000 rows
 * (4-5 MB) from the database. New readings arrive only every 6 hours, so the
 * route asks the shared cache to keep a successful answer for an hour rather
 * than the 5 minutes every other route gets. These tests pin three things:
 *
 *   1. ok() with no cache argument still sends the old 5-minute header, so no
 *      other route changed.
 *   2. /api/history-hourly sends the 1-hour header on success.
 *   3. Errors carry NO Cache-Control header, so a database hiccup is never
 *      served to the next visitor from cache.
 *
 * The database is faked (no network): resolvePlace is replaced with a fixed
 * one-station place, and the readings query answers from a small array.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { ok, fail, DEFAULT_CACHE, cacheControlHeader } from "@/lib/api/respond";

const STATION = "00000000-0000-4000-8000-000000000001";

/** What the fake readings query returns; each test sets it. */
let readingsAnswer: { data: unknown[] | null; error: unknown } = { data: [], error: null };

/** A stand-in for the supabase-js query builder: every call chains, awaiting answers. */
function query() {
  const q: Record<string, unknown> = {};
  for (const name of ["select", "not", "eq", "in", "gte", "order", "range"]) q[name] = () => q;
  q.then = (resolve: (v: typeof readingsAnswer) => void) => resolve(readingsAnswer);
  return q;
}
vi.mock("@/lib/supabase/server", () => ({ createClient: () => ({ from: () => query() }) }));

// A fixed place, so the test does not have to fake the station lookup too.
vi.mock("@/lib/api/place", () => ({
  resolvePlace: async () => ({
    place: {
      kind: "point",
      monitors: [{ id: STATION, name: "S1", city: "Delhi", latitude: 28.6, longitude: 77.2, distance_km: 0 }],
      minStations: null,
      query: {},
    },
  }),
}));

async function get(qs = "lat=28.6&lng=77.2&k=1") {
  const { GET } = await import("@/app/api/history-hourly/route");
  return GET(new Request(`http://test/api/history-hourly?${qs}`));
}

describe("ok() cache header", () => {
  it("defaults to the 5-minute policy every route had before", () => {
    const res = ok({ x: 1 });
    expect(res.headers.get("Cache-Control")).toBe("public, s-maxage=300, stale-while-revalidate=600");
    expect(cacheControlHeader(DEFAULT_CACHE)).toBe(res.headers.get("Cache-Control"));
  });

  it("uses a policy passed in", () => {
    const res = ok({}, {}, 200, { sMaxAgeSeconds: 3600, staleWhileRevalidateSeconds: 3600 });
    expect(res.headers.get("Cache-Control")).toBe("public, s-maxage=3600, stale-while-revalidate=3600");
  });

  it("fail() sets no Cache-Control, so errors are not kept by the shared cache", () => {
    expect(fail("boom", 502).headers.get("Cache-Control")).toBeNull();
    expect(fail("bad", 400).headers.get("Cache-Control")).toBeNull();
  });
});

describe("/api/history-hourly cache header", () => {
  beforeEach(() => {
    readingsAnswer = { data: [], error: null };
  });

  it("caches a successful answer for an hour", async () => {
    readingsAnswer = {
      data: [{ monitor_id: STATION, recorded_at: "2026-11-20T10:00:00Z", aqi_value: 210 }],
      error: null,
    };
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("public, s-maxage=3600, stale-while-revalidate=3600");
    const body = await res.json();
    expect(body.data).toHaveLength(1);
  });

  it("caches an empty answer the same way", async () => {
    const res = await get();
    expect(res.headers.get("Cache-Control")).toBe("public, s-maxage=3600, stale-while-revalidate=3600");
  });

  it("does not cache a failed database read", async () => {
    readingsAnswer = { data: null, error: { message: "db down" } };
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await get();
    err.mockRestore();
    expect(res.status).toBe(502);
    expect(res.headers.get("Cache-Control")).toBeNull();
  });

  it("does not cache a bad request", async () => {
    const res = await get("lat=28.6&lng=77.2&pollutant=nope");
    expect(res.status).toBe(400);
    expect(res.headers.get("Cache-Control")).toBeNull();
  });
});
