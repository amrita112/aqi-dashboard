/**
 * Sharing: the phone's own share menu where there is one, and something
 * useful where there is not.
 *
 * WHY THE SYSTEM SHARE MENU, NOT A ROW OF WHATSAPP / X / FACEBOOK BUTTONS.
 * The menu already lists whatever the person actually uses, in their order,
 * and it can carry an IMAGE, which a link-based button cannot. In India that
 * mostly means WhatsApp, and WhatsApp takes the image with the text as its
 * caption.
 *
 * WHAT IS NEVER SHARED: anything the person did not see on screen and choose
 * to send. The text names the place shown on the card they pressed, and the
 * image is that card's chart. No coordinates, no saved preferences.
 *
 * Fallbacks, in order, for browsers without the menu (most laptops):
 *   an image to share   -> downloaded as a PNG
 *   text only           -> copied to the clipboard
 */

/** The app's public address, put at the end of everything shared. */
export const SITE_URL = "https://airgyaan.in";

/**
 * What "Share AirGyaan" on Home sends: the app itself, not a forecast. Text
 * only, pointing at the install page, because the point is to get someone to
 * add the app, and a forecast for a city they may not live in does not.
 */
export const APP_SHARE_TEXT = `AirGyaan is an app that helps you manage your exposure to air pollution. Click to download: ${SITE_URL}/install`;

/**
 * The closing line for a shared chart or answer: what it is from, and where to
 * see the same for your own area.
 */
export const SEE_YOUR_AREA = `See the forecast for your area: ${SITE_URL}`;

/** "A", "A and B", "A, B and C". */
export function listNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

export type ShareOutcome = "shared" | "cancelled" | "copied" | "downloaded" | "failed";

export interface ShareContent {
  /** The message, already ending with SITE_URL where a link belongs. */
  text: string;
  /** A PNG of the chart, when there is one. */
  image?: Blob | null;
  /** File name for the image, e.g. "airgyaan-forecast.png". */
  fileName?: string;
}

export async function share({ text, image, fileName = "airgyaan.png" }: ShareContent): Promise<ShareOutcome> {
  const file = image ? new File([image], fileName, { type: "image/png" }) : null;

  try {
    // The image AND the text, where the browser can share files (Android
    // Chrome, iPhone Safari).
    if (file && navigator.canShare?.({ files: [file] })) {
      await navigator.share({ files: [file], text });
      return "shared";
    }
    // No file sharing: the text alone through the menu, when the menu exists
    // and there is no image that would be lost by doing so.
    if (!file && typeof navigator.share === "function") {
      await navigator.share({ text });
      return "shared";
    }
  } catch (err) {
    // Closing the menu without choosing anything is not a failure.
    if ((err as Error)?.name === "AbortError") return "cancelled";
    // Anything else (no user gesture left, a file type refused): fall through
    // to the fallbacks below rather than showing an error.
  }

  if (image) {
    try {
      const href = URL.createObjectURL(image);
      const a = document.createElement("a");
      a.href = href;
      a.download = fileName;
      a.click();
      setTimeout(() => URL.revokeObjectURL(href), 10_000);
      return "downloaded";
    } catch {
      return "failed";
    }
  }

  try {
    await navigator.clipboard.writeText(text);
    return "copied";
  } catch {
    return "failed";
  }
}

/** What to say after a share, when the result is worth mentioning. */
export function shareOutcomeMessage(outcome: ShareOutcome): string | null {
  switch (outcome) {
    case "copied":
      return "Copied — paste it anywhere.";
    case "downloaded":
      return "Image saved.";
    case "failed":
      return "Could not share from this browser.";
    default:
      return null;
  }
}
