"use client";

/**
 * Registers the service worker.
 *
 * A component rather than an inline script so it is typed, linted, and visible
 * to anyone reading the layout.
 *
 * Registration is what makes the browser offer "Install", and on iOS being
 * installed to the home screen is the only way the app ever runs full-screen
 * or can receive a push notification later. So this is not only about offline.
 *
 * Failure is swallowed deliberately: a service worker that will not register
 * (private browsing, an unsupported browser, a blocked scope) must not stop
 * the app working. Everything still functions without it.
 */

import { useEffect } from "react";

export default function ServiceWorkerRegistration() {
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    // Registered after load so it never competes with the first render for
    // bandwidth on a slow connection.
    const register = () => {
      navigator.serviceWorker.register("/sw.js").catch(() => {
        /* No service worker: the app works, it just will not install. */
      });
    };
    if (document.readyState === "complete") register();
    else {
      window.addEventListener("load", register);
      return () => window.removeEventListener("load", register);
    }
  }, []);

  return null;
}
