/**
 * Supabase server client.
 *
 * This creates a connection to Supabase that runs on the server (not in the browser).
 * Server-side code is more secure because the user can't see or tamper with it.
 *
 * Used for: fetching data in server components (pages that render on the server
 * before being sent to the browser).
 */

import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

/**
 * Creates a Supabase client for server-side use.
 * It reads the user's login session from cookies (small pieces of data
 * the browser sends with every request to identify who you are).
 */
export function createClient() {
  const cookieStore = cookies();

  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        /**
         * These three functions let Supabase read, write, and delete cookies.
         * This is how it keeps track of whether a user is logged in.
         */
        get(name: string) {
          return cookieStore.get(name)?.value;
        },
        set(name: string, value: string, options: any) {
          try {
            cookieStore.set({ name, value, ...options });
          } catch {
            // This can fail when called from a Server Component (read-only context).
            // It's safe to ignore — the cookie will be set on the next request.
          }
        },
        remove(name: string, options: any) {
          try {
            cookieStore.set({ name, value: "", ...options });
          } catch {
            // Same as above — safe to ignore in read-only contexts.
          }
        },
      },
    }
  );
}
