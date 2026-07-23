/* Riddim Repo service worker — precaches the app shell so the library
   opens instantly and works offline. Audio blobs are cached in
   IndexedDB, so they never touch this cache. */

const CACHE = 'riddim-v11';

const SHELL = [
  './',
  './index.html',
  './css/style.css',
  './js/db.js',
  './js/app.js',
  './js/config.js',
  './js/vendor/supabase.js',
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

  const url = new URL(request.url);
  // Never intercept API or storage traffic — only same-origin app shell.
  if (url.origin !== location.origin) return;

  event.respondWith(
    caches.match(request, { ignoreSearch: true }).then(cached => {
      const refresh = fetch(request)
        .then(response => {
          if (response.ok) {
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
