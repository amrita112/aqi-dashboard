"use client";

/**
 * A slim offer to install, shown once.
 *
 * WHAT CHANGED AND WHY. The first tester to see this had been told he was
 * getting an app, and instead got a web page that asked him three questions
 * and then offered a button explaining that it would be saved to his home
 * screen and "behave like an app". Two separate problems: it came too late to
 * change what he thought he was looking at, and the language hedged.
 *
 * So: plainer words, and this now also appears at the top of the first setup
 * question rather than only after it. The dedicated /install page is the link
 * to send someone; this is for people who arrive at the app directly.
 *
 * Shown ONCE and dismissible for good. A banner that reappears every visit is
 * an advertisement, and this app's whole argument is that it does not
 * overclaim.
 */

import { useEffect, useState } from "react";
import { useInstall } from "@/components/useInstall";

const DISMISSED_KEY = "aqi.installHint.dismissed";

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

export default function InstallHint() {
  const { route, canPrompt, install } = useInstall();
  const [dismissed, setDismissed] = useState(true);

  useEffect(() => {
    try {
      setDismissed(Boolean(window.localStorage.getItem(DISMISSED_KEY)));
    } catch {
      // Storage blocked: show it, but it cannot be remembered as dismissed.
      setDismissed(false);
    }
  }, []);

  // Nothing to offer on a desktop browser that has not volunteered, inside an
  // app that cannot install, or when it is already installed.
  const offer = route === "prompt" || route === "ios";
  if (dismissed || !offer) return null;

  function dismiss() {
    setDismissed(true);
    try {
      window.localStorage.setItem(DISMISSED_KEY, "1");
    } catch {
      /* nothing to do */
    }
  }

  return (
    <aside className="rounded-lg border border-blue-200 bg-blue-50 px-3.5 py-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="font-semibold text-blue-950">Install the app</h2>
          {route === "prompt" ? (
            <>
              <p className="mt-0.5 text-sm text-blue-950/90">
                Adds it to your home screen and opens full screen.
              </p>
              <button
                type="button"
                onClick={install}
                disabled={!canPrompt}
                className="mt-2 rounded-lg bg-blue-700 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
              >
                Install
              </button>
            </>
          ) : (
            <p className="mt-0.5 text-sm text-blue-950/90">
              Tap <ShareIcon /> <strong>Share</strong> at the bottom of Safari, then{" "}
              <strong>Add to Home Screen</strong>.
            </p>
          )}
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
