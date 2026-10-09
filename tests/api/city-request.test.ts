/**
 * Tests for the "add my city" request.
 *
 * The promise on screen is specific — fifty requests and we add it — so the
 * things worth protecting are the ones that would make the count a lie.
 */

import { describe, expect, it } from "vitest";
import { CITY_REQUEST_PURPOSE, CITY_REQUEST_THRESHOLD, PETITION_PURPOSE } from "@/lib/api/petition";

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

describe("migration 18 keeps the uniqueness rules honest", () => {
  it("replaces the table-wide email index with two partial ones", async () => {
    const fs = await import("node:fs/promises");
    const sql = await fs.readFile("database-setup/18-city-requests.sql", "utf8");

    // A table-wide unique email would stop a petition signatory ever asking for
    // a city, and stop anyone asking for two. Both would surface as a bare
    // constraint violation.
    expect(sql).toContain("DROP INDEX IF EXISTS petition_signatures_email_uniq");
    expect(sql).toMatch(/WHERE kind = 'petition'/);
    expect(sql).toMatch(/WHERE kind = 'city_request'/);
    // Per person PER CITY, so two different cities are two valid requests.
    expect(sql).toMatch(/\(email, lower\(btrim\(city\)\)\)/);
  });

  it("counts without reading, and excludes expired rows", async () => {
    const fs = await import("node:fs/promises");
    const sql = await fs.readFile("database-setup/18-city-requests.sql", "utf8");
    expect(sql).toContain("SECURITY DEFINER");
    expect(sql).toContain("expires_at > now()");
    // Withdrawal is a hard delete in migration 16; a soft-delete test here
    // would silently never match.
    expect(sql).not.toContain("withdrawn_at");
  });
});
