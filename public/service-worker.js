// Minimaler Service Worker - macht die Seite als "echte" App installierbar.
self.addEventListener('install', function (e) {
  self.skipWaiting();
});
self.addEventListener('activate', function (e) {
  self.clients.claim();
});
self.addEventListener('fetch', function (e) {
  // Einfach normal durchreichen - keine echte Offline-Funktion nötig für den Anfang.
  e.respondWith(fetch(e.request));
});
