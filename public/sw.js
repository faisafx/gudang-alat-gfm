// Service Worker Pembersih Cache Otomatis:
// Memastikan browser selalu memuat file HTML, CSS, dan JS terbaru langsung dari server lokal
// tanpa pernah terjebak cache lama saat mulai-gudang.bat dijalankan.
self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.map((k) => caches.delete(k))))
      .then(() => self.registration.unregister())
      .then(() => self.clients.matchAll())
      .then((clients) => {
        clients.forEach((client) => {
          if (client.url && 'navigate' in client) {
            client.navigate(client.url).catch(() => {});
          }
        });
      })
  );
});
