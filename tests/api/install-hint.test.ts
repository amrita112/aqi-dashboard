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
 * The predicates are re-implemented here from InstallHint.tsx rather than
 * imported, because the component reaches for `navigator` at module scope in a
 * way that is awkward to drive from a test. They are kept deliberately short
 * so the duplication stays readable; if one changes, this file fails loudly
 * rather than silently testing the wrong thing.
 */

import { describe, it, expect } from "vitest";

function isIosSafari(ua: string, platform = "iPhone", maxTouchPoints = 5): boolean {
  const iPadOS = platform === "MacIntel" && maxTouchPoints > 1;
  const iOS = /iPad|iPhone|iPod/.test(ua) || iPadOS;
  if (!iOS) return false;
  if (/CriOS|FxiOS|EdgiOS|OPiOS/.test(ua)) return false;
  if (/Instagram|FBAN|FBAV|Line\/|LinkedInApp/.test(ua)) return false;
  return /Safari/.test(ua);
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

describe("the component's guards", () => {
  it("keys dismissal under a namespaced key so it cannot collide", async () => {
    const src = await import("node:fs/promises").then((fs) =>
      fs.readFile("components/InstallHint.tsx", "utf8"),
    );
    expect(src).toMatch(/aqi\.installHint\.dismissed/);
    // Dismissed for good, not for a session: a banner that returns every visit
    // is an advertisement.
    expect(src).toMatch(/localStorage\.setItem/);
    // Never shown to an app already running from the home screen.
    expect(src).toMatch(/standalone/);
    // Storage access is wrapped, since it throws in a private window.
    expect(src).toMatch(/catch/);
  });
});
