/**
 * service-worker.js
 * - App shell is precached asset-by-asset (Promise.allSettled): one missing
 *   or failing file can NEVER abort the install.
 * - Same-origin files: cache-first with background refresh; navigations fall
 *   back to the cached index.html when offline.
 * - Map tiles: stale-while-revalidate (recently seen areas work offline).
 * - MapLibre from the CDN: cached on first load so the app starts offline.
 * - Routing / geocoding / weather API calls always go to the network.
 */

const CACHE_VERSION = 'beatdash-v3';
const APP_SHELL = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './boot.js',
  './gps.js',
  './geo.js',
  './heading.js',
  './orientation.js',
  './motion.js',
  './maneuver.js',
  './voice.js',
  './speedometer.js',
  './trip.js',
  './map.js',
  './ui.js',
  './storage.js',
  './bluetooth.js',
  './settings.js',
  './traffic.js',
  './weather.js',
  './navigation.js',
  './theme.js',
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
  './assets/icons/icon-maskable-512.png',
];

const TILE_HOSTS = ['tile.openstreetmap.org'];
const CDN_HOSTS = ['unpkg.com'];
const CDN_ASSETS = ['https://unpkg.com/maplibre-gl@3.6.2/dist/maplibre-gl.js', 'https://unpkg.com/maplibre-gl@3.6.2/dist/maplibre-gl.css'];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_VERSION);
    const local = await Promise.allSettled(APP_SHELL.map(async (path) => {
      const res = await fetch(new Request(path, { cache: 'reload' }));
      if (!res.ok) throw new Error(`${path} -> ${res.status}`);
      await cache.put(path, res);
    }));
    local.filter((r) => r.status === 'rejected').forEach((r) => console.warn('[sw] precache skipped:', r.reason && r.reason.message));
    // Best-effort: CDN files via CORS (unpkg sends ACAO:*) so the status can be CHECKED —
    // an opaque (no-cors) response could be an error page and must never be cached.
    await Promise.allSettled(CDN_ASSETS.map(async (url) => {
      const res = await fetch(url, { mode: 'cors' });
      if (!res.ok) throw new Error(`${url} -> ${res.status}`);
      await cache.put(url, res);
    }));
  })());
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
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Same-origin app files.
  if (url.origin === self.location.origin) {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE_VERSION);
      const cached = await cache.match(req, { ignoreSearch: req.mode === 'navigate' });
      const network = fetch(req)
        .then((res) => { if (res && res.ok && res.status === 200) cache.put(req, res.clone()); return res; })
        .catch(() => null);
      if (cached) { network.catch(() => {}); return cached; }
      const res = await network;
      if (res) return res;
      if (req.mode === 'navigate') {
        const shell = await cache.match('./index.html');
        if (shell) return shell;
      }
      return new Response('Offline', { status: 503, statusText: 'Offline' });
    })());
    return;
  }

  // MapLibre CDN: cache-first (versioned URL, immutable). Only verified-OK responses are stored.
  if (CDN_HOSTS.includes(url.hostname)) {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE_VERSION);
      const cached = await cache.match(req);
      if (cached) return cached;
      const res = await fetch(req);
      if (res && res.ok && res.type !== 'opaque') cache.put(req, res.clone());
      return res;
    })());
    return;
  }

  // Map tiles: stale-while-revalidate.
  if (TILE_HOSTS.includes(url.hostname)) {
    event.respondWith(
      caches.open(CACHE_VERSION).then(async (cache) => {
        const cached = await cache.match(req);
        const fetchPromise = fetch(req)
          .then((res) => { if (res && res.ok) cache.put(req, res.clone()); return res; })
          .catch(() => cached || Response.error());
        return cached || fetchPromise;
      })
    );
    return;
  }

  // Everything else (Nominatim, Overpass, OSRM, weather APIs) — straight to the network.
});
