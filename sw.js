/* Service worker — mantém o app atualizado e funcionando offline.
   Estratégia:
   - Arquivos do app (mesmo domínio): NETWORK-FIRST → sempre pega a versão nova
     quando tem internet; se estiver offline, usa o cache.
   - CDNs (Firebase, fontes, Font Awesome): cache-first (mais rápido). */
const CACHE = 'treino-v43';
const ASSETS = [
  './',
  './index.html',
  './app.js',
  './firebase-config.js',
  './manifest.webmanifest',
  './icon-192.png',
  './icon-512.png',
  './apple-touch-icon.png'
];

self.addEventListener('install', e => {
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).catch(()=>{}));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);

  if (url.origin === location.origin) {
    // NETWORK-FIRST: versão nova sempre que houver internet
    e.respondWith(
      fetch(e.request).then(res => {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, copy)).catch(()=>{});
        return res;
      }).catch(() =>
        caches.match(e.request).then(hit => hit || caches.match('./index.html'))
      )
    );
  } else {
    // CDNs: cache-first
    e.respondWith(
      caches.match(e.request).then(hit => hit || fetch(e.request).then(res => {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, copy)).catch(()=>{});
        return res;
      }))
    );
  }
});
