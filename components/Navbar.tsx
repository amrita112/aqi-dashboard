/**
 * Navigation bar — appears at the top of every page.
 *
 * "use client" tells Next.js this component runs in the browser (not the server).
 * We need this because the navbar checks if the user is logged in and responds
 * to clicks (logout button), which requires browser-side JavaScript.
 */
"use client";

import Link from "next/link";        // Next.js component for linking between pages
import { useRouter } from "next/navigation";  // For redirecting the user after logout
import { useEffect, useState } from "react";  // React tools for managing state
import { createClient } from "@/lib/supabase/client";
import type { User } from "@supabase/supabase-js";

export default function Navbar() {
  // "state" is a way to store data that can change over time in a component.
  // Here we track the logged-in user (or null if not logged in).
  const [user, setUser] = useState<User | null>(null);
  const router = useRouter();
  const supabase = createClient();

  // useEffect runs code when the component first appears on screen.
  // Here it checks if someone is logged in and listens for login/logout changes.
  useEffect(() => {
    // Check if there's already a logged-in user
    supabase.auth.getUser().then(({ data: { user } }) => {
      setUser(user);
    });

    // Listen for login/logout events (e.g., user signs in on another tab)
    const { data: { subscription } } = supabase.auth.onAuthStateChange(
      (_event, session) => {
        setUser(session?.user ?? null);
      }
    );

    // Clean up the listener when the component is removed from the page
    return () => subscription.unsubscribe();
  }, []);

  // Handle the logout button click
  const handleLogout = async () => {
    await supabase.auth.signOut();
    setUser(null);
    router.push("/");  // Redirect to the home page
  };

  return (
    <nav className="bg-white border-b border-gray-200 px-6 py-3 flex items-center justify-between">
      {/* Left side: app name and main links */}
      <div className="flex items-center gap-6">
        <Link href="/" className="text-xl font-bold text-blue-600">
          AQI Dashboard
        </Link>
        <Link href="/dashboard" className="text-gray-600 hover:text-gray-900">
          Dashboard
        </Link>
        {/* Only show "Submit Reading" if the user is logged in */}
        {user && (
          <Link href="/submit" className="text-gray-600 hover:text-gray-900">
            Submit Reading
          </Link>
        )}
      </div>

      {/* Right side: login/signup or logout */}
      <div className="flex items-center gap-4">
        {user ? (
          <>
            {/* Show the user's email and a logout button */}
            <span className="text-sm text-gray-500">{user.email}</span>
            <button
              onClick={handleLogout}
              className="text-sm text-red-600 hover:text-red-800"
            >
              Log out
            </button>
          </>
        ) : (
          <>
            {/* Show login and signup links */}
            <Link href="/login" className="text-gray-600 hover:text-gray-900">
              Log in
            </Link>
            <Link
              href="/signup"
              className="bg-blue-600 text-white px-4 py-2 rounded-md text-sm hover:bg-blue-700"
            >
              Sign up
            </Link>
          </>
        )}
      </div>
    </nav>
  );
}
