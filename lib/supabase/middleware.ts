/**
 * Supabase middleware client.
 *
 * Middleware is code that runs BEFORE a page loads — like a security checkpoint.
 * Every time someone visits any page on your site, this code runs first.
 *
 * Its job here: refresh the user's login session so they don't get randomly
 * logged out. Without this, Supabase sessions would expire and users would
 * have to log in again frequently.
 */

import { createServerClient } from "@supabase/ssr";
import { type NextRequest, NextResponse } from "next/server";

export function createClient(request: NextRequest) {
  // Create a response object that we can modify (e.g., set cookies on)
  let supabaseResponse = NextResponse.next({
    request: {
      headers: request.headers,
    },
  });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        // Read all cookies from the incoming request
        getAll() {
          return request.cookies.getAll();
        },
        // Write cookies to both the request and response.
        // This ensures the session stays fresh for the current page load
        // AND for subsequent requests.
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value)
          );
          supabaseResponse = NextResponse.next({
            request,
          });
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options)
          );
        },
      },
    }
  );

  return { supabase, response: supabaseResponse };
}
