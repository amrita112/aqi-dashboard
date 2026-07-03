/**
 * Unit test for queries.ts — demonstrates the pattern for testing
 * functions that talk to Supabase without hitting a real database.
 *
 * Strategy: build a *fake* Supabase client whose chained methods
 * (`.from(...).select(...).order(...).limit(...).in(...)`) all return
 * the fake itself, except the final step which resolves to `{ data, error }`.
 * The test then asserts both:
 *   1. the returned data, and
 *   2. that the right chain of calls was made (e.g., `.in("source", ...)`
 *      was invoked when a source filter was passed).
 *
 * Future query tests can copy this pattern.
 */

import { describe, it, expect, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getReadings } from "./queries";
import type { Reading } from "./types";

/**
 * Build a fake Supabase client that returns the given rows.
 * `vi.fn()` creates a "spy" — a function that records every call so we can
 * assert on it later (similar to Python's `unittest.mock.MagicMock`).
 */
function makeFakeSupabase(rows: Reading[]) {
  // The query builder is chainable: each method returns `self` so calls can
  // be strung together. The final await resolves to { data, error }.
  const builder: any = {
    select: vi.fn(() => builder),
    order: vi.fn(() => builder),
    limit: vi.fn(() => builder),
    in: vi.fn(() => builder),
    // `then` makes the builder thenable (awaitable) — when getReadings
    // awaits the chain, this resolves to the data payload.
    then: (resolve: (value: { data: Reading[]; error: null }) => void) =>
      resolve({ data: rows, error: null }),
  };

  const from = vi.fn(() => builder);
  return { client: { from } as unknown as SupabaseClient, from, builder };
}

const sampleReading: Reading = {
  id: "r1",
  user_id: "u1",
  monitor_id: null,
  aqi_value: 120,
  latitude: 28.6,
  longitude: 77.2,
  image_url: null,
  device_type: null,
  source: "user",
  recorded_at: "2026-04-01T00:00:00Z",
  created_at: "2026-04-01T00:00:00Z",
};

describe("getReadings", () => {
  it("returns the rows from Supabase", async () => {
    const { client } = makeFakeSupabase([sampleReading]);
    const result = await getReadings(client);
    expect(result).toEqual([sampleReading]);
  });

  it("queries the `readings` table ordered by recorded_at desc with the given limit", async () => {
    const { client, from, builder } = makeFakeSupabase([]);
    await getReadings(client, 50);

    expect(from).toHaveBeenCalledWith("readings");
    expect(builder.order).toHaveBeenCalledWith("recorded_at", { ascending: false });
    expect(builder.limit).toHaveBeenCalledWith(50);
    // No source filter was passed, so `.in()` should not be called.
    expect(builder.in).not.toHaveBeenCalled();
  });

  it("filters by source when sources are provided", async () => {
    const { client, builder } = makeFakeSupabase([]);
    await getReadings(client, 1000, ["user", "openaq"]);

    expect(builder.in).toHaveBeenCalledWith("source", ["user", "openaq"]);
  });

  it("returns [] immediately when sources is an empty array (no DB call)", async () => {
    // An empty array means "the user unchecked every source" — the correct
    // answer is an empty list, not "all sources". This is the bug fix from
    // 2026-07-02: without the guard, an empty array silently returned every
    // reading in the DB because the `.in()` filter was skipped.
    const { client, from } = makeFakeSupabase([sampleReading]);
    const result = await getReadings(client, 1000, []);

    expect(result).toEqual([]);
    // Guard should short-circuit before touching Supabase at all.
    expect(from).not.toHaveBeenCalled();
  });
});
