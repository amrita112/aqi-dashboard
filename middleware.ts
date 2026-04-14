/**
 * Next.js Middleware — runs before every page load.
 *
 * This file MUST be in the project root (not inside /app or /lib).
 * Next.js automatically finds it here and runs it on every request.
 *
 * Its only job: refresh the user's Supabase login session so they
 * stay logged in. It calls getUser() which triggers a session refresh
 * if the session is about to expire.
 */

import { type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/middleware";

export async function middleware(request: NextRequest) {
  const { supabase, response } = createClient(request);

  // This call refreshes the session if it's about to expire.
  // We don't need the result — the side effect (refreshing cookies) is what matters.
  await supabase.auth.getUser();

  return response;
}

/**
 * Configure which routes the middleware runs on.
 * This pattern matches all routes EXCEPT static files and images.
 * (No need to refresh sessions when loading a CSS file or an image.)
 */
export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
