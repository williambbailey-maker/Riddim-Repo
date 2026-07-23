/* Riddim service worker — precaches the app shell so the library
   opens instantly and works fully offline. Audio files live in
   IndexedDB, so they never touch this cache. */

const CACHE = 'riddim-v4';

const SHELL = [
  './',
  './index.html',
  './css/style.css',
  './js/db.js',
  './js/app.js',
  './manifest.webmanifest',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE).then(cache => cache.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const { request } = event;
  if (request.method !== 'GET') return;

  event.respondWith(
    caches.match(request, { ignoreSearch: true }).then(cached => {
      // Serve from cache, refresh in the background (stale-while-revalidate).
      const refresh = fetch(request)
        .then(response => {
          if (response.ok && new URL(request.url).origin === location.origin) {
            const copy = response.clone();
            caches.open(CACHE).then(cache => cache.put(request, copy));
          }
          return response;
        })
        .catch(() => cached);
      return cached || refresh;
    })
  );
});
