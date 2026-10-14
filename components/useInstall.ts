"use client";

/**
 * The install state of this page load, for anything that offers installing.
 *
 * Shared by the hint on the home screen and the /install page so the two can
 * never disagree about whether installing is possible — they used to hold
 * separate copies of the same detection and would have drifted.
 */

import { useCallback, useEffect, useState } from "react";
import {
  isInAppBrowser,
  isIosSafari,
  isStandalone,
  type InstallPromptEvent,
} from "@/lib/install";
import { trackInstalled } from "@/lib/analytics";

export type InstallRoute = "unknown" | "prompt" | "ios" | "in_app" | "installed" | "none";

export function useInstall() {
  const [route, setRoute] = useState<InstallRoute>("unknown");
  const [prompt, setPrompt] = useState<InstallPromptEvent | null>(null);

  useEffect(() => {
    if (isStandalone()) return setRoute("installed");
    if (isInAppBrowser()) return setRoute("in_app");
    if (isIosSafari()) setRoute("ios");
    else setRoute("none");

    // Chrome fires this when it is willing to install, and suppresses its own
    // banner if nothing handles it — so without this listener there is no
    // prompt at all and people have to find Install in the three-dot menu.
    //
    // IT CAN ARRIVE LATE. Chrome decides after its own checks, so a page that
    // reads this once on mount may see nothing and be wrong a second later.
    // Hence a listener rather than a check.
    const onPrompt = (e: Event) => {
      e.preventDefault();
      setPrompt(e as InstallPromptEvent);
      setRoute("prompt");
    };
    const onInstalled = () => {
      trackInstalled("browser");
      setRoute("installed");
    };
    window.addEventListener("beforeinstallprompt", onPrompt);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onPrompt);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  /** Show the browser's install dialog. Only possible while `prompt` is set. */
  const install = useCallback(async () => {
    if (!prompt) return;
    await prompt.prompt();
    const { outcome } = await prompt.userChoice;
    // Counted separately from `appinstalled` so the two can be compared: this
    // one says our button did it rather than the browser menu.
    if (outcome === "accepted") trackInstalled("prompt");
    // Single use either way; Chrome fires a fresh one if still willing.
    setPrompt(null);
    if (outcome === "accepted") setRoute("installed");
  }, [prompt]);

  return { route, canPrompt: prompt !== null, install };
}
