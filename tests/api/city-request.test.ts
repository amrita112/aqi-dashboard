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
      Promise.resolve(fn === "city_request_count_for" ? { data: 7, error: null } : { data: null, error: null }),
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

  it("calls request_city with name, email, city and the place key", async () => {
    const { POST } = await import("@/app/api/city-request/route");
    const res = await POST(post(VALID));
    expect(res.status).toBe(200);
    const write = rpc.mock.calls.find((c) => c[0] === "request_city");
    expect(write?.[1]).toEqual({
      p_name: "Meera",
      p_email: "meera@example.com",
      p_city: "Brahmapur, Odisha",
      p_place_key: "brahmapur",
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

  it("counts every spelling of the place, after submitting too", async () => {
    const { POST } = await import("@/app/api/city-request/route");
    await POST(post({ ...VALID, city: "Berhampur" }));
    const count = rpc.mock.calls.find((c) => c[0] === "city_request_count_for");
    expect(count?.[1]).toEqual({ p_keys: ["behrampur", "berhampur", "brahmapur", "brahmpur"] });
    // The stored key is the spelling's own (pre-alias) key.
    expect(rpc.mock.calls.find((c) => c[0] === "request_city")?.[1].p_place_key).toBe("berhampur");
    // The old exact-spelling count is not used any more.
    expect(rpc.mock.calls.some((c) => c[0] === "city_request_count")).toBe(false);
  });

  it("refuses a city with nothing left after normalising", async () => {
    const { POST } = await import("@/app/api/city-request/route");
    const res = await POST(post({ ...VALID, city: ",,," }));
    expect(res.status).toBe(400);
    expect(rpc.mock.calls.some((c) => c[0] === "request_city")).toBe(false);
  });
});

describe("the live count while typing", () => {
  beforeEach(() => {
    rpc.mockReset();
    rpc.mockResolvedValue({ data: 12, error: null });
  });
  const get = (city: string) =>
    new Request(`http://localhost/api/city-request?city=${encodeURIComponent(city)}`);

  it("asks for the same set of keys whichever spelling is typed", async () => {
    const { GET } = await import("@/app/api/city-request/route");
    for (const typed of ["Brahmapur", "Brahmapur, Odisha", "BERHAMPUR", "Brahmapur (Odisha)"]) {
      rpc.mockClear();
      const body = await (await GET(get(typed))).json();
      expect(body.data.count).toBe(12);
      expect(rpc).toHaveBeenCalledTimes(1);
      expect(rpc).toHaveBeenCalledWith("city_request_count_for", {
        p_keys: ["behrampur", "berhampur", "brahmapur", "brahmpur"],
      });
    }
  });

  it("answers 0 for punctuation without asking the database", async () => {
    const { GET } = await import("@/app/api/city-request/route");
    const body = await (await GET(get("!!!"))).json();
    expect(body.data.count).toBe(0);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("reports a database failure as an error, not as zero", async () => {
    rpc.mockResolvedValue({ data: null, error: { message: "boom" } });
    const { GET } = await import("@/app/api/city-request/route");
    expect((await GET(get("Indore"))).status).toBe(502);
  });
});

describe("migration 29 counts per place without exposing the rows", () => {
  const read = async () =>
    (await import("node:fs/promises")).readFile("database-setup/29-city-request-place-keys.sql", "utf8");

  it("backfills, then requires, a key on every request", async () => {
    const sql = await read();
    expect(sql).toContain("UPDATE city_requests SET place_key = city_place_key_fallback(city)");
    expect(sql).toContain("ALTER COLUMN place_key SET NOT NULL");
    expect(sql).toMatch(/^BEGIN;$/m);
    expect(sql).toMatch(/^COMMIT;$/m);
  });

  it("counts distinct people, returns only a number, and is the only new public door", async () => {
    const sql = await read();
    const fn = sql.slice(sql.indexOf("CREATE FUNCTION city_request_count_for"));
    expect(fn).toContain("RETURNS INTEGER");
    expect(fn).toContain("SECURITY DEFINER");
    expect(fn).toContain("count(DISTINCT email)");
    expect(fn).toContain("expires_at > now()");
    expect(sql).toContain("GRANT EXECUTE ON FUNCTION city_request_count_for(TEXT[]) TO anon, authenticated");
    // No table grants or policies for the public roles.
    expect(sql).not.toMatch(/CREATE POLICY/);
    expect(sql).not.toMatch(/GRANT [A-Z, ]+ ON (TABLE )?city_requests/);
    // The alert job's read stays service-only.
    expect(sql).toContain("REVOKE ALL ON FUNCTION city_request_tally() FROM PUBLIC, anon, authenticated");
  });
});
