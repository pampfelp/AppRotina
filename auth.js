/*
  auth.js — login do AppRotina.

  Crença 1 diz que autenticação nunca tem default, e a resposta do Felipe em
  2026-09-17 foi: login com Google E com e-mail/senha, os dois.

  Detalhe que evita uma armadilha real: os dois métodos precisam cair na
  MESMA conta, senão o Google gera um uid e o e-mail/senha gera outro, e ele
  veria duas listas de tarefas diferentes dependendo de como entrou. A
  solução aqui não é vincular credencial (que quebra quando ele esquece qual
  usou primeiro): as firestore.rules autorizam por E-MAIL, não por uid, e os
  documentos não carregam dono. Os dois logins do mesmo e-mail leem e
  escrevem exatamente o mesmo dado.
*/

import { auth, EMAILS_AUTORIZADOS } from "./firebase-init.js";
import {
  GoogleAuthProvider,
  signInWithPopup,
  signInWithRedirect,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  sendPasswordResetEmail,
  onAuthStateChanged,
  signOut,
  fetchSignInMethodsForEmail,
} from "https://www.gstatic.com/firebasejs/12.16.0/firebase-auth.js";

import { toast, esc, ICONS } from "./shared.js";

const ESCOPO_AGENDA = "https://www.googleapis.com/auth/calendar.events";

function autorizado(user) {
  const email = (user?.email || "").toLowerCase();
  return EMAILS_AUTORIZADOS.some((e) => e.toLowerCase() === email);
}

/** Traduz os códigos do Firebase Auth pra frase que dá pra agir. */
function mensagemErro(err) {
  const c = err?.code || "";
  if (c === "auth/invalid-credential" || c === "auth/wrong-password") return "E-mail ou senha não conferem.";
  if (c === "auth/user-not-found") return "Não existe conta com esse e-mail. Use “Criar senha”.";
  if (c === "auth/email-already-in-use") return "Já existe conta com esse e-mail. Entre pela senha ou pelo Google.";
  if (c === "auth/weak-password") return "A senha precisa de pelo menos 6 caracteres.";
  if (c === "auth/invalid-email") return "E-mail inválido.";
  if (c === "auth/too-many-requests") return "Muitas tentativas. Espere um minuto e tente de novo.";
  if (c === "auth/popup-blocked") return "O navegador bloqueou a janela do Google. Liberando o pop-up resolve.";
  if (c === "auth/popup-closed-by-user") return "Janela do Google fechada antes de terminar.";
  if (c === "auth/unauthorized-domain") return "Este domínio não está autorizado no Firebase Auth. Ver passo 5 do README.";
  if (c === "auth/operation-not-allowed") return "O provedor não está ativado no console do Firebase. Ver passo 5 do README.";
  return err?.message || "Não foi possível entrar.";
}

/* ───────────────────────── tela de login ───────────────────────── */

export function montarTelaLogin() {
  const el = document.getElementById("tela-login");
  let modo = "entrar"; // "entrar" | "criar"

  function render() {
    el.innerHTML = `
      <div class="login-card">
        <div class="login-marca">
          <span class="ico">${ICONS.hoje}</span>
          <strong>AppRotina</strong>
        </div>
        <p class="sub">Suas rotinas fixas, o checklist do dia e o que ficou atrás.</p>

        <button type="button" class="btn btn-google bloco" id="btn-google">
          <span class="ico">${ICONS.google}</span> Entrar com Google
        </button>

        <div class="divisor">ou</div>

        <div class="field">
          <label for="in-email">E-mail</label>
          <input id="in-email" type="email" autocomplete="username" inputmode="email" placeholder="voce@gmail.com" />
        </div>
        <div class="field">
          <label for="in-senha">Senha</label>
          <input id="in-senha" type="password" autocomplete="${modo === "criar" ? "new-password" : "current-password"}" placeholder="mínimo 6 caracteres" />
        </div>

        <button type="button" class="btn primary bloco" id="btn-entrar">
          ${modo === "criar" ? "Criar conta e entrar" : "Entrar"}
        </button>

        <div style="display:flex; justify-content:space-between; align-items:center; margin-top:12px;">
          <button type="button" class="login-alt" id="btn-modo">
            ${modo === "criar" ? "Já tenho senha" : "Criar senha"}
          </button>
          <button type="button" class="login-alt" id="btn-reset" style="color:var(--ink-soft);">
            Esqueci a senha
          </button>
        </div>
      </div>`;

    const inEmail = el.querySelector("#in-email");
    const inSenha = el.querySelector("#in-senha");

    el.querySelector("#btn-modo").addEventListener("click", () => {
      modo = modo === "criar" ? "entrar" : "criar";
      const email = inEmail.value;
      render();
      el.querySelector("#in-email").value = email;
    });

    el.querySelector("#btn-google").addEventListener("click", entrarComGoogle);

    el.querySelector("#btn-entrar").addEventListener("click", async () => {
      const email = inEmail.value.trim();
      const senha = inSenha.value;
      if (!email) return toast("Informe o e-mail.", "erro");
      if (senha.length < 6) return toast("A senha precisa de pelo menos 6 caracteres.", "erro");
      try {
        if (modo === "criar") {
          /*
            Se já existe conta Google com esse e-mail, criar senha falharia
            com account-exists-with-different-credential e a mensagem crua
            não explica nada. Checar antes deixa o caminho claro.
          */
          const metodos = await fetchSignInMethodsForEmail(auth, email).catch(() => []);
          if (metodos.includes("google.com") && !metodos.includes("password")) {
            return toast("Esse e-mail já entra pelo Google. Use o botão do Google.", "erro");
          }
          await createUserWithEmailAndPassword(auth, email, senha);
        } else {
          await signInWithEmailAndPassword(auth, email, senha);
        }
      } catch (err) {
        toast(mensagemErro(err), "erro");
      }
    });

    inSenha.addEventListener("keydown", (e) => {
      if (e.key === "Enter") el.querySelector("#btn-entrar").click();
    });

    el.querySelector("#btn-reset").addEventListener("click", async () => {
      const email = inEmail.value.trim();
      if (!email) return toast("Informe o e-mail primeiro.", "erro");
      try {
        await sendPasswordResetEmail(auth, email);
        toast("E-mail de redefinição enviado.", "sucesso");
      } catch (err) {
        toast(mensagemErro(err), "erro");
      }
    });
  }

  render();
}

async function entrarComGoogle() {
  const provider = new GoogleAuthProvider();
  /*
    Pedir o escopo do Agenda já no login economiza um segundo consentimento
    depois. O token que volta aqui dura 1 hora e não tem refresh, então quem
    fala com a API do Agenda de verdade é o agenda.js, com o token client do
    Google Identity Services. Este escopo aqui só adianta a permissão.
  */
  provider.addScope(ESCOPO_AGENDA);
  provider.setCustomParameters({ prompt: "select_account" });
  try {
    await signInWithPopup(auth, provider);
  } catch (err) {
    if (err?.code === "auth/popup-blocked" || err?.code === "auth/cancelled-popup-request") {
      try { await signInWithRedirect(auth, provider); return; } catch (_) {}
    }
    toast(mensagemErro(err), "erro");
  }
}

/* ───────────────────────── ciclo de sessão ───────────────────────── */

export function observarSessao({ aoEntrar, aoSair }) {
  onAuthStateChanged(auth, async (user) => {
    if (!user) return aoSair();
    if (!autorizado(user)) {
      toast(`A conta ${user.email} não está autorizada neste app.`, "erro", 9000);
      await signOut(auth);
      return aoSair();
    }
    aoEntrar(user);
  });
}

export async function sair() {
  await signOut(auth);
}
