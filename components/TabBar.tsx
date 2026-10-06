"use client";

/**
 * The bottom tab bar.
 *
 * At the bottom rather than the top because this is built to be installed to a
 * phone's home screen, and the bottom of a phone is where a thumb is. On iOS a
 * home-screen web app has no browser chrome at all, so this is the only
 * navigation the person has.
 *
 * Hidden during first run. /setup is a focused three-question flow with its own
 * Back and Continue; a tab bar underneath would invite someone to wander off
 * mid-setup and arrive at a home screen that has no location to show. Once
 * preferences exist, Settings reaches the same screen deliberately.
 */

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { TABS, isAppRoute, isCurrentTab } from "@/lib/nav";
import { loadPrefs } from "@/lib/prefs";

export default function TabBar() {
  const pathname = usePathname();
  // Whether first run is done. Read in an effect because localStorage does not
  // exist during server rendering; null means "not known yet", and the bar
  // stays hidden rather than flashing in and out.
  const [configured, setConfigured] = useState<boolean | null>(null);

  useEffect(() => {
    setConfigured(loadPrefs() !== null);
  }, [pathname]);

  if (!isAppRoute(pathname)) return null;
  if (pathname.startsWith("/setup")) return null;
  if (configured !== true) return null;

  return (
    <nav
      aria-label="Main"
      className="fixed inset-x-0 bottom-0 z-40 border-t border-gray-200 bg-white/95 backdrop-blur"
      // iPhones with a home indicator need the bar lifted clear of it, or the
      // last few pixels of the tap target sit under the system gesture area.
      style={{ paddingBottom: "env(safe-area-inset-bottom, 0px)" }}
    >
      <ul className="mx-auto flex max-w-lg">
        {TABS.map((tab) => {
          const active = isCurrentTab(tab.href, pathname);
          return (
            <li key={tab.href} className="flex-1">
              <Link
                href={tab.href}
                aria-current={active ? "page" : undefined}
                // min-h-14 keeps every tap target above the ~44px minimum that
                // a finger needs.
                className={`flex min-h-14 flex-col items-center justify-center gap-0.5 px-2 py-2 text-xs ${
                  active ? "text-blue-700" : "text-gray-500 hover:text-gray-800"
                }`}
              >
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={active ? 2.1 : 1.7}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  className="h-6 w-6"
                  aria-hidden="true"
                >
                  <path d={tab.icon} />
                </svg>
                <span className={active ? "font-semibold" : ""}>{tab.label}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
