/**
 * The space reserved for the tab bar.
 *
 * The bar is `position: fixed`, so it is out of the flow and the page has to
 * reserve its space: padding at the bottom on a phone, on the left where it
 * becomes a sidebar. The layout reserved it unconditionally while the bar
 * itself opted out in three cases — so on a laptop, /install and /setup were
 * pushed 224px right to clear a sidebar that was not there, and the page sat
 * visibly off-centre.
 *
 * These pin the ROUTES the decision turns on. The visibility hook itself needs
 * a router and localStorage; what matters, and what went wrong, is that one
 * list decides both.
 */

import { describe, it, expect } from "vitest";
import { isAppRoute } from "@/lib/nav";

describe("routes the shell reserves space on", () => {
  it("reserves it on the tabbed screens", () => {
    for (const p of ["/", "/ask", "/map", "/trends", "/settings"]) {
      expect(isAppRoute(p), p).toBe(true);
    }
  });

  it("reserves nothing on a route outside the app", () => {
    // A page with no bar must not be padded for one.
    expect(isAppRoute("/nothing-here")).toBe(false);
  });

  it("treats /install and /setup as app routes, which the hook then overrides", () => {
    // Both ARE app routes — so the "is this an app route" test alone was never
    // enough, and the bar's other two conditions (first run in progress, no
    // preferences yet) are what actually hide it there. That mismatch is the
    // bug this file exists for.
    expect(isAppRoute("/install")).toBe(true);
    expect(isAppRoute("/setup")).toBe(true);
  });
});
