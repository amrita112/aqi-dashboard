"use client";

/**
 * Counts opens of the INSTALLED app (home-screen launches), anonymously.
 *
 * Renders nothing. On mount, if the app is running standalone -- i.e. it was
 * opened from the home screen rather than in a browser tab -- it records one
 * `opened` event for today, carrying only how long ago this phone installed
 * the app (lib/launch.ts). A browser-tab visit records nothing here; Vercel
 * already counts those.
 */

import { useEffect } from "react";
import { isStandalone } from "@/lib/install";
import { trackLaunch } from "@/lib/analytics";

export default function LaunchTracker() {
  useEffect(() => {
    if (isStandalone()) trackLaunch();
  }, []);
  return null;
}
