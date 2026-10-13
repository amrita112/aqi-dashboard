/**
 * Tell the server something broke, and never make things worse by doing it.
 *
 * Three rules, each learned from how error reporting usually goes wrong:
 *
 *   NEVER THROW. A reporter that throws inside an error handler turns one
 *   broken screen into an infinite loop. Every path here is wrapped.
 *
 *   NEVER REPORT THE SAME THING TWICE. A render error fires on every retry,
 *   and an interval that throws fires forever. Without a cap, one person with
 *   one bug fills the table and hides everyone else's.
 *
 *   NEVER SEND THE QUERY STRING. Only the pathname. The server strips it too,
 *   but the data should not leave the device in the first place.
 */

/** Messages already sent this page load, so a loop reports once. */
const seen = new Set<string>();

/** Hard cap per page load, in case the messages themselves vary. */
const MAX_PER_PAGE = 5;
let sent = 0;

/**
 * Chrome, Safari, Firefox or Other.
 *
 * The browser FAMILY and nothing more. The full user agent string is long
 * enough to help single out a device, and "it only breaks on iOS" is the only
 * question this needs to answer.
 */
function browserFamily(): string {
  if (typeof navigator === "undefined") return "unknown";
  const ua = navigator.userAgent;
  // Order matters: Edge and Chrome both claim Safari, Chrome claims Safari.
  if (/EdgiOS|Edg\//.test(ua)) return "edge";
  if (/CriOS|Chrome\//.test(ua)) return "chrome";
  if (/FxiOS|Firefox\//.test(ua)) return "firefox";
  if (/Safari\//.test(ua)) return "safari";
  return "other";
}

export function reportError(error: unknown, context?: string): void {
  try {
    if (sent >= MAX_PER_PAGE) return;

    const err = error instanceof Error ? error : null;
    const message = [context, err ? err.message : String(error)]
      .filter(Boolean)
      .join(": ")
      .slice(0, 300);
    if (!message) return;

    if (seen.has(message)) return;
    seen.add(message);
    sent += 1;

    void fetch("/api/client-error", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message,
        stack: err?.stack?.slice(0, 1000) ?? null,
        // Pathname only — see the note at the top of this file.
        pathname: typeof location !== "undefined" ? location.pathname : null,
        browser: browserFamily(),
      }),
      // The page may be navigating away or crashing; this survives both.
      keepalive: true,
    }).catch(() => {
      /* offline, blocked, or the endpoint is down. Nothing to do. */
    });
  } catch {
    /* reporting must never be the thing that breaks */
  }
}
