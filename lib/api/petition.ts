/**
 * The petition's consent terms.
 *
 * In their own module because a Next.js route file may only export HTTP method
 * handlers and a small set of config values — exporting constants from it
 * fails the build. The page, the route and the tests all import from here, so
 * there is exactly one copy of the wording a signatory is shown.
 */

/**
 * What a signatory is told they are agreeing to.
 *
 * Stamped onto every row at insert (see migration 16) rather than merely
 * displayed. If this wording is ever changed, rows signed under the old text
 * still carry the old text, so nobody is retroactively taken to have agreed to
 * something they never read.
 */
export const PETITION_PURPOSE =
  "Support for building hyperlocal air quality measurement in India. Shown as an aggregate count publicly; name and city may be shown to funders in aggregate or anonymised form; email used only to contact signatories who opted in.";

/** Signatures are deleted after this, unless withdrawn sooner. */
export const RETENTION_YEARS = 2;

/**
 * What someone asking for their city is told they are agreeing to.
 *
 * Separate wording from the petition, stamped on the row the same way, because
 * they are agreeing to a different thing: a request to be covered, not support
 * for a funding case. Someone who asks for Indore has not thereby signed a
 * petition, and the row should never be countable as though they had.
 */
export const CITY_REQUEST_PURPOSE =
  "A request to add this city to the app. Counted publicly per city; email used only to tell this person when their city is added, and deleted with the request.";

/** The promise made on the screen, kept in one place so it cannot drift. */
export const CITY_REQUEST_THRESHOLD = 50;
