/**
 * Who sees the "add to home screen" hint.
 *
 * It exists because Apple has never offered an install prompt and never will:
 * on iOS the only route is Share → Add to Home Screen, Safari gives no sign it
 * exists, and without installing there is no full-screen app and no push
 * notifications later.
 *
 * The detection has to be narrow. Every false positive shows someone an
 * instruction they cannot follow — Chrome on iOS has no Add to Home Screen,
 * nor does Instagram's in-app browser — and a confident wrong instruction is
 * worse than none in an app whose whole argument is not overclaiming.
 *
 * These used to be re-implemented here, copied out of the component because it
 * read `navigator` at module scope and could not be driven from a test. They
 * now live in lib/install.ts as plain functions shared by the hint and the
 * /install page, so the test drives the REAL ones — a copy that agrees with
 * itself proves nothing.
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import { isIosSafari as realIsIosSafari, isInAppBrowser, isStandalone } from "@/lib/install";

afterEach(() => vi.unstubAllGlobals());

/** Drive the real predicate by standing up the navigator it reads. */
function isIosSafari(ua: string, platform = "iPhone", maxTouchPoints = 5): boolean {
  vi.stubGlobal("navigator", { userAgent: ua, platform, maxTouchPoints });
  return realIsIosSafari();
}

const SAFARI_IPHONE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1";
const CHROME_IPHONE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/122.0 Mobile/15E148 Safari/604.1";
const CHROME_ANDROID =
  "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Mobile Safari/537.36";
const INSTAGRAM_IOS =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Instagram 320.0.0 (iPhone14,5; iOS 17_4)";
const SAFARI_MAC =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15";

describe("who gets the hint", () => {
  it("shows it to Safari on iPhone — the one browser that needs it", () => {
    expect(isIosSafari(SAFARI_IPHONE)).toBe(true);
  });

  it("shows it on iPadOS, which reports itself as a Mac", () => {
    // iPadOS 13+ sends a desktop UA string; only the touch points give it away.
    expect(isIosSafari(SAFARI_MAC, "MacIntel", 5)).toBe(true);
  });
});

describe("who does not", () => {
  it("spares Android, where Chrome raises its own prompt", () => {
    expect(isIosSafari(CHROME_ANDROID, "Linux", 5)).toBe(false);
  });

  it("spares Chrome on iOS, which has no Add to Home Screen at all", () => {
    // Safari underneath, but the instruction would send someone hunting for a
    // menu item that does not exist.
    expect(isIosSafari(CHROME_IPHONE)).toBe(false);
  });

  it("spares in-app browsers, where the advice is simply wrong", () => {
    expect(isIosSafari(INSTAGRAM_IOS)).toBe(false);
  });

  it("spares a real desktop Mac", () => {
    // Same UA as iPadOS, distinguished only by touch points.
    expect(isIosSafari(SAFARI_MAC, "MacIntel", 0)).toBe(false);
  });
});

describe("in-app browsers", () => {
  it("knows it cannot install from inside Instagram", () => {
    // The likeliest way a shared link is opened, and the one place where every
    // install route is unavailable — so /install says so rather than offering
    // a button that does nothing.
    vi.stubGlobal("navigator", { userAgent: INSTAGRAM_IOS, platform: "iPhone", maxTouchPoints: 5 });
    expect(isInAppBrowser()).toBe(true);
  });

  it("does not mistake an ordinary browser for one", () => {
    vi.stubGlobal("navigator", { userAgent: CHROME_ANDROID, platform: "Linux", maxTouchPoints: 5 });
    expect(isInAppBrowser()).toBe(false);
  });
});

describe("already installed", () => {
  it("detects Apple's own standalone flag", () => {
    // The only reliable signal on iOS; display-mode covers everywhere else.
    vi.stubGlobal("navigator", { userAgent: SAFARI_IPHONE, standalone: true });
    vi.stubGlobal("matchMedia", () => ({ matches: false }));
    expect(isStandalone()).toBe(true);
  });

  it("detects display-mode standalone everywhere else", () => {
    vi.stubGlobal("navigator", { userAgent: CHROME_ANDROID });
    vi.stubGlobal("matchMedia", (q: string) => ({ matches: q.includes("standalone") }));
    expect(isStandalone()).toBe(true);
  });

  it("says no in an ordinary tab", () => {
    vi.stubGlobal("navigator", { userAgent: CHROME_ANDROID });
    vi.stubGlobal("matchMedia", () => ({ matches: false }));
    expect(isStandalone()).toBe(false);
  });
});

describe("the hint's dismissal", () => {
  it("keys dismissal under a namespaced key so it cannot collide", async () => {
    const src = await import("node:fs/promises").then((fs) =>
      fs.readFile("components/InstallHint.tsx", "utf8"),
    );
    expect(src).toMatch(/aqi\.installHint\.dismissed/);
    // Dismissed for good, not for a session: a banner that returns every visit
    // is an advertisement.
    expect(src).toMatch(/localStorage\.setItem/);
    // Storage access is wrapped, since it throws in a private window.
    expect(src).toMatch(/catch/);
  });
});
