/**
 * GET    /api/petition   — how many people have signed (a count, nothing else)
 * POST   /api/petition   — sign
 *
 * The only endpoint in this app that writes personal data, so it is the only
 * one that has to be careful about it.
 *
 * WHAT IS NEVER RETURNED: any signatory's name, email or city, to anyone, ever.
 * The table has no SELECT policy at all (see migration 16), so even a bug here
 * cannot leak the list through the anon key. GET returns an integer.
 *
 * WITHDRAWAL IS BY EMAIL (Nov 2026). Signatories used to get a withdrawal code
 * back, with no page to use it on; it confused people and was removed. A
 * request to the privacy address (lib/brand.ts, CONTACT_EMAIL) is handled by
 * deleting the row by hand. The database still gives each row a withdrawal
 * token (sign_petition, migration 23); it is simply never shown.
 */

import { createClient } from "@/lib/supabase/server";
import { ok, fail, badRequest, rateLimit, callerKey, tooManyRequests } from "@/lib/api/respond";
import { PETITION_PURPOSE, RETENTION_YEARS } from "@/lib/api/petition";
import { CONTACT_EMAIL } from "@/lib/brand";

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
  // THROUGH sign_petition(), NOT A DIRECT INSERT (migration 23). The
  // function sets the purpose, the expiry and the withdrawal token itself, so
  // nobody holding the public key can choose them; direct inserts are refused
  // after migration 24. It returns the token, shown to the signatory once.
  const { data: withdrawalToken, error } = await supabase.rpc("sign_petition", {
    p_kind: "petition",
    p_name: name,
    p_email: email,
    p_city: city,
    p_wants_updates: wantsUpdates,
  });

  if (error) {
    // 23505 is the unique violation on email. Told plainly, because "you have
    // already signed" is useful and reveals nothing the sender did not supply.
    if (error.code === "23505") {
      return fail("That email address has already signed. Thank you.", 409);
    }
    return fail("Could not record the signature", 502, error.message);
  }
  if (typeof withdrawalToken !== "string") {
    return fail("Could not record the signature", 502, "sign_petition returned no token");
  }

  return ok(
    { signed: true },
    {
      purpose: PETITION_PURPOSE,
      retention_years: RETENTION_YEARS,
      withdraw_by: `email ${CONTACT_EMAIL}`,
    },
    201,
  );
}
