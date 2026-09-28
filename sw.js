/* TRALIX EDITOR — service worker: offline app shell */
const CACHE = 'tralix-v3';
const ASSETS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/style.css',
  './js/app.js', './js/editor.js', './js/panels.js', './js/dialogs.js',
  './js/export.js', './js/home.js', './js/timeline.js', './js/player.js',
  './js/render.js', './js/fx.js', './js/audio.js', './js/ai.js',
  './js/media.js', './js/model.js', './js/idb.js', './js/util.js',
  './fonts/orbitron-latin-400-normal.woff2', './fonts/orbitron-latin-700-normal.woff2',
  './fonts/orbitron-latin-900-normal.woff2', './fonts/rajdhani-latin-500-normal.woff2',
  './fonts/rajdhani-latin-600-normal.woff2', './fonts/rajdhani-latin-700-normal.woff2',
  './fonts/bebas-neue-latin-400-normal.woff2', './fonts/chakra-petch-latin-600-normal.woff2',
  './fonts/chakra-petch-latin-700-normal.woff2',
  './icons/icon.svg', './icons/icon-192.png', './icons/icon-512.png', './icons/icon-maskable-512.png',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  e.respondWith(
    caches.match(e.request).then(hit => hit || fetch(e.request).then(res => {
      if (res.ok && new URL(e.request.url).origin === location.origin) {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, copy));
      }
      return res;
    }).catch(() => caches.match('./index.html')))
  );
});
