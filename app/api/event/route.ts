/**
 * POST /api/event  { name, detail? }   record one anonymous usage count
 *
 * WHY THERE IS A SERVER ROUTE AT ALL, when the browser could write to Supabase
 * directly with the anon key it already holds: so the allowlist, the rate
 * limit and the stripping of anything identifying happen in one place that the
 * client cannot skip. The database CHECK constraints in migration 19 are the
 * backstop; this is the front door.
 *
 * WHAT IT REFUSES TO STORE. Everything except two short tokens. No question
 * text, no place, no coordinates, no IP, no session or device id, no user
 * agent, no referrer. The caller's IP is used for rate limiting and then
 * discarded — it is never written. See migration 19 for the reasoning.
 *
 * This is a PUBLIC WRITE ENDPOINT, which is unusual in this codebase and worth
 * naming. Anyone can POST to it, so the numbers it produces are a floor rather
 * than a measurement: they can be inflated by someone determined, and the
 * mitigations below only make that tedious rather than impossible. For "did
 * the install hint work" and "which tools answer", tedious is enough.
 */

import { createClient } from "@/lib/supabase/server";
import { badRequest, fail, ok, rateLimit, callerKey, tooManyRequests } from "@/lib/api/respond";

export const dynamic = "force-dynamic";

/** Mirrors the CHECK constraint in migration 19. Both must agree. */
const NAMES = new Set(["installed", "question", "question_failed"]);

/** Short, lowercase, no free text. Tool names and failure reasons only. */
const DETAIL = /^[a-z0-9_]{1,40}$/;

// Generous, because a single person moving through the app legitimately
// produces a handful of these in a minute, and because the cost of a wrong
// refusal here is a missing count rather than a broken screen.
const PER_IP_PER_MINUTE = 20;
const MINUTE = 60_000;

export async function POST(request: Request) {
  const limit = rateLimit(`event:${callerKey(request)}`, PER_IP_PER_MINUTE, MINUTE);
  if (!limit.allowed) return tooManyRequests(limit.resetAt);

  let name = "";
  let detail: string | null = null;
  try {
    const body = (await request.json()) as { name?: unknown; detail?: unknown };
    name = typeof body.name === "string" ? body.name : "";
    detail = typeof body.detail === "string" && body.detail ? body.detail : null;
  } catch {
    return badRequest("Body must be JSON: { name: string, detail?: string }");
  }

  if (!NAMES.has(name)) return badRequest("Unknown event name");
  if (detail !== null && !DETAIL.test(detail)) return badRequest("detail must be a short token");

  const { error } = await createClient().from("usage_events").insert({ name, detail });
  // A count that failed to record is not worth telling anyone about, and
  // certainly not worth an error on screen: this endpoint exists to observe
  // the app, never to affect it. Logged for us, 204 for them.
  if (error) {
    console.error(`usage_events insert failed: ${error.message}`);
    return fail("Could not record", 502, error.message);
  }
  return ok({ recorded: true });
}
