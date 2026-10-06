"use client";

/**
 * Telling iPhone users this can be installed, because nothing else will.
 *
 * Apple has never offered an install prompt and never will — on iOS the only
 * route is Share → Add to Home Screen, and Safari gives no hint that it
 * exists. So an iPhone user has no way to discover the app can be installed,
 * and without installing it they get no full-screen app and, later, no push
 * notifications: iOS delivers push only to home-screen installs, never to a
 * browser tab.
 *
 * Android needs nothing from us. Chrome raises its own prompt once the
 * manifest, icons and service worker are in place, which they are.
 *
 * Shown ONCE and dismissible for good. A banner that reappears every visit is
 * an advertisement, and this app's whole argument is that it does not
 * overclaim — pestering someone about installing it would undercut that for a
 * feature they get no benefit from if they do not want it.
 *
 * Deliberately NOT shown:
 *   - on Android, where the browser handles it
 *   - in an already-installed app, where it would be absurd
 *   - during first run, which is a focused flow with its own buttons
 *   - inside an in-app browser (Instagram, Gmail), where Add to Home Screen
 *     does not exist and the advice would simply be wrong
 */

import { useEffect, useState } from "react";

const DISMISSED_KEY = "aqi.installHint.dismissed";

/** Safari on iPhone or iPad, and not a WebView pretending to be one. */
function isIosSafari(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent;

  // iPadOS 13+ reports itself as a Mac; the touch-point count gives it away.
  const iPadOS =
    navigator.platform === "MacIntel" && (navigator as Navigator).maxTouchPoints > 1;
  const iOS = /iPad|iPhone|iPod/.test(ua) || iPadOS;
  if (!iOS) return false;

  // Chrome, Firefox and Edge on iOS are Safari underneath but expose no Share
  // → Add to Home Screen, so the instruction below would be wrong for them.
  if (/CriOS|FxiOS|EdgiOS|OPiOS/.test(ua)) return false;

  // In-app browsers: Instagram, Facebook, Gmail, LinkedIn. Same problem.
  if (/Instagram|FBAN|FBAV|Line\/|LinkedInApp/.test(ua)) return false;

  return /Safari/.test(ua);
}

/** Already running from the home screen. */
function isStandalone(): boolean {
  if (typeof window === "undefined") return false;
  // `standalone` is Apple's own flag and is the only reliable one on iOS; the
  // display-mode query covers everywhere else.
  const appleStandalone = (window.navigator as Navigator & { standalone?: boolean }).standalone;
  return Boolean(appleStandalone) || window.matchMedia("(display-mode: standalone)").matches;
}

export default function InstallHint() {
  const [show, setShow] = useState(false);

  useEffect(() => {
    if (isStandalone() || !isIosSafari()) return;
    try {
      if (window.localStorage.getItem(DISMISSED_KEY)) return;
    } catch {
      // Storage blocked: show it, but it cannot be remembered as dismissed.
      // Better than hiding a one-off hint entirely.
    }
    setShow(true);
  }, []);

  if (!show) return null;

  function dismiss() {
    setShow(false);
    try {
      window.localStorage.setItem(DISMISSED_KEY, "1");
    } catch {
      /* nothing to do */
    }
  }

  return (
    <aside className="rounded-lg border border-blue-200 bg-blue-50 p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="font-semibold text-blue-950">Keep this on your home screen</h2>
          <p className="mt-1 text-sm text-blue-950/90">
            Tap{" "}
            <ShareIcon />{" "}
            <strong>Share</strong> at the bottom of Safari, then{" "}
            <strong>Add to Home Screen</strong>. It opens full screen, like an app.
          </p>
        </div>
        <button
          type="button"
          onClick={dismiss}
          aria-label="Dismiss"
          className="-mr-1 -mt-1 shrink-0 rounded p-1.5 text-blue-900/60 hover:bg-blue-100 hover:text-blue-900"
        >
          <svg viewBox="0 0 20 20" className="h-4 w-4" fill="none" stroke="currentColor"
               strokeWidth={2} strokeLinecap="round" aria-hidden="true">
            <path d="M5 5l10 10M15 5L5 15" />
          </svg>
        </button>
      </div>
    </aside>
  );
}

/** iOS's share glyph, so the instruction points at something recognisable. */
function ShareIcon() {
  return (
    <svg
      viewBox="0 0 24 24" className="inline-block h-4 w-4 -translate-y-px align-middle"
      fill="none" stroke="currentColor" strokeWidth={1.8}
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"
    >
      <path d="M12 3v12M12 3 8.5 6.5M12 3l3.5 3.5" />
      <path d="M6 11H4.5v9.5h15V11H18" />
    </svg>
  );
}
