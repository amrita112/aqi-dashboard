/**
 * The petition endpoint.
 *
 * This is the only place in the app that writes personal data, so the tests
 * are about what it must never do as much as what it does:
 *
 *   - never return anyone's name, email or city, to anyone
 *   - never echo back the personal data it was just given
 *   - freeze the consent wording onto each row, so changing the text later
 *     cannot retroactively reinterpret what someone agreed to
 *   - treat "already signed" as an answer that reveals nothing
 *
 * The database half of the guarantee lives in migration 16 (no SELECT policy
 * at all), which these cannot reach; what they pin is that the route does not
 * undermine it.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const rpc = vi.fn();
const insert = vi.fn();

vi.mock("@/lib/supabase/server", () => ({
  createClient: () => ({
    rpc,
    from: () => ({
      // The route AWAITS insert() directly now. It used to chain
      // .select().single() to read the withdrawal token back, which needs
      // SELECT on a table that deliberately grants none — so the real database
      // refused it even though the row had been written. The token is
      // generated in the route instead, and this mock follows the real shape.
      insert: (row: unknown) => {
        insert(row);
        return Promise.resolve(
          insert.mock.results.at(-1)?.value ?? { data: null, error: null },
        );
      },
    }),
  }),
}));

import { GET, POST } from "@/app/api/petition/route";
import { PETITION_PURPOSE, RETENTION_YEARS } from "@/lib/api/petition";

function post(body: unknown, ip = "1.2.3.4") {
  return new Request("http://localhost/api/petition", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-forwarded-for": ip },
    body: JSON.stringify(body),
  });
}

const VALID = { name: "Asha Rao", email: "Asha@Example.com", city: "Pune" };
let ipCounter = 0;
/** A fresh IP per test, since the rate limiter is module-level state. */
const freshIp = () => `10.0.0.${++ipCounter}`;

const TOKEN = "33333333-3333-3333-3333-333333333333";

beforeEach(() => {
  rpc.mockReset();
  rpc.mockResolvedValue({ data: TOKEN, error: null });
  insert.mockReset();
  insert.mockReturnValue({ data: null, error: null });
});

describe("GET — the only public fact", () => {
  it("returns a count and nothing else", async () => {
    rpc.mockResolvedValue({ data: 42, error: null });
    const body = await (await GET()).json();
    expect(body.data).toEqual({ count: 42 });
    // The payload carries no address, no name, no route to a signatory. The
    // word "email" does appear in meta.purpose, which is the consent wording
    // and is meant to be public — hence checking data, not the whole response.
    expect(JSON.stringify(body.data)).not.toMatch(/@/);
    expect(Object.keys(body.data)).toEqual(["count"]);
  });

  it("publishes the purpose and retention alongside the count", async () => {
    rpc.mockResolvedValue({ data: 0, error: null });
    const body = await (await GET()).json();
    expect(body.meta.purpose).toBe(PETITION_PURPOSE);
    expect(body.meta.retention_years).toBe(RETENTION_YEARS);
  });
});

describe("POST — validation", () => {
  it("rejects a missing name, bad email, or missing city", async () => {
    for (const bad of [
      { ...VALID, name: "" },
      { ...VALID, email: "not-an-email" },
      { ...VALID, city: "" },
    ]) {
      expect((await POST(post(bad, freshIp()))).status).toBe(400);
    }
  });

  it("rejects an over-long name rather than truncating it", async () => {
    const res = await POST(post({ ...VALID, name: "x".repeat(81) }, freshIp()));
    expect(res.status).toBe(400);
  });

  it("rejects a non-JSON body", async () => {
    const res = await POST(
      new Request("http://localhost/api/petition", {
        method: "POST",
        headers: { "x-forwarded-for": freshIp() },
        body: "not json",
      }),
    );
    expect(res.status).toBe(400);
  });
});

describe("POST — what it stores and what it returns", () => {
  // Writes go through the sign_petition() database function (migration 23),
  // which sets purpose, expiry and withdrawal token itself.
  const signCall = () => rpc.mock.calls.find((c) => c[0] === "sign_petition")?.[1];

  it("lowercases the email so one person cannot sign twice by capitalising", async () => {
    await POST(post(VALID, freshIp()));
    expect(signCall()).toEqual(expect.objectContaining({ p_email: "asha@example.com", p_kind: "petition" }));
  });

  it("never sends the purpose, expiry or token: the database sets them", async () => {
    await POST(post(VALID, freshIp()));
    expect(Object.keys(signCall()).sort()).toEqual(
      ["p_city", "p_email", "p_kind", "p_name", "p_wants_updates"],
    );
  });

  it("stamps the SAME consent wording the screen shows (migration 23 vs lib/api/petition.ts)", async () => {
    // The text is frozen onto each row by sign_petition(); it must be the text
    // people were shown, or the stored consent is not what they agreed to.
    const { readFileSync } = await import("node:fs");
    const sql = readFileSync("database-setup/23-write-functions-live-monitors.sql", "utf8");
    const { CITY_REQUEST_PURPOSE } = await import("@/lib/api/petition");
    expect(sql).toContain(`WHEN 'petition' THEN '${PETITION_PURPOSE}'`);
    expect(sql).toContain(`ELSE '${CITY_REQUEST_PURPOSE}'`);
  });

  it("defaults the updates opt-in to false — signing is not subscribing", async () => {
    await POST(post(VALID, freshIp()));
    expect(signCall()).toEqual(expect.objectContaining({ p_wants_updates: false }));
    rpc.mockClear();
    await POST(post({ ...VALID, wants_updates: true }, freshIp()));
    expect(signCall()).toEqual(expect.objectContaining({ p_wants_updates: true }));
  });

  it("returns no withdrawal code and NOT the personal data it just stored", async () => {
    // Withdrawal is by email since Nov 2026; the code it used to return had no
    // page to use it on.
    const body = await (await POST(post(VALID, freshIp()))).json();
    expect(body.data).toEqual({ signed: true });
    expect(body.meta.withdraw_by).toMatch(/privacy@airgyaan\.in/);
    const text = JSON.stringify(body.data);
    expect(text).not.toMatch(/asha/i);
    expect(text).not.toMatch(/example\.com/i);
    expect(text).not.toMatch(/Pune/);
  });

  it("reports an already-signed email plainly, without leaking anything", async () => {
    rpc.mockResolvedValue({ data: null, error: { code: "23505", message: "duplicate key" } });
    const res = await POST(post(VALID, freshIp()));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.message).toMatch(/already signed/i);
  });
});

describe("POST — rate limiting", () => {
  it("stops one address signing repeatedly", async () => {
    // With no email verification, this is the only thing between the petition
    // and a script — and a petition's worth to a funder depends on it.
    const ip = freshIp();
    const codes: number[] = [];
    for (let i = 0; i < 5; i++) {
      codes.push((await POST(post({ ...VALID, email: `a${i}@example.com` }, ip))).status);
    }
    expect(codes.filter((c) => c === 429).length).toBeGreaterThan(0);
  });
});
