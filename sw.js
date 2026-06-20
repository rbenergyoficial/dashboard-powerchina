/* Service Worker — PWA Indicador de Desempenho Mauriti
 * Estratégia:
 *  - Dados Way2 (blob Azure / *.json) -> SEMPRE rede, nunca cache (gráfico ao vivo)
 *  - Documento (index.html) -> network-first (garante dashboard sempre atualizado)
 *  - CDNs e ícones -> stale-while-revalidate (rápido + funciona offline)
 * skipWaiting + clients.claim = novas versões assumem na hora (atualização automática).
 */
const VERSION = 'v2';
const CACHE = 'pwc-mauriti-' + VERSION;
const APP_SHELL = [
  '/',
  '/index.html',
  '/manifest.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png'
];

self.addEventListener('install', e => {
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(APP_SHELL).catch(() => {})));
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  let url;
  try { url = new URL(req.url); } catch (_) { return; }

  // 1) Dados ao vivo do Way2 -> deixa o navegador buscar direto (sem cache do SW)
  if (/blob\.core\.windows\.net/i.test(url.hostname) ||
      /way2|intradia/i.test(url.href) ||
      /\.json($|\?)/i.test(url.href)) {
    return;
  }

  // 2) Navegação / documento -> network-first
  if (req.mode === 'navigate' || req.destination === 'document') {
    e.respondWith(
      fetch(req).then(res => {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put('/index.html', copy)).catch(() => {});
        return res;
      }).catch(() => caches.match('/index.html').then(r => r || caches.match('/')))
    );
    return;
  }

  // 3) Demais recursos (CDNs, ícones, fontes) -> stale-while-revalidate
  e.respondWith(
    caches.match(req).then(cached => {
      const net = fetch(req).then(res => {
        if (res && res.status === 200 && res.type !== 'opaqueredirect') {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {});
        }
        return res;
      }).catch(() => cached);
      return cached || net;
    })
  );
});
