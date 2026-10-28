import { auth, db } from "./firebase-init.js?v=13";
import { getApp } from "https://www.gstatic.com/firebasejs/12.16.0/firebase-app.js";
import { getMessaging, getToken, deleteToken, isSupported } from "https://www.gstatic.com/firebasejs/12.16.0/firebase-messaging.js";
import { doc, getDocFromServer, setDoc, deleteDoc } from "https://www.gstatic.com/firebasejs/12.16.0/firebase-firestore.js";

const CHAVE_DONO = "rot_push_dono"; // só o uid; o endereço de push nunca fica aqui
const CHAVE_OPTIN = "rot_push_optin";
let usuario = null, messaging = null, registro = null, vapidKey = "", operacao = null;
let estado = { disponivel: false, ativa: false, permissao: "default", mensagem: "Carregando notificações…" };
const ouvintes = new Set();
export function aoMudarPush(fn) { ouvintes.add(fn); }
export function diagnosticoPush() { return { ...estado }; }
function informar(dados) {
  estado = { ...estado, ...dados };
  ouvintes.forEach((fn) => { try { fn(); } catch (_) {} });
}
function donoValido(user = usuario) {
  return !!(user?.emailVerified && user.email && auth.currentUser?.uid === user.uid);
}
function donoLocal() { try { return localStorage.getItem(CHAVE_DONO); } catch (_) { return null; } }
function optinLocal() { try { return localStorage.getItem(CHAVE_OPTIN); } catch (_) { return null; } }
function salvarOptin(uid) {
  try { uid ? localStorage.setItem(CHAVE_OPTIN, uid) : localStorage.removeItem(CHAVE_OPTIN); } catch (_) {}
}
function salvarDono(uid) {
  try { uid ? localStorage.setItem(CHAVE_DONO, uid) : localStorage.removeItem(CHAVE_DONO); } catch (_) {}
}
function iosSemInstalar() {
  const ios = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  return ios && !(navigator.standalone || window.matchMedia("(display-mode: standalone)").matches);
}
async function idDoToken(token) {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function carregarPush(user) {
  usuario = user;
  registro = null;
  vapidKey = "";
  informar({ disponivel: false, ativa: false, mensagem: "Carregando notificações…" });
  if (!donoValido(user)) return informar({ mensagem: "Entre com uma conta de e-mail confirmado para ativar os avisos." });
  if (iosSemInstalar()) return informar({ mensagem: "No iPhone, adicione o AppRotina à Tela de Início e abra por esse ícone para ativar os avisos." });
  try {
    if (!("Notification" in window) || !("serviceWorker" in navigator) || !("PushManager" in window) || !(await isSupported())) {
      return informar({ mensagem: "Este navegador não recebe avisos com o AppRotina fechado." });
    }
    const config = await getDocFromServer(doc(db, "config", "notificacoes"));
    if (!donoValido(user)) return;
    vapidKey = String(config.data()?.vapidKey || "");
    if (!/^[A-Za-z0-9_-]{87}$/.test(vapidKey)) {
      return informar({ mensagem: "O envio de notificações ainda não foi configurado." });
    }
    messaging = getMessaging(getApp());
    // O SDK guarda a inscrição do navegador. Trocar de conta ou retirar a
    // preferência invalida a anterior, inclusive depois de um reload.
    if (donoLocal() !== user.uid || optinLocal() !== user.uid) await deleteToken(messaging);
    if (!donoValido(user)) return;
    salvarDono(user.uid);
    informar({ disponivel: true, permissao: Notification.permission, mensagem: "Receba os avisos mesmo com o AppRotina fechado." });
    if (Notification.permission === "granted" && optinLocal() === user.uid) await registrar(user);
    else if (Notification.permission === "denied") informar({ mensagem: "Os avisos estão bloqueados. Libere as notificações do AppRotina nos ajustes deste aparelho." });
  } catch (_) {
    informar({ ativa: false, mensagem: "Não foi possível conferir as notificações. Verifique a conexão e tente novamente." });
  }
}

async function registrar(user) {
  if (!donoValido(user) || Notification.permission !== "granted") return false;
  const sw = await navigator.serviceWorker.ready;
  const token = await getToken(messaging, { vapidKey, serviceWorkerRegistration: sw });
  if (!token || !donoValido(user)) return false;
  const ref = doc(db, "usuarios", user.email.toLowerCase(), "pushTokens", await idDoToken(token));
  if (!donoValido(user)) return false;
  await setDoc(ref, {
    token, atualizadoEm: Date.now(),
    fuso: Intl.DateTimeFormat().resolvedOptions().timeZone || "America/Sao_Paulo",
  });
  if (!donoValido(user)) { await deleteToken(messaging); return false; }
  registro = ref;
  informar({ ativa: true, permissao: "granted", mensagem: "Avisos ativados neste aparelho." });
  return true;
}

// Deve ser chamada diretamente pelo clique. O pedido de permissão acontece
// antes de qualquer await, como exige o iPhone.
export function ativarPush() {
  if (operacao) return operacao;
  if (!donoValido() || !estado.disponivel || !messaging || !vapidKey) return Promise.resolve(false);
  const user = usuario;
  let permissao;
  try { permissao = Notification.requestPermission(); }
  catch (_) {
    informar({ ativa: false, mensagem: "Não foi possível pedir permissão para os avisos neste navegador." });
    return Promise.resolve(false);
  }
  operacao = permissao.then(async (valor) => {
    informar({ permissao: valor });
    if (valor !== "granted") {
      informar({ ativa: false, mensagem: valor === "denied" ? "Os avisos foram bloqueados neste aparelho." : "Os avisos não foram ativados." });
      return false;
    }
    const ativa = await registrar(user);
    if (ativa) salvarOptin(user.uid);
    return ativa;
  }).catch(() => {
    informar({ ativa: false, mensagem: "Não foi possível ativar os avisos. Tente novamente." });
    return false;
  }).finally(() => { operacao = null; });
  return operacao;
}

export async function desativarPush() {
  if (operacao) await operacao;
  const ref = registro;
  salvarOptin(null);
  // Apagar primeiro no SDK invalida o endereço mesmo se a conta mudou e a
  // regra do Firestore já não permitir remover o registro da conta antiga.
  try {
    if (messaging) await deleteToken(messaging);
    if (ref && donoValido()) await deleteDoc(ref);
  } catch (err) {
    informar({ mensagem: "Não foi possível concluir a desativação dos avisos. Tente novamente." });
    throw err;
  }
  registro = null;
  salvarDono(null);
  informar({ ativa: false, mensagem: "Avisos desativados neste aparelho." });
}
