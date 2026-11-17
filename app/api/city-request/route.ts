/**
 * POST /api/city-request  { name, email, city }   ask for a city to be covered
 * GET  /api/city-request?city=Indore              how many have asked
 *
 * COUNTED PER PLACE, NOT PER SPELLING (migration 29). "Brahmapur",
 * "Brahmapur, Odisha" and "Berhampur" are one place: the same rule the
 * milestone alert uses (lib/place-names.ts, mirrored in
 * scripts/alerts/place_names.py, aliases from lib/place-aliases.json). Each
 * request is stored with its key; the count is the number of different people
 * whose request has any key that means this place.
 *
 * Requests live in their own table, city_requests (migration 28). Until then
 * they shared petition_signatures, which made the public petition total count
 * every city request as a signature.
 *
 * The count is public and the rows are not. city_requests has no policies at
 * all; city_request_count_for() is SECURITY DEFINER and returns an integer, so
 * "47 people have asked for Indore" is sayable without anyone being able to
 * ask who they were.
 */

import { createClient } from "@/lib/supabase/server";
import { badRequest, fail, ok, rateLimit, callerKey, tooManyRequests } from "@/lib/api/respond";
import { CITY_REQUEST_THRESHOLD } from "@/lib/api/petition";
import { basicPlace, placeKeyGroup } from "@/lib/place-names";

export const dynamic = "force-dynamic";

const MAX_NAME = 80;
const MAX_CITY = 60;
const PER_IP_PER_HOUR = 5;
const HOUR = 3_600_000;

/**
 * People who have asked for the place `city` means, counting each person
 * once. Only the count comes back: the function returns a number, and the
 * keys sent are derived from what THIS visitor typed plus the public alias
 * file, so nothing anyone else typed is revealed. A name with nothing left
 * after normalising (",,,") has no place, so 0 without asking the database.
 */
async function countFor(supabase: ReturnType<typeof createClient>, city: string) {
  const keys = placeKeyGroup(city);
  if (keys.length === 0) return { count: 0, error: null };
  const { data, error } = await supabase.rpc("city_request_count_for", { p_keys: keys });
  return { count: (data as number | null) ?? 0, error };
}

export async function GET(request: Request) {
  const city = new URL(request.url).searchParams.get("city")?.trim() ?? "";
  if (!city) return badRequest("city is required");

  const { count, error } = await countFor(createClient(), city);
  if (error) return fail("Could not read the count", 502, error.message);
  return ok(
    { city, count, threshold: CITY_REQUEST_THRESHOLD },
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
  // The matching key, stored with the request. A "city" of only punctuation
  // has none, and could never be counted towards anywhere.
  const placeKey = basicPlace(city);
  if (!placeKey) {
    return badRequest("Please type the name of a city or town");
  }
  // The same check the database makes, so a bad address fails with a sentence
  // rather than a constraint violation.
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return badRequest("A valid email address is required, so we can tell you when it is added");
  }

  const supabase = createClient();
  // THROUGH request_city(), NOT A DIRECT INSERT (migration 28): the function
  // writes to city_requests and sets the purpose, expiry and withdrawal token
  // itself, so a caller cannot choose them. The key (migration 29) is computed
  // here, by the one TypeScript copy of the rule, so the database holds no
  // rule of its own for new rows.
  const { error } = await supabase.rpc("request_city", {
    p_name: name,
    p_email: email,
    p_city: city,
    p_place_key: placeKey,
  });

  if (error) {
    // 23505 is the unique index on (email, city): asking for the same city
    // twice is not an error worth showing as one.
    if (error.code === "23505") {
      const { count } = await countFor(supabase, city);
      return ok({ city, count, already: true, threshold: CITY_REQUEST_THRESHOLD });
    }
    return fail("Could not record that request", 502, error.message);
  }

  const { count } = await countFor(supabase, city);
  return ok({
    city,
    count,
    already: false,
    threshold: CITY_REQUEST_THRESHOLD,
  });
}
