self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open('openclaw-v1').then((cache) => cache.addAll([
      '/',
      '/index.html',
      '/favicon.ico',
      '/logo192.png',
      '/logo512.png',
      '/manifest.json'
    ])),
  );
});

self.addEventListener('fetch', (e) => {
  e.respondWith(
    caches.match(e.request).then((response) => response || fetch(e.request)),
  );
});
