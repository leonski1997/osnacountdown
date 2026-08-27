// Minimaler Service Worker - macht die Seite als "echte" App installierbar,
// und empfängt zusätzlich Push-Benachrichtigungen im Hintergrund (FCM).

importScripts('https://www.gstatic.com/firebasejs/11.0.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/11.0.0/firebase-messaging-compat.js');

firebase.initializeApp({
  apiKey: "AIzaSyCj8vSVvdpFW4XxoDHxaNycbhb5-CbrbMQ",
  authDomain: "osnacountdown.firebaseapp.com",
  projectId: "osnacountdown",
  storageBucket: "osnacountdown.firebasestorage.app",
  messagingSenderId: "643165169880",
  appId: "1:643165169880:web:f4c5c3173a01fc75f50fad"
});

var messaging = firebase.messaging();

messaging.onBackgroundMessage(function (payload) {
  var daten = payload.data || {};
  var titel = daten.titel || 'Wieder in Osnabrück';
  var optionen = {
    body: daten.body || '',
    icon: '/icon.svg',
    data: daten
  };
  self.registration.showNotification(titel, optionen);
});

self.addEventListener('notificationclick', function (e) {
  e.notification.close();
  e.waitUntil(clients.openWindow('/'));
});

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

