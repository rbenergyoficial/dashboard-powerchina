/* Endereco aposentado em outubro de 2026. Este service worker substitui o do painel antigo:
   apaga o cache, se desinstala e recarrega as abas abertas, que passam a ver o aviso. */
self.addEventListener('install', function () { self.skipWaiting(); });
self.addEventListener('activate', function (e) {
  e.waitUntil((async function () {
    var ks = await caches.keys(); await Promise.all(ks.map(function (k) { return caches.delete(k); }));
    await self.registration.unregister();
    var cs = await self.clients.matchAll({ type: 'window' });
    cs.forEach(function (c) { c.navigate(c.url); });
  })());
});
