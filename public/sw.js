/**
 * Service worker.
 *
 * Two jobs, and deliberately not a third.
 *
 *   1. Exist, with a fetch handler. A browser will not offer "Install" without
 *      one, and on iOS installing to the home screen is the only way the app
 *      ever runs full-screen or receives a push notification.
 *
 *   2. Say something useful when the network is gone, instead of showing the
 *      browser's dinosaur.
 *
 * WHAT IT DOES NOT DO IS CACHE AIR QUALITY DATA. A cached forecast is a stale
 * forecast presented as a current one, and this whole product is built around
 * not doing that — the app already tells people how old its data is, and a
 * service worker quietly serving yesterday's answer would undercut the one
 * thing it is careful about. API responses are always fetched live; if the
 * network is down the screen says so.
 *
 * So only the app shell is cached: the HTML, the icons, the offline page.
 * Those are safe because they contain no readings.
 */

const VERSION = "v1";
const SHELL_CACHE = `shell-${VERSION}`;

// Enough to render something recognisable with no network. Deliberately short:
// every entry here is a thing that can go stale.
const SHELL = ["/offline.html", "/icon-192.png", "/apple-touch-icon.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      // addAll rejects the whole batch if any single entry 404s, which would
      // leave the worker uninstalled. Individually, a missing file costs only
      // that file.
      .then((cache) => Promise.allSettled(SHELL.map((url) => cache.add(url))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== SHELL_CACHE).map((k) => caches.delete(k))),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Never serve an API response from cache. See the note above: a cached
  // reading is a stale reading wearing a fresh one's clothes.
  if (url.pathname.startsWith("/api/")) return;

  // Navigations: try the network, fall back to the offline page. Not to a
  // cached copy of the real page, which would show whatever numbers happened
  // to be in it the last time the person looked.
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request).catch(() =>
        caches.match("/offline.html").then((r) => r ?? new Response("Offline", { status: 503 })),
      ),
    );
    return;
  }

  // Static assets: cache first, since an icon cannot be out of date in a way
  // that misleads anyone.
  event.respondWith(
    caches.match(request).then(
      (hit) =>
        hit ??
        fetch(request).then((response) => {
          if (response.ok && SHELL.includes(url.pathname)) {
            const copy = response.clone();
            caches.open(SHELL_CACHE).then((cache) => cache.put(request, copy));
          }
          return response;
        }),
    ),
  );
});
