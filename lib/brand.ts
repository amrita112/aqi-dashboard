/**
 * The app's name, in one place.
 *
 * ⚠️ PLACEHOLDER. The name has never been decided — every mockup still says
 * "[App name]" — and it appears in four places a user actually sees:
 *
 *   - the label under the icon once it is on a phone's home screen
 *   - the browser tab and the install prompt
 *   - the title on every page
 *   - the domain, eventually
 *
 * Everything reads from here, so changing it is this one edit plus
 * regenerating the icons (scripts/make-icons.py). Done before launch, nobody
 * ever sees the placeholder.
 */

export const APP_NAME = "Saaf Hawa";

/** Shown under a home-screen icon, where roughly 12 characters survive. */
export const APP_SHORT_NAME = "Saaf Hawa";

export const APP_DESCRIPTION =
  "Tomorrow's air quality for seven Indian cities, built from the public monitoring network — and honest about how old the data is.";

/**
 * The colour the OS paints around the app: status bar on Android, the frame on
 * a desktop install. Deliberately the app's ink rather than an AQI band
 * colour, which would imply a reading the app has not made yet.
 */
export const THEME_COLOR = "#12171b";

/** Behind the splash screen while the app starts. Matches the page background. */
export const BACKGROUND_COLOR = "#f9fafb";
