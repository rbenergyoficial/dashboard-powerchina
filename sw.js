/* Service Worker — PWA Indicador de Desempenho Mauriti
 * Estratégia:
 *  - Dados Way2 (blob Azure / *.json) -> SEMPRE rede, nunca cache (gráfico ao vivo)
 *  - Documento (index.html) -> network-first (garante dashboard sempre atualizado)
 *  - CDNs e ícones -> stale-while-revalidate (rápido + funciona offline)
 * skipWaiting + clients.claim = novas versões assumem na hora (atualização automática).
 */
const VERSION = 'v7';
const CACHE = 'pwc-mauriti-' + VERSION;
const APP_SHELL = [
  '/',
  '/index.html',
  '/manifest.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png'
];

self.addEventListener('install', e => {
  // AUTO-UPDATE: o SW novo assume IMEDIATAMENTE (skipWaiting), sem depender de banner —
  // combinado com clients.claim no activate, cada deploy chega sozinho ao navegador do
  // usuário (era isso que prendia a aba normal na versão velha; a anônima não tem SW).
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

// Recebe ordem da página para ativar imediatamente (clique em "Atualizar")
self.addEventListener('message', e => {
  if (e.data === 'SKIP_WAITING' || e.data?.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
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

  // 2) Navegação / documento -> network-first + notifica páginas se mudou
  if (req.mode === 'navigate' || req.destination === 'document') {
    e.respondWith((async () => {
      try {
        // {cache:'no-store'}: nunca aceita o index.html do cache HTTP do navegador — sempre
        // busca fresco na rede. Garante que o dashboard reflita o último deploy a cada carga.
        const res = await fetch(req, { cache: 'no-store' });
        const cache = await caches.open(CACHE);
        const cached = await cache.match('/index.html');
        const newLen = res.headers.get('content-length') || res.headers.get('etag') || '';
        const oldLen = cached ? (cached.headers.get('content-length') || cached.headers.get('etag') || '') : '';
        // Só notifica se já tinha cache anterior E mudou (evita notificar na primeira carga)
        if (cached && newLen && oldLen && newLen !== oldLen) {
          const clients = await self.clients.matchAll({type:'window'});
          clients.forEach(c => c.postMessage({type:'CONTENT_UPDATED'}));
        }
        cache.put('/index.html', res.clone()).catch(() => {});
        return res;
      } catch (_) {
        return (await caches.match('/index.html')) || (await caches.match('/'));
      }
    })());
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
