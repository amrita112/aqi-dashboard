/**
 * Supabase browser client.
 *
 * This creates a connection to your Supabase database that runs in the user's browser.
 * Think of it like opening a connection to a remote database — similar to how you'd
 * connect to a Postgres database in Python, but this one works from the browser.
 *
 * Used for: login, signup, submitting readings, fetching data on the client side.
 */

import { createBrowserClient } from "@supabase/ssr";

/**
 * Creates and returns a Supabase client for browser-side use.
 * The two environment variables tell the client where your database lives
 * and how to authenticate with it.
 */
export function createClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,      // Your Supabase project URL (like a database address)
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!   // A public API key (safe to use in browser code)
  );
}
