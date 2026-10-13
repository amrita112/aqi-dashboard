"use client";

/**
 * The last resort: an error in the root layout itself.
 *
 * This replaces the entire document, which is why it has to render its own
 * <html> and <body> — the layout that would normally provide them is the thing
 * that failed. It also means no Tailwind class is guaranteed to have loaded,
 * so the few styles here are inline.
 *
 * Should never appear. Exists because "should never" is not "cannot", and the
 * alternative is a white screen with no way to report itself.
 */

import { useEffect } from "react";
import { reportError } from "@/lib/report-error";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    reportError(error, "root layout");
  }, [error]);

  return (
    <html lang="en-IN">
      <body style={{ fontFamily: "system-ui, sans-serif", padding: "3rem 1.5rem", textAlign: "center" }}>
        <h1 style={{ fontSize: "1.25rem", fontWeight: 600 }}>The app did not start</h1>
        <p style={{ marginTop: "0.75rem", color: "#4b5563" }}>
          Something went wrong on our side. It has been reported automatically.
        </p>
        <button
          type="button"
          onClick={reset}
          style={{
            marginTop: "1.5rem",
            background: "#2563eb",
            color: "#fff",
            border: 0,
            borderRadius: "0.5rem",
            padding: "0.625rem 1rem",
            fontWeight: 500,
          }}
        >
          Try again
        </button>
      </body>
    </html>
  );
}
