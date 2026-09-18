/*
  Inicialização do Firebase — padrão consolidado (segundo-cerebro/padroes/arquitetura.md).
  SDK modular via CDN gstatic, sem npm nem bundler.

  Persistência offline ligada (persistentLocalCache): reabrir o app traz só
  o que mudou de verdade, e marcar uma caixinha sem sinal continua
  funcionando. Ver crença 10.

  A config abaixo NÃO é segredo — é a config pública do Firebase Web SDK e
  pode ir pro repositório sem problema (crença 13). A segurança de verdade
  vive nas firestore.rules, que neste projeto exigem login e só aceitam os
  e-mails da lista de autorizados.
*/

import { initializeApp } from "https://www.gstatic.com/firebasejs/12.16.0/firebase-app.js";
import {
  initializeFirestore,
  persistentLocalCache,
  persistentSingleTabManager,
  connectFirestoreEmulator,
} from "https://www.gstatic.com/firebasejs/12.16.0/firebase-firestore.js";
import {
  initializeAuth,
  indexedDBLocalPersistence,
  browserLocalPersistence,
  browserSessionPersistence,
  connectAuthEmulator,
} from "https://www.gstatic.com/firebasejs/12.16.0/firebase-auth.js";

export const firebaseConfig = {
  apiKey: "AIzaSyB2NeOyCUHYGwWzT6Vt8tKD0En-Iz-LmyA",
  authDomain: "approtina-54752.firebaseapp.com",
  projectId: "approtina-54752",
  storageBucket: "approtina-54752.firebasestorage.app",
  messagingSenderId: "1031461486725",
  appId: "1:1031461486725:web:727427ac70a19bfe33e9ec"
};

/*
  ID do cliente OAuth usado pelo Google Identity Services pra pedir o escopo
  do Google Agenda. Também não é segredo (client ID de app web é público por
  design; o que é segredo é o client secret, que este app nunca usa).
  Passo a passo pra gerar em README.md.
*/
export const GOOGLE_CLIENT_ID = "1031461486725-71b80n9ji0dj9je3ikbu3qblsclvea90.apps.googleusercontent.com";

/*
  Quem pode entrar. Cada e-mail desta lista ganha o próprio espaço em
  `usuarios/{email}/...` e nunca vê o do outro — a lista só decide quem
  entra, não quem vê o quê.

  Ela existe porque, sem lista, qualquer conta Google criaria espaço aqui e
  gastaria a mesma cota gratuita do projeto.

  PRECISA BATER com a lista das firestore.rules. Duas listas em mãos
  diferentes divergem em silêncio (crença 14): ao acrescentar alguém,
  acrescente nos dois lugares.
*/
export const EMAILS_AUTORIZADOS = [
  "felipecastiged@gmail.com",
  // "email-da-sua-mulher@gmail.com",
];

const app = initializeApp(firebaseConfig);

export const db = initializeFirestore(app, {
  localCache: persistentLocalCache({ tabManager: persistentSingleTabManager() }),
});

/*
  Persistência de sessão EXPLÍCITA, com cadeia de fallback, em vez de
  getAuth(app) simples.

  Por quê: getAuth() usa persistência padrão implícita, e o padrão
  implícito pode degradar em silêncio em certos navegadores/extensões sem
  avisar nada — Safari em modo privado, extensão de privacidade que
  restringe IndexedDB, alguns webviews de app instalado. O sintoma nesses
  casos é exatamente "voltou a pedir login depois do F5", sem erro nenhum
  no console pra apontar a causa (caso real, 2026-09-17: Felipe reportou
  F5 pedindo login de novo, no celular e no notebook).

  initializeAuth() com persistence:[...] é o jeito oficial de dar uma
  cadeia de fallback: tenta IndexedDB primeiro (mais robusto, sobrevive
  reload e fechar o navegador), cai pra localStorage se IndexedDB não
  estiver disponível, e cai pra sessão (sobrevive só reload, não fechar a
  aba) como último recurso — em vez de simplesmente falhar calado.

  A DETECÇÃO ABAIXO NÃO USA API INTERNA DO FIREBASE. O SDK não expõe
  publicamente qual persistência da lista ele escolheu (o método que faz
  essa escolha é interno, prefixado com "_", e pode mudar entre versões).
  Em vez de depender disso, o probe abre um IndexedDB e escreve um
  localStorage de teste por conta própria — os mesmos dois mecanismos que
  o SDK testa por trás — usando só API pública do navegador. O resultado é
  o que o SDK deve escolher, honesto sobre ser dedução e não confirmação.

  DIAGNOSTICO_SESSAO fica exposto pra quem precisar investigar de novo:
  abrir o console e digitar `DIAGNOSTICO_SESSAO` mostra o resultado.
*/
export const DIAGNOSTICO_SESSAO = { persistenciaAlvo: null, erro: null };

async function probarIndexedDB() {
  if (!("indexedDB" in window)) return false;
  return new Promise((resolve) => {
    try {
      const req = indexedDB.open("__probe_approtina__", 1);
      req.onupgradeneeded = () => { try { req.result.createObjectStore("x"); } catch (_) {} };
      req.onsuccess = () => { req.result.close(); indexedDB.deleteDatabase("__probe_approtina__"); resolve(true); };
      req.onerror = () => resolve(false);
      req.onblocked = () => resolve(false);
    } catch (_) { resolve(false); }
  });
}

function probarLocalStorage() {
  try {
    const k = "__probe_approtina__";
    localStorage.setItem(k, "1");
    localStorage.removeItem(k);
    return true;
  } catch (_) { return false; }
}

async function detectarPersistencia() {
  try {
    if (await probarIndexedDB()) return "indexedDB";
    if (probarLocalStorage()) return "localStorage";
    return "sessao";
  } catch (err) {
    DIAGNOSTICO_SESSAO.erro = err?.message || String(err);
    return "sessao";
  }
}

DIAGNOSTICO_SESSAO.persistenciaAlvo = await detectarPersistencia();

export const auth = initializeAuth(app, {
  persistence: [indexedDBLocalPersistence, browserLocalPersistence, browserSessionPersistence],
});

if (typeof window !== "undefined") window.DIAGNOSTICO_SESSAO = DIAGNOSTICO_SESSAO;

export const configurado = !String(firebaseConfig.apiKey).includes("COLE_AQUI");

if (new URLSearchParams(location.search).get("emulator") === "1") {
  connectFirestoreEmulator(db, "localhost", 8080);
  connectAuthEmulator(auth, "http://localhost:9099");
  console.log("[firebase-init] usando emulador local");
}
