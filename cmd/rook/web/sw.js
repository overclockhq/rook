// rook local PWA service worker.
//
// Goals:
//   - Make the app installable and openable offline (app shell precache).
//   - NEVER serve stale live data: anything under /api/ is always network-first.
//   - Keep the static shell fast: stale-while-revalidate (instant cache,
//     silent background refresh).
//
// Dependency-free vanilla JS. Bump CACHE_NAME to invalidate the old shell.

const CACHE_NAME = 'rook-shell-v1';

// The app shell: everything needed to boot the UI with no network.
// Live data is fetched at runtime and is intentionally excluded.
const SHELL_ASSETS = [
  '/',
  '/index.html',
  '/app.js',
  '/style.css',
  '/favicon.svg',
  '/manifest.webmanifest',
];

// Install: precache the shell and activate immediately.
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(SHELL_ASSETS))
      // Take over without waiting for existing tabs to close.
      .then(() => self.skipWaiting()),
  );
});

// Activate: drop any caches from previous versions, then claim open clients.
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key !== CACHE_NAME)
            .map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

// Network-first: for live endpoints. Try the network; on failure fall back to
// any cached copy (which normally won't exist for /api/, so failures surface).
function networkFirst(request) {
  return fetch(request).catch(() => caches.match(request));
}

// Stale-while-revalidate: serve the cached shell asset instantly while fetching
// a fresh copy in the background to update the cache for next time.
function staleWhileRevalidate(request) {
  return caches.open(CACHE_NAME).then((cache) =>
    cache.match(request).then((cached) => {
      const network = fetch(request)
        .then((response) => {
          // Only cache successful, basic (same-origin) responses.
          if (response && response.ok && response.type === 'basic') {
            cache.put(request, response.clone());
          }
          return response;
        })
        .catch(() => cached);
      // Fast path: cached if present, otherwise wait for the network.
      return cached || network;
    }),
  );
}

self.addEventListener('fetch', (event) => {
  const { request } = event;

  // Non-GET (POST/PUT/DELETE/etc.): never touch the cache — pass through.
  if (request.method !== 'GET') {
    return;
  }

  const url = new URL(request.url);

  // Only manage our own origin; let cross-origin requests pass through.
  if (url.origin !== self.location.origin) {
    return;
  }

  // Live data under /api/ must always hit the network first.
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(networkFirst(request));
    return;
  }

  // Everything else is static shell: stale-while-revalidate.
  event.respondWith(staleWhileRevalidate(request));
});
