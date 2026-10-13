/**
 * POST /api/client-error   record something that broke in someone's browser
 *
 * The counterpart to /api/event: that one counts what works, this one records
 * what does not. Same shape — a public write endpoint, rate limited, with the
 * database constraint as the real backstop (migration 20).
 *
 * TRUNCATION HAPPENS HERE, not only in the database. A request that exceeds
 * the CHECK constraint would be REJECTED, which means the error we most want
 * to see — an unusually long or unusual one — would be the error we silently
 * failed to record. Cutting it to fit keeps the first 300 characters, which is
 * where the useful part of a message lives.
 */

import { createClient } from "@/lib/supabase/server";
import { badRequest, fail, ok, rateLimit, callerKey, tooManyRequests } from "@/lib/api/respond";

export const dynamic = "force-dynamic";

// Must stay at or below the CHECK constraint in migration 20.
const MAX_MESSAGE = 300;
const MAX_STACK = 1000;
const MAX_PATHNAME = 120;
const MAX_BROWSER = 40;

// A broken page can throw in a loop — a render error inside a component that
// re-renders is the classic case. This is the cap on how much of that reaches
// the database from one person.
const PER_IP_PER_MINUTE = 10;
const MINUTE = 60_000;

function clip(v: unknown, max: number): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t ? t.slice(0, max) : null;
}

export async function POST(request: Request) {
  const limit = rateLimit(`clienterr:${callerKey(request)}`, PER_IP_PER_MINUTE, MINUTE);
  if (!limit.allowed) return tooManyRequests(limit.resetAt);

  let payload: Record<string, unknown>;
  try {
    payload = (await request.json()) as Record<string, unknown>;
  } catch {
    return badRequest("Body must be JSON");
  }

  const message = clip(payload.message, MAX_MESSAGE);
  if (!message) return badRequest("message is required");

  // PATHNAME ONLY. Even if a caller sends a full URL, the query string is
  // dropped here rather than trusted to have been stripped already — this is
  // the place that can guarantee it.
  const rawPath = clip(payload.pathname, MAX_PATHNAME + 200) ?? "";
  const pathname = rawPath ? rawPath.split("?")[0].split("#")[0].slice(0, MAX_PATHNAME) : null;

  const { error } = await createClient().from("client_errors").insert({
    message,
    stack: clip(payload.stack, MAX_STACK),
    pathname,
    browser: clip(payload.browser, MAX_BROWSER),
  });

  if (error) {
    // The thing that reports failures must not fail loudly itself.
    console.error(`client_errors insert failed: ${error.message}`);
    return fail("Could not record", 502, error.message);
  }
  return ok({ recorded: true });
}
