/**
 * Which navigation a route gets.
 *
 * Two products share this codebase: the original crowdsourced-readings app
 * with a top Navbar, and the forecast app with a bottom tab bar. Both read
 * isAppRoute(), so the thing worth pinning is that no route can be claimed by
 * both — which would stack two navigation bars on one screen — or by neither,
 * which would strand it with no way out.
 */

import { describe, it, expect } from "vitest";
import { TABS, isAppRoute, isCurrentTab } from "@/lib/nav";

const FORECAST_APP = ["/", "/ask", "/setup", "/petition", "/trends", "/trends/delhi", "/map"];
const LEGACY_APP = ["/dashboard", "/submit", "/login", "/signup"];

describe("route ownership", () => {
  it("claims the forecast app's routes", () => {
    for (const p of FORECAST_APP) expect(isAppRoute(p)).toBe(true);
  });

  it("leaves the original app's routes to the top navbar", () => {
    for (const p of LEGACY_APP) expect(isAppRoute(p)).toBe(false);
  });

  it("does not let '/' swallow everything", () => {
    // A naive startsWith('/') check would claim every route in the codebase,
    // including the legacy pages, and put two navs on each of them.
    expect(isAppRoute("/dashboard")).toBe(false);
  });

  it("covers every tab, or a tab would render with no bar to sit in", () => {
    for (const tab of TABS) expect(isAppRoute(tab.href)).toBe(true);
  });
});

describe("which tab is current", () => {
  it("highlights Today only on the home screen", () => {
    // Exact match for "/", or every route in the app would light it up.
    expect(isCurrentTab("/", "/")).toBe(true);
    expect(isCurrentTab("/", "/ask")).toBe(false);
    expect(isCurrentTab("/", "/setup")).toBe(false);
  });

  it("highlights a tab on its own sub-routes", () => {
    // So a future /trends/delhi still shows the Trends tab as current.
    expect(isCurrentTab("/trends", "/trends/delhi")).toBe(true);
    expect(isCurrentTab("/ask", "/ask")).toBe(true);
  });

  it("highlights at most one tab for any route in the app", () => {
    for (const p of FORECAST_APP) {
      const lit = TABS.filter((t) => isCurrentTab(t.href, p));
      expect(lit.length).toBeLessThanOrEqual(1);
    }
  });
});

describe("the tabs themselves", () => {
  it("is five, each with a label and an icon", () => {
    expect(TABS).toHaveLength(5);
    for (const t of TABS) {
      expect(t.label.length).toBeGreaterThan(0);
      expect(t.icon.length).toBeGreaterThan(10);
      expect(t.href.startsWith("/")).toBe(true);
    }
  });

  it("does not put the petition in the tab bar", () => {
    // It belongs on the staleness card, where it follows from something the
    // person just read — not sitting on screen permanently asking for a name.
    expect(TABS.map((t) => t.href)).not.toContain("/petition");
  });

  it("has no duplicate destinations", () => {
    expect(new Set(TABS.map((t) => t.href)).size).toBe(TABS.length);
  });
});
