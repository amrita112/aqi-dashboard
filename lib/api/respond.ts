/**
 * One response shape for every API route, and a rate limiter for the ones
 * that cost money.
 *
 * Every route returns either `{ data, meta }` or `{ error }`, never a bare
 * array, so a screen can always tell success from failure without inspecting
 * the shape. `meta` carries the things every caller needs and nobody should
 * have to re-derive: the time base, and when the answer was generated.
 */

import { NextResponse } from "next/server";
import { IST_TIME_ZONE } from "@/lib/api/time";

export interface ApiMeta {
  /** Always "Asia/Kolkata". Stated so no caller has to guess. */
  timezone: string;
  generated_at: string;
  [key: string]: unknown;
}

/**
 * How long Vercel's shared cache (the "CDN", servers between our code and the
 * visitor) may hand out a copy of a successful answer instead of running the
 * route again.
 *
 * - `sMaxAgeSeconds`: the copy counts as fresh for this long. `s-maxage`
 *   applies to SHARED caches only, so a visitor's own browser does not keep it.
 * - `staleWhileRevalidateSeconds`: after that, for this much longer, the old
 *   copy is still served instantly while one fresh copy is fetched in the
 *   background, so no visitor waits for the database.
 */
export interface CachePolicy {
  sMaxAgeSeconds: number;
  staleWhileRevalidateSeconds: number;
}

/**
 * The default for every route that does not ask for something else.
 * Forecasts are rewritten nightly and readings land a few times a day, so a
 * short shared cache absorbs bursts without ever showing stale air.
 */
export const DEFAULT_CACHE: CachePolicy = {
  sMaxAgeSeconds: 300,
  staleWhileRevalidateSeconds: 600,
};

/** The Cache-Control header text for a policy, e.g. "public, s-maxage=300, ...". */
export function cacheControlHeader(policy: CachePolicy): string {
  return `public, s-maxage=${policy.sMaxAgeSeconds}, stale-while-revalidate=${policy.staleWhileRevalidateSeconds}`;
}

/**
 * A successful answer. `cache` is optional: leave it out and the route gets
 * DEFAULT_CACHE, as every route did before it existed.
 *
 * Only successes are cached. fail() below sets no Cache-Control header at all,
 * and Vercel does not keep a function's response without one, so an error
 * (a database hiccup, say) is never served to the next visitor from cache.
 */
export function ok<T>(
  data: T,
  meta: Record<string, unknown> = {},
  status = 200,
  cache: CachePolicy = DEFAULT_CACHE,
) {
  return NextResponse.json(
    {
      data,
      meta: {
        timezone: IST_TIME_ZONE,
        generated_at: new Date().toISOString(),
        ...meta,
      } satisfies ApiMeta,
    },
    {
      status,
      headers: { "Cache-Control": cacheControlHeader(cache) },
    },
  );
}

export function fail(message: string, status = 400, detail?: unknown) {
  // Server-side failures keep their detail in the server log only. Database
  // and provider error text names tables, columns and constraints, which is
  // nothing a visitor needs and a map for anyone probing (audit §2.6).
  // Client errors (4xx) keep theirs: it says what was wrong with the request.
  if (status >= 500) {
    if (detail !== undefined) console.error(`[${status}] ${message}:`, detail);
    return NextResponse.json({ error: { message } }, { status });
  }
  return NextResponse.json({ error: { message, detail } }, { status });
}

/** Missing or malformed query parameters, phrased for whoever is calling. */
export function badRequest(message: string, detail?: unknown) {
  return fail(message, 400, detail);
}

export function notFound(message: string) {
  return fail(message, 404);
}

/** A UUID check, so a malformed id fails here rather than inside Postgres. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseMonitorId(params: URLSearchParams): string | null {
  const id = params.get("monitor_id");
  return id && UUID_RE.test(id) ? id : null;
}

export function parseNumber(
  params: URLSearchParams,
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = params.get(name);
  if (raw === null || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/**
 * In-memory fixed-window rate limiter.
 *
 * Deliberately simple, and deliberately here before it is needed. The read
 * routes are cheap — an open one costs a Vercel invocation and some Supabase
 * egress. The AI endpoint is not: it spends Anthropic credits per call against
 * a server-side key, so an open one is someone else's model bill on our card.
 *
 * LIMITATION, stated rather than discovered later: this counter lives in one
 * serverless instance's memory. Vercel runs several, and they do not share it,
 * so the real ceiling is roughly `limit x instances` and a cold start resets
 * it. That is enough to stop a script hammering one endpoint; it is not enough
 * to stop a determined abuser. If the AI endpoint ever needs a real bound, it
 * needs shared state (Upstash, or a Postgres counter table).
 */
const hits = new Map<string, { count: number; resetAt: number }>();

export function rateLimit(
  key: string,
  limit: number,
  windowMs: number,
  /**
   * A fixed reset time instead of a rolling window, e.g. midnight for a daily
   * allowance that should start afresh each day rather than 24h after first use.
   */
  fixedResetAt?: number,
): { allowed: boolean; remaining: number; resetAt: number } {
  const now = Date.now();
  const entry = hits.get(key);
  if (!entry || now >= entry.resetAt) {
    const resetAt = fixedResetAt ?? now + windowMs;
    hits.set(key, { count: 1, resetAt });
    return { allowed: true, remaining: limit - 1, resetAt };
  }
  entry.count += 1;
  return {
    allowed: entry.count <= limit,
    remaining: Math.max(0, limit - entry.count),
    resetAt: entry.resetAt,
  };
}

/** Best-effort caller identity for rate limiting. Spoofable; good enough. */
export function callerKey(request: Request): string {
  const fwd = request.headers.get("x-forwarded-for");
  return (fwd ? fwd.split(",")[0].trim() : null) ?? "unknown";
}

export function tooManyRequests(resetAt: number) {
  return NextResponse.json(
    { error: { message: "Too many requests. Try again shortly." } },
    {
      status: 429,
      headers: { "Retry-After": String(Math.ceil((resetAt - Date.now()) / 1000)) },
    },
  );
}
