/**
 * service-worker.js
 * App-shell precache (cache-first) + runtime cache for map tiles
 * (stale-while-revalidate). Everything else (Nominatim/Overpass/OSRM API
 * calls, third-party scripts) passes straight through to the network.
 */

const CACHE_VERSION = 'beatdash-v1';
const APP_SHELL = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './boot.js',
  './gps.js',
  './speedometer.js',
  './motion.js',
  './trip.js',
  './map.js',
  './ui.js',
  './storage.js',
  './bluetooth.js',
  './settings.js',
  './manifest.json',
  './assets/images/honda-logo.png',
  './assets/icons/icon-72.png',
  './assets/icons/icon-96.png',
  './assets/icons/icon-128.png',
  './assets/icons/icon-144.png',
  './assets/icons/icon-152.png',
  './assets/icons/icon-192.png',
  './assets/icons/icon-384.png',
  './assets/icons/icon-512.png',
];

const TILE_HOSTS = ['tile.openstreetmap.org'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) => cache.addAll(APP_SHELL)).catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // App shell: cache-first, falling back to network, then updating cache.
  if (url.origin === self.location.origin) {
    event.respondWith(
      caches.match(event.request).then((cached) => {
        const fetchPromise = fetch(event.request)
          .then((networkRes) => {
            if (networkRes && networkRes.ok) {
              const clone = networkRes.clone();
              caches.open(CACHE_VERSION).then((cache) => cache.put(event.request, clone));
            }
            return networkRes;
          })
          .catch(() => cached);
        return cached || fetchPromise;
      })
    );
    return;
  }

  // Map tiles: stale-while-revalidate so recently viewed areas work offline.
  if (TILE_HOSTS.includes(url.hostname)) {
    event.respondWith(
      caches.open(CACHE_VERSION).then(async (cache) => {
        const cached = await cache.match(event.request);
        const fetchPromise = fetch(event.request)
          .then((networkRes) => {
            if (networkRes && networkRes.ok) cache.put(event.request, networkRes.clone());
            return networkRes;
          })
          .catch(() => cached);
        return cached || fetchPromise;
      })
    );
    return;
  }

  // Everything else (Nominatim, Overpass, OSRM, MapLibre CDN, etc.) — passthrough.
});
