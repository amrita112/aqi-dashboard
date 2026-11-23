/**
 * A database error must never look like "no data".
 *
 * Nov 2026: the code asked readings_daily for a column (is_complete) that the
 * database did not have yet. The query failed, the failure was swallowed as an
 * empty list, and the Trends screen told people "Nothing was measured near
 * this place" -- blaming the monitors for our own error. The map, which did
 * check, said "Could not load readings".
 *
 * These tests feed each reader a database that answers with an error and
 * check that the error reaches the caller as an error: a 502 from the routes,
 * a `data_unavailable` from the AI tools, and never the raw database text in a
 * response.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

/** What the database says. Each test sets these before calling. */
const db: {
  tableError: unknown;
  rows: unknown[];
  rpcError: unknown;
  rpcRows: unknown[];
} = { tableError: null, rows: [], rpcError: null, rpcRows: [] };

/** The error PostgREST really returned on 15 Nov 2026 (code 42703). */
const MISSING_COLUMN = {
  code: "42703",
  details: null,
  hint: null,
  message: "column readings_daily.is_complete does not exist",
};

/**
 * A stand-in for the Supabase client. Every query-builder method returns the
 * same chain, and awaiting the chain resolves to whatever `db` says -- which
 * is how postgrest-js behaves (a query is a "thenable").
 */
function fakeSupabase() {
  const chain: Record<string, unknown> = {};
  for (const m of ["select", "eq", "in", "gt", "gte", "lte", "not", "is", "order", "limit", "range"]) {
    chain[m] = vi.fn(() => chain);
  }
  (chain as { then: unknown }).then = (resolve: (v: unknown) => unknown) =>
    resolve(db.tableError ? { data: null, error: db.tableError } : { data: db.rows, error: null, count: 3 });
  return {
    from: () => chain,
    rpc: async () =>
      db.rpcError ? { data: null, error: db.rpcError } : { data: db.rpcRows, error: null },
  } as never;
}

vi.mock("@/lib/supabase/server", () => ({ createClient: () => fakeSupabase() }));
// Never the real geocoder from a test.
vi.mock("@/lib/api/nominatim", () => ({ searchNominatim: vi.fn(async () => []) }));

import { getHistory, nearestMonitors, DataError } from "@/lib/api/data";
import { GET as historyGET } from "@/app/api/history/route";
import { GET as mapGET } from "@/app/api/map/route";
import { executeTool } from "@/lib/ai/tools";

const POWAI = {
  monitor_id: "99c16c89-6433-48b0-a612-7f6e5c1b9a0a",
  name: "Powai, Mumbai - MPCB",
  city: "Mumbai",
  latitude: 19.1375,
  longitude: 72.915056,
  distance_km: 2.4,
};
const MONITOR = { id: POWAI.monitor_id, name: POWAI.name, city: POWAI.city, latitude: POWAI.latitude, longitude: POWAI.longitude };

beforeEach(() => {
  db.tableError = null;
  db.rows = [];
  db.rpcError = null;
  db.rpcRows = [POWAI];
  // fail() logs 5xx detail to the server console; keep test output quiet.
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("the data layer", () => {
  it.each(["pm25", "aqi"])("throws DataError for a failed %s history read, not []", async (pollutant) => {
    db.tableError = MISSING_COLUMN;
    await expect(
      getHistory(fakeSupabase(), MONITOR, pollutant, "2026-10-16", "2026-11-15"),
    ).rejects.toBeInstanceOf(DataError);
  });

  it("still returns [] when the read works and the window is genuinely empty", async () => {
    db.rows = [];
    await expect(
      getHistory(fakeSupabase(), MONITOR, "pm25", "2026-10-16", "2026-11-15"),
    ).resolves.toEqual([]);
  });

  it("throws DataError when the nearest-stations lookup fails, not []", async () => {
    db.rpcError = { message: "function nearest_monitors does not exist" };
    await expect(nearestMonitors(fakeSupabase(), 19.1, 72.9)).rejects.toBeInstanceOf(DataError);
  });
});

describe("GET /api/history", () => {
  const url = "http://localhost/api/history?lat=19.1176&lng=72.906&k=3&max_km=25&pollutant=pm25&days=30";

  it("answers 502 'Could not load history' when readings_daily errors", async () => {
    db.tableError = MISSING_COLUMN;
    const res = await historyGET(new Request(url));
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error.message).toBe("Could not load history");
    // The database's own words (table and column names) stay in the server log.
    expect(JSON.stringify(body)).not.toContain("is_complete");
    expect(body.data).toBeUndefined();
  });

  it("answers 502, not 404 'no stations', when the station lookup errors", async () => {
    db.rpcError = { message: "boom" };
    const res = await historyGET(new Request(url));
    expect(res.status).toBe(502);
  });

  it("answers 200 with an empty series when there is honestly nothing", async () => {
    const res = await historyGET(new Request(url));
    expect(res.status).toBe(200);
    expect((await res.json()).data).toEqual([]);
  });
});

describe("GET /api/map", () => {
  const url = "http://localhost/api/map?lat=19.1176&lng=72.906&radius_km=30&limit=80&pollutant=aqi";

  it("answers 502 without leaking the database error when readings_daily errors", async () => {
    db.tableError = MISSING_COLUMN;
    const res = await mapGET(new Request(url));
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error.message).toBe("Could not load readings");
    expect(JSON.stringify(body)).not.toContain("is_complete");
  });

  it("answers 502, not 404 'no stations', when the station lookup errors", async () => {
    db.rpcError = { message: "boom" };
    const res = await mapGET(new Request(url));
    expect(res.status).toBe(502);
    expect((await res.json()).error.message).toBe("Could not load monitoring stations");
  });
});

describe("AI tools", () => {
  // A point the asker chose, so the tool resolves through nearest_monitors
  // (answered by the fake RPC) rather than the monitors table (which errors).
  const ctx = { latitude: 19.1176, longitude: 72.906, label: "Powai" };

  it("history reports data_unavailable, not no_history, when the read fails", async () => {
    db.tableError = MISSING_COLUMN;
    const out = await executeTool(fakeSupabase(), "history", { location: "here", days: 30 }, ctx);
    expect(out.error).toBe("data_unavailable");
    expect(JSON.stringify(out)).not.toContain("is_complete");
  });

  it("compare reports data_unavailable when the read fails", async () => {
    db.tableError = MISSING_COLUMN;
    const out = await executeTool(
      fakeSupabase(),
      "compare",
      { location_a: "here", location_b: "here", days: 7 },
      ctx,
    );
    expect(out.error).toBe("data_unavailable");
  });
});
