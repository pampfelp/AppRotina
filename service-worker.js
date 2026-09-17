/*
  service-worker.js — AppRotina

  PREFIXO OBRIGATÓRIO NO NOME DO CACHE. `caches.keys()` devolve os caches da
  ORIGEM inteira, e pampfelp.github.io hospeda também o SolarGreen-ERP
  (sg-shell-*), a Jornada do Milhão (jm-*) e o Track Bravos do Norte (tbn-*).
  Um activate que apagasse "tudo que não é o meu cache" derrubaria o offline
  dos outros três apps. Foi exatamente esse bug, pego no teste antes de
  subir, que virou o caso 4 de antecipacao.md D1. Aqui só os caches com
  prefixo `rot-` são tocados.

  O cache guarda o esqueleto estático, nunca chamada de dados: Firestore e
  Google Calendar precisam estar sempre frescos, e a persistência offline do
  próprio SDK do Firestore já cuida do dado (ver firebase-init.js).
*/

const PREFIXO = "rot-";
const CACHE_NAME = `${PREFIXO}v5`; // sobe a cada mudança relevante de asset
const SHELL = [
  "./",
  "./index.html",
  "./style.css?v=5",
  "./app.js?v=5",
  "./shared.js",
  "./auth.js",
  "./agenda.js",
  "./firebase-init.js",
  "./manifest.json?v=5",
];

self.addEventListener("install", (e) => {
  /*
    { cache: "reload" } por arquivo, não caches.addAll() puro: o cache HTTP
    comum do navegador é uma camada diferente do Cache Storage do service
    worker, e sem isso ele serve JS/CSS velho mesmo com o SW novo instalado
    (achado real no Sistema IEQ Tapajós, 2026-08-24).
  */
  e.waitUntil(
    caches.open(CACHE_NAME).then((cache) =>
      Promise.all(SHELL.map((url) =>
        fetch(url, { cache: "reload" })
          .then((res) => cache.put(url, res))
          .catch(() => {}) // asset ausente não pode derrubar a instalação
      ))
    )
  );
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((chaves) =>
      Promise.all(
        chaves
          .filter((k) => k.startsWith(PREFIXO) && k !== CACHE_NAME)
          .map((k) => caches.delete(k))
      )
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (e) => {
  const url = e.request.url;

  const chamadaDeApi =
    url.includes("googleapis.com") ||        // Firestore e Google Calendar
    url.includes("accounts.google.com") ||   // Google Identity Services
    url.includes("gstatic.com/firebasejs") || // SDK — deixa o cache HTTP normal cuidar
    url.includes("firebaseio.com");

  if (e.request.method !== "GET" || chamadaDeApi) return;
  if (!url.startsWith(self.location.origin)) return; // fontes e CDN ficam com o navegador

  e.respondWith(
    fetch(e.request)
      .then((res) => {
        const clone = res.clone();
        caches.open(CACHE_NAME).then((c) => c.put(e.request, clone)).catch(() => {});
        return res;
      })
      // fallback lido SÓ do cache deste app, nunca caches.match() global
      .catch(() => caches.open(CACHE_NAME).then((c) => c.match(e.request)))
  );
});
