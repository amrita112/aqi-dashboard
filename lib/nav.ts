/**
 * Which routes belong to the forecast app, and what the tabs are.
 *
 * Two products share this codebase. The original crowdsourced-readings app
 * (/dashboard, /submit, /login, /signup) still works and keeps its top Navbar.
 * The forecast app is everything below, and uses a bottom tab bar instead.
 *
 * Both navs read this one list, so they can never both decide a route is
 * theirs and stack two navigation bars on the same screen.
 */

export interface Tab {
  href: string;
  label: string;
  /** Inline SVG path data, so no icon dependency is added for four glyphs. */
  icon: string;
}

/**
 * The tab bar. Deliberately three, not five.
 *
 * Settings is a tab rather than buried, because the three setup answers are
 * the only thing a person can get wrong, and changing your location is a
 * normal thing to want — someone checking on family in another city switches
 * back and forth.
 *
 * The petition is NOT a tab. It is reached from the staleness card, where it
 * follows from something the person just read, rather than sitting permanently
 * on screen asking for a signature.
 */
export const TABS: Tab[] = [
  {
    href: "/",
    label: "Today",
    // House
    icon: "M3 10.5 12 3l9 7.5M5.25 9.75V20.25h13.5V9.75",
  },
  {
    href: "/ask",
    label: "Ask",
    // Speech bubble
    icon: "M8.25 19.5 12 21.75V19.5h4.5a2.25 2.25 0 0 0 2.25-2.25V6.75A2.25 2.25 0 0 0 16.5 4.5h-9A2.25 2.25 0 0 0 5.25 6.75v10.5a2.25 2.25 0 0 0 2.25 2.25h.75Z",
  },
  {
    href: "/setup",
    label: "Settings",
    // Sliders
    icon: "M6 4.5v6m0 3v6m6-15v9m0 3v3m6-15v3m0 3v9M3.75 10.5h4.5m1.5 3h4.5m1.5-6h4.5",
  },
];

/** Routes that belong to the forecast app and get the bottom tab bar. */
const APP_PREFIXES = ["/ask", "/setup", "/petition", "/trends"];

export function isAppRoute(pathname: string): boolean {
  return pathname === "/" || APP_PREFIXES.some((p) => pathname.startsWith(p));
}

/**
 * Which tab, if any, is current.
 *
 * Exact match for "/" so every route does not light up Today, prefix match
 * elsewhere so a future /trends/delhi still highlights its tab.
 */
export function isCurrentTab(tabHref: string, pathname: string): boolean {
  return tabHref === "/" ? pathname === "/" : pathname.startsWith(tabHref);
}
