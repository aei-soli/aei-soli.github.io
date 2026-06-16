/**
 * sw.js — SELF-DESTRUCT service worker.
 *
 * The web build no longer uses a service worker. The old cache-first SW caused
 * stale-asset mismatches after deploys (e.g. an old cached renderer.js loading
 * alongside a fresh skins.js → "Identifier 'PALETTE' has already been declared").
 *
 * This version takes control, deletes ALL caches, unregisters itself, and reloads
 * open pages — so any browser that still has the old SW heals to fresh network files.
 * Once unregistered, the site simply loads from the network/CDN like a normal site.
 */

self.addEventListener("install", () => self.skipWaiting());

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    // 1. delete every cache this origin created
    const keys = await caches.keys();
    await Promise.all(keys.map((k) => caches.delete(k)));
    // 2. remove this service worker
    await self.registration.unregister();
    // 3. reload any open tabs so they fetch fresh assets (no SW in the way)
    const clients = await self.clients.matchAll({ type: "window" });
    clients.forEach((c) => c.navigate(c.url));
  })());
});

// No fetch handler — requests go straight to the network/CDN.
