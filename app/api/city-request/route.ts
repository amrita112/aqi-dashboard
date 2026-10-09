/**
 * POST /api/city-request  { name, email, city }   ask for a city to be covered
 * GET  /api/city-request?city=Indore              how many have asked
 *
 * Shares petition_signatures, distinguished by `kind` — see migration 18 for
 * why a second table would have been the wrong call.
 *
 * The count is public and the rows are not. petition_signatures has no SELECT
 * policy at all; city_request_count() is SECURITY DEFINER and returns an
 * integer, so "47 people have asked for Indore" is sayable without anyone
 * being able to ask who they were.
 */

import { createClient } from "@/lib/supabase/server";
import { badRequest, fail, ok, rateLimit, callerKey, tooManyRequests } from "@/lib/api/respond";
import { CITY_REQUEST_PURPOSE, CITY_REQUEST_THRESHOLD } from "@/lib/api/petition";

export const dynamic = "force-dynamic";

const MAX_NAME = 80;
const MAX_CITY = 60;
const PER_IP_PER_HOUR = 5;
const HOUR = 3_600_000;

export async function GET(request: Request) {
  const city = new URL(request.url).searchParams.get("city")?.trim() ?? "";
  if (!city) return badRequest("city is required");

  const { data, error } = await createClient().rpc("city_request_count", { p_city: city });
  if (error) return fail("Could not read the count", 502, error.message);
  return ok(
    { city, count: data ?? 0, threshold: CITY_REQUEST_THRESHOLD },
    { threshold: CITY_REQUEST_THRESHOLD },
  );
}

export async function POST(request: Request) {
  // Same shape of abuse as the petition: one person, many requests. Per IP
  // and per hour, because asking for two cities in one sitting is reasonable
  // and asking for fifty is not.
  const limit = rateLimit(`city-request:${callerKey(request)}`, PER_IP_PER_HOUR, HOUR);
  if (!limit.allowed) return tooManyRequests(limit.resetAt);

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return badRequest("Body must be JSON");
  }

  const name = typeof body.name === "string" ? body.name.trim() : "";
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const city = typeof body.city === "string" ? body.city.trim() : "";

  if (!name || name.length > MAX_NAME) {
    return badRequest(`Name is required and must be ${MAX_NAME} characters or fewer`);
  }
  if (!city || city.length > MAX_CITY) {
    return badRequest(`City is required and must be ${MAX_CITY} characters or fewer`);
  }
  // The same check the database makes, so a bad address fails with a sentence
  // rather than a constraint violation.
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return badRequest("A valid email address is required, so we can tell you when it is added");
  }

  const supabase = createClient();
  // THE TOKEN IS GENERATED HERE, NOT READ BACK. Asking Postgres to RETURN the
  // inserted row needs SELECT on the table, and this table deliberately has no
  // SELECT policy at all — so `.insert().select()` failed with "new row
  // violates row-level security policy", which reads like the insert was
  // refused when in fact it succeeded and only the read-back was denied.
  //
  // Supplying the UUID means we already know it and never have to ask.
  const withdrawalToken = crypto.randomUUID();
  const { error } = await supabase.from("petition_signatures").insert({
    name,
    email,
    city,
    kind: "city_request",
    wants_updates: false,
    purpose: CITY_REQUEST_PURPOSE,
    withdrawal_token: withdrawalToken,
  });

  if (error) {
    // 23505 is the unique index on (lower(email), kind): asking twice is not an
    // error worth showing as one.
    if (error.code === "23505") {
      const { data: count } = await supabase.rpc("city_request_count", { p_city: city });
      return ok({ city, count: count ?? 0, already: true, threshold: CITY_REQUEST_THRESHOLD });
    }
    return fail("Could not record that request", 502, error.message);
  }

  const { data: count } = await supabase.rpc("city_request_count", { p_city: city });
  return ok({
    city,
    count: count ?? 0,
    already: false,
    threshold: CITY_REQUEST_THRESHOLD,
    // Returned once and never again, exactly as the petition does.
    withdrawal_token: withdrawalToken,
  });
}
