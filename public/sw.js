// Service Worker für Zeiterfassung PWA
// Strategie: Network-first mit Cache-Fallback (App funktioniert offline,
// bekommt aber immer die neueste Version sobald online)

const CACHE_NAME = "zeiterfassung-v1";

self.addEventListener("install", (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(["/", "/manifest.json"]))
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  // API-Aufrufe (Notion-Proxy) niemals cachen – die gehen immer live raus
  if (event.request.method !== "GET") return;
  if (url.pathname.startsWith("/api/")) return;

  event.respondWith(
    fetch(event.request)
      .then((response) => {
        // Erfolgreiche Antworten in den Cache legen
        const copy = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
        return response;
      })
      .catch(() =>
        // Offline: aus dem Cache bedienen, notfalls die Startseite
        caches.match(event.request).then((cached) => cached || caches.match("/"))
      )
  );
});
