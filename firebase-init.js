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
import { getAuth, connectAuthEmulator } from "https://www.gstatic.com/firebasejs/12.16.0/firebase-auth.js";

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

/** E-mails autorizados. Precisa bater com a lista das firestore.rules. */
export const EMAILS_AUTORIZADOS = ["felipecastiged@gmail.com"];

const app = initializeApp(firebaseConfig);

export const db = initializeFirestore(app, {
  localCache: persistentLocalCache({ tabManager: persistentSingleTabManager() }),
});

export const auth = getAuth(app);

export const configurado = !String(firebaseConfig.apiKey).includes("COLE_AQUI");

if (new URLSearchParams(location.search).get("emulator") === "1") {
  connectFirestoreEmulator(db, "localhost", 8080);
  connectAuthEmulator(auth, "http://localhost:9099");
  console.log("[firebase-init] usando emulador local");
}
