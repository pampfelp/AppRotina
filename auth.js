/*
  auth.js — login do AppRotina.

  Crença 1 diz que autenticação nunca tem default, e a resposta do Felipe em
  2026-09-17 foi: login com Google E com e-mail/senha, os dois.

  Detalhe que evita uma armadilha real: os dois métodos precisam cair na
  MESMA conta, senão o Google gera um uid e o e-mail/senha gera outro, e a
  pessoa veria duas listas de tarefas diferentes dependendo de como entrou.
  A solução aqui não é vincular credencial (que quebra quando ela esquece
  qual usou primeiro): as firestore.rules autorizam por E-MAIL, não por uid,
  e cada e-mail tem seu espaço em `usuarios/{email}/...`.

  CADASTRO ABERTO (2026-09-18, decisão do Felipe). Qualquer pessoa cria a
  própria conta, pelo Google ou por e-mail e senha — não existe mais lista
  de autorizados.

  POR ISSO O E-MAIL CONFIRMADO VIROU OBRIGATÓRIO. Como o espaço de dados é
  endereçado pelo e-mail, entrar sem confirmar deixaria alguém se cadastrar
  com um e-mail que não é dele e ocupar aquele espaço. Quem entra pelo
  Google já vem confirmado pelo próprio Google e não sente diferença; quem
  cria senha recebe um link e passa pela tela de confirmação antes de usar
  o app. As firestore.rules exigem o mesmo (`email_verified`), então não
  adianta burlar pela tela: o banco recusa igual.
*/

import { auth } from "./firebase-init.js?v=11";
import {
  GoogleAuthProvider,
  signInWithPopup,
  signInWithRedirect,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  sendPasswordResetEmail,
  sendEmailVerification,
  onAuthStateChanged,
  signOut,
  fetchSignInMethodsForEmail,
} from "https://www.gstatic.com/firebasejs/12.16.0/firebase-auth.js";

import { toast, esc, ICONS } from "./shared.js?v=11";

const ESCOPO_AGENDA = "https://www.googleapis.com/auth/calendar.events";

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
  if (c === "auth/unauthorized-domain") return "Este endereço não está liberado para login. Abra o app pelo link oficial.";
  if (c === "auth/operation-not-allowed") return "Esta forma de login está indisponível no momento.";
  if (c === "auth/network-request-failed") return "Sem conexão. Verifique sua internet e tente de novo.";
  // o código cru vai pro console; na tela, só o que dá pra agir
  console.error("[auth]", err);
  return "Não foi possível entrar. Tente de novo.";
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
          const cred = await createUserWithEmailAndPassword(auth, email, senha);
          // o link de confirmação sai agora; até clicar nele, observarSessao
          // segura a pessoa na tela de confirmação
          await sendEmailVerification(cred.user).catch((e) => console.error(e));
          toast("Conta criada. Confira o link que enviamos pro seu e-mail.", "sucesso", 8000);
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

export function observarSessao({ aoEntrar, aoSair, aoNaoConfirmado }) {
  onAuthStateChanged(auth, async (user) => {
    if (!user) return aoSair();
    /*
      Sem e-mail confirmado a pessoa fica na porta. Não é frescura de tela:
      as firestore.rules exigem `email_verified`, então deixar entrar aqui
      só produziria um app que abre e recusa toda leitura e gravação, sem
      dizer por quê.
    */
    if (!user.emailVerified) return aoNaoConfirmado(user);
    aoEntrar(user);
  });
}

/**
 * Tela de espera pra quem criou conta por senha e ainda não clicou no link.
 * Quem entra pelo Google nunca cai aqui: o Google já entrega confirmado.
 */
export function montarTelaConfirmacao(user) {
  const el = document.getElementById("tela-login");
  el.innerHTML = `
    <div class="login-card">
      <div class="login-marca">
        <span class="ico">${ICONS.alerta}</span>
        <strong>Falta confirmar seu e-mail</strong>
      </div>
      <p class="sub">Enviamos um link para <strong>${esc(user.email || "")}</strong>.
      Abra o e-mail, clique no link e volte aqui.</p>

      <button type="button" class="btn primary bloco" id="btn-ja-confirmei">Já confirmei</button>
      <button type="button" class="btn bloco" id="btn-reenviar" style="margin-top:8px;">Reenviar o link</button>

      <div style="display:flex; justify-content:center; margin-top:12px;">
        <button type="button" class="login-alt" id="btn-outra-conta">Entrar com outra conta</button>
      </div>
    </div>`;

  el.querySelector("#btn-ja-confirmei").addEventListener("click", async () => {
    try {
      await user.reload();
    } catch (err) {
      return toast(mensagemErro(err), "erro");
    }
    if (!auth.currentUser?.emailVerified) {
      return toast("Ainda não consta como confirmado. Abra o link do e-mail e tente de novo.", "erro", 7000);
    }
    /*
      O token desta aba ainda carrega email_verified=false, e é ele que as
      firestore.rules leem — recarregar a página é o jeito mais curto de
      voltar com um token novo, em vez de remendar estado pela metade.
    */
    location.reload();
  });

  el.querySelector("#btn-reenviar").addEventListener("click", async () => {
    try {
      await sendEmailVerification(user);
      toast("Link reenviado. Confira também a caixa de spam.", "sucesso", 7000);
    } catch (err) {
      toast(mensagemErro(err), "erro");
    }
  });

  el.querySelector("#btn-outra-conta").addEventListener("click", async () => {
    await signOut(auth);
    montarTelaLogin();
  });
}

export async function sair() {
  await signOut(auth);
}
