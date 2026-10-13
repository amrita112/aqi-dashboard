"use client";

/**
 * What someone sees when a screen throws while rendering.
 *
 * Next's default is a blank page in production, which is the worst of both
 * worlds: the person cannot tell whether the app is broken or their connection
 * is, and we never hear about it. This reports the error and offers the two
 * things that actually help — try again, or go somewhere that works.
 *
 * DELIBERATELY DOES NOT SHOW THE ERROR MESSAGE. A minified React error is
 * frightening and tells a reader nothing they can act on. The message goes to
 * us instead, which is the whole point of the reporting.
 */

import { useEffect } from "react";
import Link from "next/link";
import { reportError } from "@/lib/report-error";

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    reportError(error, "render");
  }, [error]);

  return (
    <main className="mx-auto max-w-lg px-5 py-16 text-center">
      <h1 className="text-xl font-semibold">This screen did not load</h1>
      <p className="mt-3 text-gray-600">
        Something went wrong on our side, not yours. It has been reported
        automatically.
      </p>
      <div className="mt-6 flex flex-wrap justify-center gap-3">
        <button
          type="button"
          onClick={reset}
          className="rounded-lg bg-blue-600 px-4 py-2.5 font-medium text-white"
        >
          Try again
        </button>
        <Link
          href="/"
          className="rounded-lg border border-gray-300 px-4 py-2.5 font-medium text-gray-800"
        >
          Go to the forecast
        </Link>
      </div>
      {/* The digest is Next's own id for the error, and the one thing that
          connects what someone saw to what we recorded. Small, and only
          useful if they mention it. */}
      {error.digest && (
        <p className="mt-8 text-xs text-gray-400">Reference: {error.digest}</p>
      )}
    </main>
  );
}
