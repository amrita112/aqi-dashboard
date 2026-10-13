/** @type {import('next').NextConfig} */

/**
 * Response headers, set before the app went public.
 *
 * Next sets none of these by default. Each one below closes something that is
 * cheap to close and awkward to explain afterwards. Deliberately NOT a
 * Content-Security-Policy: this app loads OpenStreetMap tiles from a rotating
 * set of subdomains and Leaflet injects inline styles, so a CSP written
 * without being able to watch a real page load would most likely ship a
 * broken map rather than a safer one. That is worth doing with a browser open,
 * not from a config file.
 */
const securityHeaders = [
  // The app has no business being framed. Clickjacking a petition signature
  // or a "forget my data" button is the specific thing this prevents.
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },

  // Stop browsers guessing a response is HTML when we said it was JSON.
  { key: "X-Content-Type-Options", value: "nosniff" },

  // Referrers leak where someone came from. A path like /petition says
  // something about a person; cross-origin requests get the origin only.
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },

  // THIS APP HAS NO GEOLOCATION, by a decision taken in September: every user
  // picks their place explicitly. Saying so in a header means a future
  // dependency cannot quietly start asking for it, and the browser enforces
  // what the design already promised. Same for the camera and microphone,
  // which nothing here will ever need.
  {
    key: "Permissions-Policy",
    value: "geolocation=(), camera=(), microphone=(), payment=(), usb=()",
  },

  // Vercel already serves HTTPS and redirects to it; this stops the first
  // request of a later visit going out in the clear. Two years, including
  // subdomains, which is the standard preload-eligible value.
  {
    key: "Strict-Transport-Security",
    value: "max-age=63072000; includeSubDomains",
  },
];

const nextConfig = {
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
