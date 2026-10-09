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
 *   - treat "already signed" and "bad token" as answers that reveal nothing
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

import { GET, POST, DELETE } from "@/app/api/petition/route";
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

beforeEach(() => {
  rpc.mockReset();
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
  it("lowercases the email so one person cannot sign twice by capitalising", async () => {
    await POST(post(VALID, freshIp()));
    expect(insert).toHaveBeenCalledWith(expect.objectContaining({ email: "asha@example.com" }));
  });

  it("stamps the consent wording onto the row", async () => {
    // Frozen per row: changing the text later must not rewrite what past
    // signatories agreed to.
    await POST(post(VALID, freshIp()));
    expect(insert).toHaveBeenCalledWith(expect.objectContaining({ purpose: PETITION_PURPOSE }));
  });

  it("defaults the updates opt-in to false — signing is not subscribing", async () => {
    await POST(post(VALID, freshIp()));
    expect(insert).toHaveBeenCalledWith(expect.objectContaining({ wants_updates: false }));
    await POST(post({ ...VALID, wants_updates: true }, freshIp()));
    expect(insert).toHaveBeenLastCalledWith(expect.objectContaining({ wants_updates: true }));
  });

  it("returns the withdrawal token and NOT the personal data it just stored", async () => {
    const body = await (await POST(post(VALID, freshIp()))).json();
    expect(body.data.withdrawal_token).toBeTruthy();
    const text = JSON.stringify(body.data);
    expect(text).not.toMatch(/asha/i);
    expect(text).not.toMatch(/example\.com/i);
    expect(text).not.toMatch(/Pune/);
  });

  it("reports an already-signed email plainly, without leaking anything", async () => {
    insert.mockReturnValue({ data: null, error: { code: "23505", message: "duplicate key" } });
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

describe("DELETE — withdrawal", () => {
  function del(body: unknown) {
    return new Request("http://localhost/api/petition", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  it("requires a well-formed token", async () => {
    expect((await DELETE(del({ token: "nope" }))).status).toBe(400);
    expect((await DELETE(del({}))).status).toBe(400);
  });

  it("confirms a real withdrawal", async () => {
    rpc.mockResolvedValue({ data: true, error: null });
    const res = await DELETE(del({ token: "11111111-1111-1111-1111-111111111111" }));
    expect(res.status).toBe(200);
    expect((await res.json()).data.withdrawn).toBe(true);
  });

  it("gives an unknown and an already-used token the same answer", async () => {
    // Distinguishing them would turn this into an oracle for testing tokens.
    rpc.mockResolvedValue({ data: false, error: null });
    const res = await DELETE(del({ token: "22222222-2222-2222-2222-222222222222" }));
    expect(res.status).toBe(404);
    expect((await res.json()).error.message).toMatch(/does not match/i);
  });
});
