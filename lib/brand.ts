/**
 * The app's name and the address people can reach a person at, in one place.
 *
 * The name appears in four places a user actually sees: the label under the
 * icon on a home screen, the browser tab and install prompt, the title on
 * every page, and the domain. Everything reads from here, so changing it is
 * this one edit plus regenerating the icons (scripts/make-icons.py) and
 * bumping the service worker VERSION, since the icons are in its shell cache.
 */

export const APP_NAME = "AirGyaan";

/** Shown under a home-screen icon, where roughly 12 characters survive. */
export const APP_SHORT_NAME = "AirGyaan";

export const APP_DESCRIPTION =
  "A weather app for AQI, so you can take control of your exposure to hazardous air.";

/**
 * The colour the OS paints around the app: status bar on Android, the frame on
 * a desktop install. Deliberately the app's ink rather than an AQI band
 * colour, which would imply a reading the app has not made yet.
 */
export const THEME_COLOR = "#12171b";

/** Behind the splash screen while the app starts. Matches the page background. */
export const BACKGROUND_COLOR = "#f9fafb";

/**
 * Where someone writes to about their own data.
 *
 * ⚠️ REPLACE THIS. It is printed on the privacy and terms pages, and India's
 * DPDP Act expects a real, reachable address for questions and withdrawal
 * requests — the petition page already says "email us" without giving one.
 *
 * USE A ROLE ADDRESS ON THE APP'S OWN DOMAIN, not a personal inbox. It will
 * sit in public HTML, which is where address harvesters look, and a role
 * address can be turned off and replaced without touching anything personal.
 * Namecheap includes free email forwarding with the domain, so
 * privacy@airgyaan.in can simply land in an existing inbox at no cost.
 */
export const CONTACT_EMAIL = "privacy@airgyaan.in";
