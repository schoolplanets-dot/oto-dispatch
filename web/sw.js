/* Service worker web-приложения ОТО: оболочка приложения доступна при кратковременной потере сети,
   REST API (/api/v1) всегда идёт в сеть (оперативные данные не кэшируются), тайлы подложки кэшируются. */
const SHELL = 'oto-shell-v3', TILES = 'oto-tiles-v1';
self.addEventListener('install', e => { e.waitUntil(caches.open(SHELL).then(c => c.addAll(['/', '/manifest.webmanifest', '/icon.svg', '/icon-192.png'])).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== SHELL && k !== TILES).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.pathname.startsWith('/api/')) return; // API — только сеть
  if (/tile\.openstreetmap\.org|arcgisonline\.com/.test(u.host)) { // тайлы: из кэша, иначе сеть
    e.respondWith(caches.open(TILES).then(c => c.match(e.request).then(r => r || fetch(e.request).then(n => { if (n.ok || n.type === 'opaque') c.put(e.request, n.clone()); return n; })))); return;
  }
  if (u.origin !== location.origin) return;
  e.respondWith(fetch(e.request).then(n => { if (n.ok) caches.open(SHELL).then(c => c.put(e.request, n.clone())); return n; }).catch(() => caches.match(e.request).then(r => r || caches.match('/'))));
});
