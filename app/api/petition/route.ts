/**
 * GET    /api/petition   — how many people have signed (a count, nothing else)
 * POST   /api/petition   — sign
 * DELETE /api/petition   — withdraw, using the token returned at signing
 *
 * The only endpoint in this app that writes personal data, so it is the only
 * one that has to be careful about it.
 *
 * WHAT IS NEVER RETURNED: any signatory's name, email or city, to anyone, ever.
 * The table has no SELECT policy at all (see migration 16), so even a bug here
 * cannot leak the list through the anon key. GET returns an integer.
 *
 * WHAT THE SIGNATORY GETS BACK ONCE: their withdrawal token. There is no email
 * sender in this project — a deliberate consequence of running on free tiers —
 * so a token handed over at signing time is the only way someone can withdraw
 * without a human being involved. It is shown once and never readable again,
 * which is a real usability cost and is stated plainly in the UI rather than
 * hidden.
 */

import { createClient } from "@/lib/supabase/server";
import { ok, fail, badRequest, rateLimit, callerKey, tooManyRequests } from "@/lib/api/respond";
import { PETITION_PURPOSE, RETENTION_YEARS } from "@/lib/api/petition";

export const dynamic = "force-dynamic";

const MINUTE = 60_000;
const DAY = 86_400_000;

/**
 * Signing is rare and deliberate, so the limits are tight. A petition's value
 * to a funder depends entirely on it not being trivially inflatable, and with
 * no email verification the rate limit is the only thing standing between this
 * and a script.
 */
const SIGN_PER_IP_PER_HOUR = 3;
const SIGN_PER_IP_PER_DAY = 5;

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET() {
  const supabase = createClient();
  const { data, error } = await supabase.rpc("petition_count");
  if (error) return fail("Could not load the signature count", 502, error.message);
  return ok(
    { count: data ?? 0 },
    { purpose: PETITION_PURPOSE, retention_years: RETENTION_YEARS },
  );
}

export async function POST(request: Request) {
  const caller = callerKey(request);
  const hourly = rateLimit(`petition:h:${caller}`, SIGN_PER_IP_PER_HOUR, 60 * MINUTE);
  if (!hourly.allowed) return tooManyRequests(hourly.resetAt);
  const daily = rateLimit(`petition:d:${caller}`, SIGN_PER_IP_PER_DAY, DAY);
  if (!daily.allowed) return tooManyRequests(daily.resetAt);

  let body: { name?: unknown; email?: unknown; city?: unknown; wants_updates?: unknown };
  try {
    body = await request.json();
  } catch {
    return badRequest("Body must be JSON");
  }

  const name = typeof body.name === "string" ? body.name.trim() : "";
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const city = typeof body.city === "string" ? body.city.trim() : "";
  const wantsUpdates = body.wants_updates === true;

  if (name.length < 1 || name.length > 80) {
    return badRequest("Please give a name, up to 80 characters");
  }
  if (!EMAIL_RE.test(email) || email.length > 254) {
    return badRequest("Please give a valid email address");
  }
  if (city.length < 1 || city.length > 60) {
    return badRequest("Please say which city or town you are in");
  }

  const supabase = createClient();
  const { data, error } = await supabase
    .from("petition_signatures")
    .insert({ name, email, city, wants_updates: wantsUpdates, purpose: PETITION_PURPOSE })
    // Only the token comes back. Selecting the row would return the personal
    // data we just wrote, which there is no reason to echo.
    .select("withdrawal_token")
    .single();

  if (error) {
    // 23505 is the unique violation on email. Told plainly, because "you have
    // already signed" is useful and reveals nothing the sender did not supply.
    if (error.code === "23505") {
      return fail("That email address has already signed. Thank you.", 409);
    }
    return fail("Could not record the signature", 502, error.message);
  }

  return ok(
    {
      signed: true,
      // Shown once. There is no way to retrieve it later.
      withdrawal_token: data.withdrawal_token,
    },
    {
      purpose: PETITION_PURPOSE,
      retention_years: RETENTION_YEARS,
      withdraw_with: "DELETE /api/petition with { token }",
    },
    201,
  );
}

export async function DELETE(request: Request) {
  let body: { token?: unknown };
  try {
    body = await request.json();
  } catch {
    return badRequest("Body must be JSON: { token }");
  }
  const token = typeof body.token === "string" ? body.token.trim() : "";
  if (!UUID_RE.test(token)) return badRequest("A valid withdrawal token is required");

  const supabase = createClient();
  const { data, error } = await supabase.rpc("withdraw_petition_signature", { token });
  if (error) return fail("Could not withdraw the signature", 502, error.message);

  if (!data) {
    // Either the token never existed or it was already used. Both are reported
    // identically: distinguishing them would let someone test tokens.
    return fail("That token does not match a signature. It may already have been withdrawn.", 404);
  }
  return ok({ withdrawn: true }, { deleted: "the row was deleted outright, not flagged" });
}
