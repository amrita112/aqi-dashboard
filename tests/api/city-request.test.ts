/**
 * Tests for the "add my city" request.
 *
 * The promise on screen is specific — fifty requests and we add it — so the
 * things worth protecting are the ones that would make the count a lie.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { CITY_REQUEST_PURPOSE, CITY_REQUEST_THRESHOLD, PETITION_PURPOSE } from "@/lib/api/petition";

// The route's database client, replaced by a stub that records each call.
// vi.hoisted because vi.mock runs before the rest of the file.
const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: () => ({ rpc }) }));

describe("consent wording", () => {
  it("is not the petition's wording", () => {
    // Someone asking for Indore has not signed a petition, and their row must
    // never be countable as though they had.
    expect(CITY_REQUEST_PURPOSE).not.toBe(PETITION_PURPOSE);
    expect(CITY_REQUEST_PURPOSE.toLowerCase()).toContain("request");
  });

  it("says what the email is for and that it is deleted", () => {
    expect(CITY_REQUEST_PURPOSE.toLowerCase()).toContain("email");
    expect(CITY_REQUEST_PURPOSE.toLowerCase()).toContain("deleted");
  });

  it("promises a public count per city, not public identities", () => {
    expect(CITY_REQUEST_PURPOSE.toLowerCase()).toContain("counted publicly");
    expect(CITY_REQUEST_PURPOSE.toLowerCase()).not.toContain("shown to funders");
  });
});

describe("the threshold", () => {
  it("is fifty, which is what the screen promises", () => {
    // The number appears in copy in two components; if it moves, it has to
    // move here, and this test is where that is noticed.
    expect(CITY_REQUEST_THRESHOLD).toBe(50);
  });
});

describe("migration 28 gives city requests their own table", () => {
  // Until migration 28, requests shared petition_signatures and the public
  // petition total counted every one of them as a signature.
  const read = async () =>
    (await import("node:fs/promises")).readFile(
      "database-setup/28-separate-city-requests.sql",
      "utf8",
    );

  it("moves the old rows across without dropping consent, expiry or dates", async () => {
    const sql = await read();
    expect(sql).toContain("CREATE TABLE city_requests");
    expect(sql).toMatch(
      /INSERT INTO city_requests\s*\(id, name, email, city, purpose, withdrawal_token, created_at, expires_at\)/,
    );
    expect(sql).toContain("DELETE FROM petition_signatures WHERE kind = 'city_request'");
    // The move is checked before commit; a mismatch rolls the file back.
    expect(sql).toMatch(/IF moved <> before_count OR removed <> before_count/);
    expect(sql.trim().startsWith("--")).toBe(true);
    expect(sql).toMatch(/^BEGIN;$/m);
    expect(sql).toMatch(/^COMMIT;$/m);
  });

  it("keeps the new table unreadable and unwritable with the public key", async () => {
    const sql = await read();
    expect(sql).toContain("ALTER TABLE city_requests ENABLE ROW LEVEL SECURITY");
    expect(sql).not.toMatch(/CREATE POLICY/);
    expect(sql).toContain("REVOKE ALL ON city_requests FROM PUBLIC, anon, authenticated");
    // Supabase no longer grants new tables automatically.
    expect(sql).toContain("GRANT SELECT, DELETE ON city_requests TO service_role");
  });

  it("keeps one request per person PER CITY", async () => {
    const sql = await read();
    expect(sql).toMatch(/ON city_requests \(email, lower\(btrim\(city\)\)\)/);
  });

  it("counts without reading, and excludes expired rows", async () => {
    const sql = await read();
    const count = sql.slice(sql.indexOf("FUNCTION city_request_count"));
    expect(count).toContain("SECURITY DEFINER");
    expect(count).toContain("FROM city_requests");
    expect(count).toContain("expires_at > now()");
  });

  it("lets the alert job see places but never email addresses", async () => {
    const sql = await read();
    const tally = sql.slice(sql.indexOf("CREATE FUNCTION city_request_tally"));
    expect(tally).toContain("md5(r.email)");
    expect(tally).toContain("GRANT EXECUTE ON FUNCTION city_request_tally() TO service_role");
    expect(tally).toContain("REVOKE ALL ON FUNCTION city_request_tally() FROM PUBLIC, anon, authenticated");
  });
});

describe("the route writes to city_requests, never to the petition", () => {
  beforeEach(() => {
    rpc.mockReset();
    rpc.mockImplementation((fn: string) =>
      Promise.resolve(fn === "city_request_count" ? { data: 7, error: null } : { data: null, error: null }),
    );
  });

  let ip = 0;
  const post = (body: unknown) =>
    new Request("http://localhost/api/city-request", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-forwarded-for": `10.9.0.${++ip}` },
      body: JSON.stringify(body),
    });
  const VALID = { name: "Meera", email: "Meera@Example.com", city: "Brahmapur, Odisha" };

  it("calls request_city with exactly name, email and city", async () => {
    const { POST } = await import("@/app/api/city-request/route");
    const res = await POST(post(VALID));
    expect(res.status).toBe(200);
    const write = rpc.mock.calls.find((c) => c[0] === "request_city");
    expect(write?.[1]).toEqual({
      p_name: "Meera",
      p_email: "meera@example.com",
      p_city: "Brahmapur, Odisha",
    });
    expect(rpc.mock.calls.some((c) => c[0] === "sign_petition")).toBe(false);
    const body = await res.json();
    expect(body.data).toEqual(expect.objectContaining({ count: 7, already: false, threshold: 50 }));
  });

  it("treats asking twice for the same city as already counted", async () => {
    rpc.mockImplementation((fn: string) =>
      Promise.resolve(
        fn === "request_city"
          ? { data: null, error: { code: "23505", message: "duplicate key" } }
          : { data: 7, error: null },
      ),
    );
    const { POST } = await import("@/app/api/city-request/route");
    const body = await (await POST(post(VALID))).json();
    expect(body.data).toEqual(expect.objectContaining({ already: true, count: 7 }));
  });

  it("never echoes the email back", async () => {
    const { POST } = await import("@/app/api/city-request/route");
    const body = await (await POST(post(VALID))).json();
    expect(JSON.stringify(body)).not.toMatch(/example\.com/i);
  });
});
