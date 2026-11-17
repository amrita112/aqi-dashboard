/**
 * POST /api/event — the anonymous usage counter.
 *
 * This is a public write endpoint, so what matters is what it REFUSES:
 *
 *   - any event name outside the allowlist (which must match the database
 *     CHECK constraint in migrations 19 and 27)
 *   - any detail that is not a short lowercase token, since free text is where
 *     a question or a place name could leak into a table meant to hold counts
 *   - a caller hammering it (rate limit)
 *   - a database error leaking table/constraint names back to the browser
 *
 * Supabase is faked: `rpc` is a mock, so these tests check what the route
 * WOULD send to record_usage_event(), never touching a real database.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";

const rpc = vi.fn();

vi.mock("@/lib/supabase/server", () => ({
  createClient: () => ({ rpc }),
}));

import { POST } from "@/app/api/event/route";

let ipCounter = 0;
/** A fresh IP per request group, since the rate limiter is module-level state. */
const freshIp = () => `10.1.0.${++ipCounter}`;

function post(body: unknown, ip = freshIp()) {
  return new Request("http://localhost/api/event", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-forwarded-for": ip },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

beforeEach(() => {
  rpc.mockReset();
  rpc.mockResolvedValue({ data: null, error: null });
});

describe("POST /api/event — accepted events", () => {
  it.each(["installed", "question", "question_failed", "opened"])(
    "records %s and calls record_usage_event with name and detail",
    async (name) => {
      const res = await POST(post({ name, detail: "d1_7" }));
      expect(res.status).toBe(200);
      expect((await res.json()).data).toEqual({ recorded: true });
      expect(rpc).toHaveBeenCalledTimes(1);
      expect(rpc).toHaveBeenCalledWith("record_usage_event", { p_name: name, p_detail: "d1_7" });
    },
  );

  it("sends a null detail when none is given (or it is empty)", async () => {
    await POST(post({ name: "installed" }));
    await POST(post({ name: "installed", detail: "" }));
    expect(rpc.mock.calls.map((c) => c[1])).toEqual([
      { p_name: "installed", p_detail: null },
      { p_name: "installed", p_detail: null },
    ]);
  });

  it("accepts every detail the launch counter can produce (lib/launch.ts)", async () => {
    for (const d of ["d0", "d1_7", "d8_30", "d31_plus", "seen_d0", "seen_d31_plus"]) {
      expect((await POST(post({ name: "opened", detail: d }))).status).toBe(200);
    }
  });

  it("sends ONLY name and detail — nothing identifying reaches the database", async () => {
    await POST(post({ name: "question", detail: "none", ip: "1.2.3.4", user: "x", question: "hi" }));
    expect(Object.keys(rpc.mock.calls[0][1]).sort()).toEqual(["p_detail", "p_name"]);
  });
});

describe("POST /api/event — rejected events", () => {
  it("rejects an unknown or missing name without calling the database", async () => {
    for (const body of [{ name: "hacked" }, { name: "INSTALLED" }, { name: "" }, {}, { name: 5 }]) {
      const res = await POST(post(body));
      expect(res.status).toBe(400);
      expect((await res.json()).error.message).toMatch(/unknown event name/i);
    }
    expect(rpc).not.toHaveBeenCalled();
  });

  it("rejects a detail that is not a short lowercase token", async () => {
    for (const detail of [
      "Upper",               // uppercase
      "has space",           // free text
      "what is aqi in pune?",// a question
      "a-b",                 // hyphen
      "x".repeat(41),        // over 40 characters
      "d0;drop table",       // punctuation
    ]) {
      const res = await POST(post({ name: "question", detail }));
      expect(res.status).toBe(400);
      expect((await res.json()).error.message).toMatch(/short token/i);
    }
    expect(rpc).not.toHaveBeenCalled();
  });

  it("accepts a detail of exactly 40 characters (the database limit)", async () => {
    expect((await POST(post({ name: "question", detail: "a".repeat(40) }))).status).toBe(200);
  });

  it("rejects a body that is not JSON", async () => {
    for (const body of ["not json", "", "{name:"]) {
      const res = await POST(post(body));
      expect(res.status).toBe(400);
    }
    expect(rpc).not.toHaveBeenCalled();
  });

  it("rejects JSON that is not an object (null, array, number)", async () => {
    for (const body of ["null", "[]", "42", '"installed"']) {
      expect((await POST(post(body))).status).toBe(400);
    }
    expect(rpc).not.toHaveBeenCalled();
  });

  it("rejects an oversized body: a huge detail never reaches the database", async () => {
    const res = await POST(post({ name: "question", detail: "a".repeat(100_000) }));
    expect(res.status).toBe(400);
    expect(rpc).not.toHaveBeenCalled();
  });
});

describe("POST /api/event — rate limiting", () => {
  it("allows 20 a minute from one address, then answers 429 with Retry-After", async () => {
    const ip = freshIp();
    const codes: number[] = [];
    for (let i = 0; i < 21; i++) codes.push((await POST(post({ name: "installed" }, ip))).status);
    expect(codes.slice(0, 20).every((c) => c === 200)).toBe(true);
    const last = await POST(post({ name: "installed" }, ip));
    expect(codes[20]).toBe(429);
    expect(last.status).toBe(429);
    expect(Number(last.headers.get("Retry-After"))).toBeGreaterThan(0);
    // The limited requests never reached the database.
    expect(rpc).toHaveBeenCalledTimes(20);
  });

  it("does not limit a different address", async () => {
    const ip = freshIp();
    for (let i = 0; i < 21; i++) await POST(post({ name: "installed" }, ip));
    expect((await POST(post({ name: "installed" }, freshIp()))).status).toBe(200);
  });
});

describe("POST /api/event — database errors", () => {
  it("answers 502 without leaking the database's error text", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    rpc.mockResolvedValue({
      data: null,
      error: { message: 'new row for relation "usage_events" violates check constraint "usage_events_name_check"' },
    });
    const res = await POST(post({ name: "installed" }));
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body).toEqual({ error: { message: "Could not record" } });
    expect(JSON.stringify(body)).not.toMatch(/usage_events|constraint|relation/);
    // ...but it IS logged on the server, so we can see it.
    expect(spy.mock.calls.flat().join(" ")).toMatch(/usage_events_name_check/);
    spy.mockRestore();
  });
});

describe("POST /api/event — allowlist matches the database", () => {
  it("names in the route are exactly the names migration 27's CHECK allows", () => {
    const route = readFileSync("app/api/event/route.ts", "utf8");
    const sql = readFileSync("database-setup/27-usage-event-opened.sql", "utf8");
    const routeNames = route.match(/new Set\(\[([^\]]+)\]\)/)![1].match(/"([a-z_]+)"/g)!.map((s) => s.slice(1, -1));
    const sqlNames = sql.match(/CHECK \(name IN \(([^)]+)\)\)/)![1].match(/'([a-z_]+)'/g)!.map((s) => s.slice(1, -1));
    expect(routeNames.sort()).toEqual(sqlNames.sort());
  });
});
