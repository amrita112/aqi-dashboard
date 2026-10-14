/**
 * What the browser will and will not let us do about installing.
 *
 * THE CONSTRAINT WORTH KNOWING, because it shapes every screen that mentions
 * installing: there is no such thing as an install link. A PWA cannot be
 * installed by following a URL. The browser decides the app is installable,
 * then either offers it itself or hands us a one-shot event we may act on
 * while the person is looking at the page. Nothing can be sent in a message
 * that installs anything.
 *
 * So the best available version of "send me the app" is a page whose only job
 * is to install it — which is what /install is for.
 */

/** The event Chrome fires when it is willing to install; not in TS's lib. */
export interface InstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

/** Safari on iPhone or iPad, and not a WebView pretending to be one. */
export function isIosSafari(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent;

  // iPadOS 13+ reports itself as a Mac; the touch-point count gives it away.
  const iPadOS = navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1;
  const iOS = /iPad|iPhone|iPod/.test(ua) || iPadOS;
  if (!iOS) return false;

  // Chrome, Firefox and Edge on iOS are Safari underneath but expose no Share
  // → Add to Home Screen, so the instruction would be wrong for them.
  if (/CriOS|FxiOS|EdgiOS|OPiOS/.test(ua)) return false;

  // In-app browsers: Instagram, Facebook, Gmail, LinkedIn. Same problem, and
  // the likeliest way someone opens a link sent to them.
  if (/Instagram|FBAN|FBAV|Line\/|LinkedInApp/.test(ua)) return false;

  return /Safari/.test(ua);
}

/** An in-app browser, where installing is not offered by anyone. */
export function isInAppBrowser(): boolean {
  if (typeof navigator === "undefined") return false;
  return /Instagram|FBAN|FBAV|Line\/|LinkedInApp|Twitter|Snapchat/.test(navigator.userAgent);
}

/** Already running from the home screen. */
export function isStandalone(): boolean {
  if (typeof window === "undefined") return false;
  // `standalone` is Apple's own flag and the only reliable one on iOS; the
  // display-mode query covers everywhere else.
  const appleStandalone = (window.navigator as Navigator & { standalone?: boolean }).standalone;
  return Boolean(appleStandalone) || window.matchMedia("(display-mode: standalone)").matches;
}
