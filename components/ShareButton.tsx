"use client";

/**
 * A share button: labelled ("Share this forecast") or a bare icon, for the
 * Trends cards where a label would crowd the header.
 *
 * The content is built ON PRESS, not ahead of time, because the chart image
 * has to be taken from whatever is on screen at that moment — the range the
 * person picked, the places they are comparing.
 */

import { useState } from "react";
import { share, shareOutcomeMessage, type ShareContent } from "@/lib/share";

export default function ShareButton({
  label,
  build,
  className = "",
}: {
  /** Visible text. Omitted for the icon-only version, which still has a name for screen readers. */
  label?: string;
  build: () => Promise<ShareContent>;
  className?: string;
}) {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  async function onPress() {
    if (busy) return;
    setBusy(true);
    setNote(null);
    try {
      const message = shareOutcomeMessage(await share(await build()));
      if (message) {
        setNote(message);
        setTimeout(() => setNote(null), 3_000);
      }
    } catch {
      setNote("Could not share from this browser.");
    } finally {
      setBusy(false);
    }
  }

  return (
    // Never part of a shared image itself.
    <span data-share-exclude className={`inline-flex items-center gap-2 ${className}`}>
      <button
        type="button"
        onClick={() => void onPress()}
        disabled={busy}
        aria-label={label ? undefined : "Share"}
        title={label ? undefined : "Share"}
        className={
          label
            ? "inline-flex items-center gap-1.5 rounded-full border border-gray-300 bg-white px-3.5 py-1.5 text-sm font-medium text-gray-800 hover:bg-gray-50 disabled:opacity-50"
            : "inline-flex h-8 w-8 items-center justify-center rounded-full text-gray-600 hover:bg-gray-100 disabled:opacity-50"
        }
      >
        <ShareIcon />
        {label}
      </button>
      {note && (
        <span role="status" className="text-xs text-gray-600">
          {note}
        </span>
      )}
    </span>
  );
}

/** Three linked dots: the share mark Android and most of the web use. */
function ShareIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
      <circle cx="18" cy="5" r="3" />
      <circle cx="6" cy="12" r="3" />
      <circle cx="18" cy="19" r="3" />
      <path d="M8.6 13.5l6.8 4M15.4 6.5l-6.8 4" />
    </svg>
  );
}
