"use client";

/**
 * The bottom tab bar.
 *
 * On a phone: pinned to the BOTTOM, because this is built to be installed to a
 * home screen and the bottom of a phone is where a thumb is. On iOS a
 * home-screen web app has no browser chrome at all, so this is the only
 * navigation the person has.
 *
 * On a laptop: a LEFT SIDEBAR. A full-width strip of five icons along the
 * bottom of a 27-inch monitor is a phone layout stretched, not a desktop one,
 * and the bottom edge of a large screen is the furthest point from where
 * anyone is looking. Same component, same links, same active state — only the
 * placement changes, so the two can never disagree about which tab is current.
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
      className={
        // A SOLID BAR, not a translucent one. At 95% opacity over a white
        // page the top edge was almost invisible, which is half of why the
        // icons did not read as a control strip.
        "fixed z-40 border-gray-300 bg-white shadow-[0_-1px_3px_rgba(0,0,0,0.06)] " +
        // Phone: full width along the bottom.
        "inset-x-0 bottom-0 border-t " +
        // Laptop: a fixed-width rail down the left, full height.
        "lg:inset-y-0 lg:right-auto lg:bottom-auto lg:w-56 lg:border-r lg:border-t-0"
      }
      // iPhones with a home indicator need the bar lifted clear of it, or the
      // last few pixels of the tap target sit under the system gesture area.
      style={{ paddingBottom: "env(safe-area-inset-bottom, 0px)" }}
    >
      <ul className="mx-auto flex max-w-lg lg:mx-0 lg:h-full lg:max-w-none lg:flex-col lg:justify-start lg:gap-1 lg:p-3 lg:pt-8">
        {TABS.map((tab) => {
          const active = isCurrentTab(tab.href, pathname);
          return (
            <li key={tab.href} className="flex-1 lg:flex-none">
              <Link
                href={tab.href}
                aria-current={active ? "page" : undefined}
                // min-h-14 keeps every tap target above the ~44px minimum that
                // a finger needs.
                // DARKER AND LARGER THAN IT WAS. A tester did not register
                // these as navigation at all: thin grey-400 glyphs with a
                // 10px label read as decoration along the bottom edge. In a
                // home-screen install this bar is the ONLY way to move around
                // — there is no address bar and no browser chrome — so it
                // failing to look tappable is not a styling nitpick.
                className={`flex min-h-14 flex-col items-center justify-center gap-1 px-2 py-2 text-[11px] font-medium lg:min-h-0 lg:flex-row lg:justify-start lg:gap-3 lg:rounded-lg lg:px-3 lg:py-2.5 lg:text-sm ${
                  active
                    ? "text-blue-700 lg:bg-blue-50 lg:font-medium"
                    : "text-gray-600 hover:text-gray-900 lg:hover:bg-gray-100"
                }`}
              >
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={active ? 2.4 : 2}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  className="h-7 w-7 lg:h-6 lg:w-6"
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
