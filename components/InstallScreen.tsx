"use client";

/**
 * /install — the link to send someone when you tell them you have an app.
 *
 * THE PROBLEM THIS SOLVES, from a tester who had been told he was getting an
 * app: he got a URL, which asked him three setup questions in a browser, and
 * only then offered a button explaining that it could be saved to his home
 * screen and would "behave like an app". By then he had already decided what
 * this was, and it was a website.
 *
 * Nothing can make a PWA installable from a link — the browser has to offer
 * it, on a page the person is looking at. So this is the next best thing: a
 * page whose entire job is that one button, placed BEFORE the questions
 * rather than after them.
 *
 * INSTALLING FIRST IS ALSO TECHNICALLY BETTER, not just better presented. On
 * iOS a home-screen app does not share storage with Safari, so setup answers
 * given in the browser are NOT carried into the installed app — anyone who
 * sets up first on an iPhone has to do it twice. Installing first makes the
 * questions happen inside the app, once.
 *
 * And the way out is on the page. Someone on a laptop, or who simply does not
 * want another icon, should not have to work out that the thing also just
 * works in a browser.
 */

import Link from "next/link";
import { APP_NAME } from "@/lib/brand";
import { useInstall } from "@/components/useInstall";

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

export default function InstallScreen() {
  const { route, canPrompt, install } = useInstall();

  return (
    <main className="mx-auto flex min-h-[80vh] max-w-md flex-col justify-center px-6 py-10">
      <h1 className="text-center text-3xl font-bold tracking-tight">{APP_NAME}</h1>
      <p className="mt-3 text-center text-gray-600">
        Air quality where you are, for seven Indian cities. Free, no account.
      </p>

      <div className="mt-8">
        {route === "installed" && (
          <div className="rounded-xl border border-green-200 bg-green-50 p-5 text-center">
            <p className="font-medium text-green-900">You already have it installed.</p>
            <Link
              href="/"
              className="mt-4 inline-block rounded-lg bg-blue-600 px-5 py-3 font-medium text-white"
            >
              Open {APP_NAME}
            </Link>
          </div>
        )}

        {route === "prompt" && (
          <button
            type="button"
            onClick={install}
            disabled={!canPrompt}
            className="w-full rounded-xl bg-blue-600 px-5 py-4 text-lg font-semibold text-white disabled:opacity-50"
          >
            Install app
          </button>
        )}

        {route === "ios" && (
          <div className="rounded-xl border border-blue-200 bg-blue-50 p-5">
            <p className="font-semibold text-blue-950">Add it to your home screen</p>
            <p className="mt-2 text-sm text-blue-950/90">
              Tap <ShareIcon /> <strong>Share</strong> at the bottom of Safari, then{" "}
              <strong>Add to Home Screen</strong>.
            </p>
            <p className="mt-2 text-xs text-blue-950/70">
              Apple does not let apps like this install themselves, so this is the
              one step we cannot do for you.
            </p>
          </div>
        )}

        {route === "in_app" && (
          <div className="rounded-xl border border-amber-200 bg-amber-50 p-5">
            <p className="font-semibold text-amber-950">Open this in your browser first</p>
            <p className="mt-2 text-sm text-amber-950/90">
              You are reading this inside another app, which cannot install things.
              Tap the ⋯ menu and choose <strong>Open in browser</strong>, then come
              back to this page.
            </p>
          </div>
        )}

        {/* "none" and "unknown" share this. Chrome can decide a page is
            installable a second or two after it loads, so a flat "you cannot
            install this" would often be wrong the moment it was printed. */}
        {(route === "none" || route === "unknown") && (
          <div className="rounded-xl border border-gray-200 bg-white p-5 text-center">
            <p className="text-gray-700">
              Your browser has not offered to install this yet. In Chrome, the{" "}
              <strong>⋮</strong> menu has <strong>Install app</strong>. Everything
              works in the browser either way.
            </p>
          </div>
        )}
      </div>

      {/* ALWAYS VISIBLE, never a hidden fallback. Someone on a laptop should
          not have to deduce that it also just works. */}
      <Link
        href="/"
        className="mt-6 block text-center font-medium text-blue-700 underline"
      >
        Or use it in your browser
      </Link>

      <p className="mt-8 text-center text-xs text-gray-500">
        Installing adds an icon to your home screen and opens full screen. It is
        the same app either way — nothing is downloaded from a store.
      </p>
    </main>
  );
}
