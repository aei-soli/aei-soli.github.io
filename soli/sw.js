/**
 * sw.js — SOLI Service Worker
 * Strategy: cache-first for all game assets (works offline after first visit).
 * Cache is versioned — bump CACHE_NAME on deploy to force refresh.
 */

const CACHE_NAME = "soli-v6";

const PRECACHE = [
  "./",
  "./index.html",
  "./manifest.json",
  // Capacitor bridge + AdMob plugin (vanilla JS — no bundler)
  "./capacitor.core.js",
  "./admob.plugin.js",
  // Core game logic
  "./core/card.js",
  "./core/engine.js",
  "./core/solver.js",
  "./core/stats.js",
  "./core/firebase.js",
  "./core/sound.js",
  // UI layer
  "./ui/ads.js",
  "./ui/renderer.js",
  "./ui/input.js",
  "./ui/game.js",
  // Icons
  "./icons/icon-192.png",
  "./icons/icon-512.png",
];

// ── Install: precache all assets ─────────────────────────────────────────────
self.addEventListener("install", event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(PRECACHE))
      .then(() => self.skipWaiting())
  );
});

// ── Activate: delete old caches ───────────────────────────────────────────────
self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

// ── Fetch: cache-first, fall back to network ─────────────────────────────────
self.addEventListener("fetch", event => {
  // Only handle same-origin GET requests (skip Firebase, Stripe, AdMob calls)
  if (event.request.method !== "GET") return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    caches.match(event.request).then(cached => {
      if (cached) return cached;
      return fetch(event.request).then(response => {
        // Cache successful responses for game assets
        if (response.ok) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        }
        return response;
      });
    })
  );
});
