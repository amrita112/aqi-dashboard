"use client";

/**
 * Whether the tab bar is on screen right now.
 *
 * SHARED, BECAUSE TWO PLACES HAVE TO AGREE. The bar is fixed — it is taken out
 * of the flow — so the page has to reserve its space itself: padding at the
 * bottom on a phone, on the left where it becomes a sidebar. The layout did
 * that unconditionally while the bar itself opted out in three cases, and on a
 * laptop that meant /install and /setup were pushed 224px right to clear a
 * sidebar that was not there. The page looked badly off-centre, which is what
 * Amrita saw.
 *
 * One hook, used by the bar and by the space reserved for it, so they cannot
 * disagree again.
 */

import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { isAppRoute } from "@/lib/nav";
import { loadPrefs } from "@/lib/prefs";

export function useTabBarVisible(): boolean {
  const pathname = usePathname();
  // Read in an effect because localStorage does not exist during server
  // rendering. Starting false means the first paint reserves no space and
  // then gains it, rather than reserving space that never gets filled.
  const [configured, setConfigured] = useState(false);

  useEffect(() => {
    setConfigured(loadPrefs() !== null);
  }, [pathname]);

  if (!isAppRoute(pathname)) return false;
  // First run is a focused flow with its own buttons; a tab bar underneath
  // invites wandering off and arriving at a home screen with no place set.
  if (pathname.startsWith("/setup")) return false;
  return configured;
}
