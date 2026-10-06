// SuppleFacts service worker.
// Deliberately does NO caching: every request goes straight to the network, so the app
// can never show a stale page after you deploy. It exists so browsers treat SuppleFacts
// as an installable app. (Offline support can be added later if wanted.)
self.addEventListener('install', function () { self.skipWaiting(); });
self.addEventListener('activate', function (e) {
  e.waitUntil((async function () {
    // remove any caches an earlier version might have made, then take control
    var keys = await caches.keys();
    await Promise.all(keys.map(function (k) { return caches.delete(k); }));
    await self.clients.claim();
  })());
});
self.addEventListener('fetch', function () { /* network passthrough */ });
