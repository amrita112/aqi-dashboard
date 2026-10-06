/**
 * The web app manifest, generated rather than hand-written as JSON.
 *
 * Next.js serves this at /manifest.webmanifest. Generating it means the name
 * and colours come from lib/brand.ts, so renaming the app is one edit instead
 * of a hunt through a static file for a string that also appears in four other
 * places.
 *
 * What a browser needs before it will offer "Install": a name, a start_url,
 * display: standalone, icons at 192 and 512, and a service worker with a fetch
 * handler. All five are present — see public/sw.js for the last one.
 *
 * iOS ignores most of this. It takes the name from <title>, the icon from
 * apple-touch-icon, and only shows the app full-screen if the person uses
 * Share → Add to Home Screen. That is also the only way web push works there,
 * which is why the install prompt matters more than it looks.
 */

import type { MetadataRoute } from "next";
import {
  APP_NAME,
  APP_SHORT_NAME,
  APP_DESCRIPTION,
  THEME_COLOR,
  BACKGROUND_COLOR,
} from "@/lib/brand";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: APP_NAME,
    short_name: APP_SHORT_NAME,
    description: APP_DESCRIPTION,
    start_url: "/",
    display: "standalone",
    orientation: "portrait",
    background_color: BACKGROUND_COLOR,
    theme_color: THEME_COLOR,
    categories: ["health", "weather", "utilities"],
    lang: "en-IN",
    icons: [
      // "any" and "maskable" are listed separately on purpose. A launcher that
      // crops a maskable icon would cut the gauge off if it only had the
      // tightly-framed version; one that does not mask would show the
      // maskable version floating in too much padding.
      { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icon-192-maskable.png", sizes: "192x192", type: "image/png", purpose: "maskable" },
      { src: "/icon-512-maskable.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
