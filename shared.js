/*
  shared.js — utilitários compartilhados do AppRotina.
  Base copiada de segundo-cerebro/boilerplate/shared.js (crença 4: um
  shared.js único por projeto, sem build step), com o que este projeto
  precisa a mais: helpers de dia da semana, de data em string YYYY-MM-DD e
  de registro central de listeners.
*/

/* ══════════════════════════ FORMATAÇÃO ══════════════════════════ */

export function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

export function fmtData(d) {
  if (!d) return "";
  const date = d?.toDate ? d.toDate() : d instanceof Date ? d : new Date(d);
  return date.toLocaleDateString("pt-BR");
}

export function fmtDataHora(d) {
  if (!d) return "";
  const date = d?.toDate ? d.toDate() : d instanceof Date ? d : new Date(d);
  return date.toLocaleString("pt-BR");
}

/*
  Fuso horário (antecipacao.md A3): `new Date("2026-09-17")` é meia-noite
  UTC, que no Brasil é o dia anterior às 21h. Cinco ocorrências desse bug no
  SolarGreen-ERP em dois dias. Toda data "YYYY-MM-DD" deste app passa por
  aqui, nunca pelo construtor genérico.
*/
export function parseDataLocal(isoDate) {
  const [y, m, d] = String(isoDate).split("-").map(Number);
  return new Date(y, m - 1, d);
}

/** Date -> "YYYY-MM-DD" no fuso local. */
export function isoLocal(date) {
  const d = date instanceof Date ? date : new Date(date);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function hojeISO() {
  return isoLocal(new Date());
}

/** Soma dias a uma data "YYYY-MM-DD" e devolve "YYYY-MM-DD". */
export function somarDiasISO(isoDate, dias) {
  const d = parseDataLocal(isoDate);
  d.setDate(d.getDate() + dias);
  return isoLocal(d);
}

/** Diferença em dias entre duas datas "YYYY-MM-DD" (b - a). */
export function diffDiasISO(a, b) {
  const ms = parseDataLocal(b).getTime() - parseDataLocal(a).getTime();
  return Math.round(ms / 86400000);
}

const NOMES_SEMANA = ["domingo", "segunda-feira", "terça-feira", "quarta-feira", "quinta-feira", "sexta-feira", "sábado"];
const CURTO_SEMANA = ["D", "S", "T", "Q", "Q", "S", "S"];

/** 0=domingo ... 6=sábado, calculado no fuso local. */
export function diaSemanaISO(isoDate) {
  return parseDataLocal(isoDate).getDay();
}

export function nomeDiaSemana(n) {
  return NOMES_SEMANA[n] ?? "";
}

/** "quinta-feira" -> "Quinta-feira". Só a primeira letra: capitalize do CSS
    transformava em "Quinta-Feira", que está errado em português. */
export function maiusculaInicial(s) {
  const t = String(s ?? "");
  return t.charAt(0).toUpperCase() + t.slice(1);
}

export function curtoDiaSemana(n) {
  return CURTO_SEMANA[n] ?? "";
}

/** "2026-09-17" -> "17/09", e "17/09/25" quando o ano não é o ano corrente.
    Sem isso, uma pendência que atravessa o ano fica indistinguível. */
export function diaMes(isoDate) {
  const [y, m, d] = String(isoDate).split("-");
  const anoAtual = String(new Date().getFullYear());
  return y === anoAtual ? `${d}/${m}` : `${d}/${m}/${y.slice(2)}`;
}

/** Rótulo humano de um dia relativo a hoje. */
export function rotuloDia(isoDate, hoje = hojeISO()) {
  const delta = diffDiasISO(hoje, isoDate);
  if (delta === 0) return "Hoje";
  if (delta === -1) return "Ontem";
  if (delta === 1) return "Amanhã";
  return null;
}

/** "06:30" -> minutos desde meia-noite; usado só pra ordenar. */
export function horaEmMinutos(hora) {
  if (!hora) return 24 * 60 + 1; // sem hora vai pro fim do dia
  const [h, m] = String(hora).split(":").map(Number);
  return (h || 0) * 60 + (m || 0);
}

export function debounce(fn, ms = 300) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

export function gerarId() {
  return crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

/** Slug seguro pra compor ID determinístico de documento. */
export function slugId(s) {
  return String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase().slice(0, 40);
}

/* ══════════════════════════════ ÍCONES ══════════════════════════════ */
/* Nunca emoji (crença 5). SVG inline estilo feather: viewBox 24x24,
   stroke=currentColor, stroke-width 1.8. */
const S = `viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"`;
export const ICONS = {
  hoje: `<svg ${S}><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>`,
  painel: `<svg ${S}><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg>`,
  rotinas: `<svg ${S}><path d="M21 12a9 9 0 1 1-2.64-6.36"/><polyline points="21 3 21 9 15 9"/><circle cx="12" cy="12" r="3"/></svg>`,
  perfil: `<svg ${S}><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>`,
  mais: `<svg ${S}><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>`,
  menu: `<svg ${S}><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg>`,
  check: `<svg ${S} stroke-width="2.6"><polyline points="20 6 9 17 4 12"/></svg>`,
  lapis: `<svg ${S}><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>`,
  excluir: `<svg ${S}><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>`,
  descartar: `<svg ${S}><circle cx="12" cy="12" r="9"/><line x1="8.5" y1="12" x2="15.5" y2="12"/></svg>`,
  relogio: `<svg ${S}><circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 15.5 14"/></svg>`,
  agenda: `<svg ${S}><rect x="3" y="4" width="18" height="17" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="8" y1="2.5" x2="8" y2="6"/><line x1="16" y1="2.5" x2="16" y2="6"/></svg>`,
  tag: `<svg ${S}><path d="M20.6 13.4L13.4 20.6a2 2 0 0 1-2.8 0L3 13V5a2 2 0 0 1 2-2h8l7.6 7.6a2 2 0 0 1 0 2.8z"/><line x1="7.5" y1="7.5" x2="7.51" y2="7.5"/></svg>`,
  alerta: `<svg ${S}><path d="M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><line x1="12" y1="9" x2="12" y2="13.5"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>`,
  info: `<svg ${S}><circle cx="12" cy="12" r="9"/><line x1="12" y1="11" x2="12" y2="16.5"/><line x1="12" y1="7.6" x2="12.01" y2="7.6"/></svg>`,
  sair: `<svg ${S}><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>`,
  historico: `<svg ${S}><path d="M3 12a9 9 0 1 0 9-9 9 9 0 0 0-7.9 4.7"/><polyline points="3 3 3 8 8 8"/><polyline points="12 8 12 12.5 15.5 14.5"/></svg>`,
  fechar: `<svg ${S}><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`,
  vazio: `<svg ${S}><path d="M21 15V7a2 2 0 0 0-2-2h-6l-2-2H5a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h9"/><line x1="17.5" y1="18" x2="22" y2="18"/></svg>`,
  google: `<svg viewBox="0 0 24 24" width="18" height="18"><path fill="#4285F4" d="M23 12.2c0-.8-.1-1.6-.2-2.3H12v4.4h6.2c-.3 1.4-1.1 2.6-2.3 3.4v2.8h3.6C21.6 18.5 23 15.6 23 12.2z"/><path fill="#34A853" d="M12 24c3 0 5.5-1 7.4-2.7l-3.6-2.8c-1 .7-2.3 1.1-3.8 1.1-2.9 0-5.4-2-6.3-4.6H1.9v2.9C3.8 21.5 7.6 24 12 24z"/><path fill="#FBBC05" d="M5.7 15c-.2-.7-.4-1.4-.4-2.2s.1-1.5.4-2.2V7.7H1.9A11.9 11.9 0 0 0 .6 12.8c0 1.9.5 3.7 1.3 5.2l3.8-3z"/><path fill="#EA4335" d="M12 4.8c1.6 0 3.1.6 4.3 1.7l3.2-3.2C17.5 1.4 15 .4 12 .4 7.6.4 3.8 2.9 1.9 6.6l3.8 2.9C6.6 6.9 9.1 4.8 12 4.8z"/></svg>`,
  usuario: `<svg ${S}><circle cx="12" cy="8" r="4"/><path d="M5.5 20a6.5 6.5 0 0 1 13 0"/></svg>`,
  senha: `<svg ${S}><rect x="4" y="10" width="16" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></svg>`,
};

/* ══════════════════════════════ TOAST ══════════════════════════════ */

let toastContainer;
function getToastContainer() {
  if (!toastContainer) {
    toastContainer = document.createElement("div");
    toastContainer.id = "toast-container";
    document.body.appendChild(toastContainer);
  }
  return toastContainer;
}

/** tipo: "sucesso" | "erro" | "info" */
export function toast(mensagem, tipo = "info", ms = 4500) {
  const el = document.createElement("div");
  el.className = `toast ${tipo}`;
  el.textContent = mensagem;
  getToastContainer().appendChild(el);
  setTimeout(() => el.remove(), ms);
}

/* ══════════════════════════════ MODAL ══════════════════════════════ */
/* Nunca confirm()/alert()/prompt() nativos (crença 3). */

let modalOverlay, modalTitulo, modalBody, modalActions;
function ensureModal() {
  if (modalOverlay) return;
  modalOverlay = document.createElement("div");
  modalOverlay.className = "modal-overlay";
  modalOverlay.innerHTML = `
    <div class="modal-card">
      <div class="modal-header">
        <h3 class="modal-titulo"></h3>
        <button type="button" aria-label="Fechar">&times;</button>
      </div>
      <div class="modal-body"></div>
      <div class="modal-actions"></div>
    </div>`;
  document.body.appendChild(modalOverlay);
  modalTitulo = modalOverlay.querySelector(".modal-titulo");
  modalBody = modalOverlay.querySelector(".modal-body");
  modalActions = modalOverlay.querySelector(".modal-actions");

  modalOverlay.querySelector("button[aria-label='Fechar']").addEventListener("click", fecharModal);
  modalOverlay.addEventListener("click", (e) => { if (e.target === modalOverlay) fecharModal(); });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && modalOverlay.classList.contains("open")) fecharModal();
  });
}

export function abrirModal(titulo, corpoHtml, acoesHtml) {
  ensureModal();
  modalTitulo.textContent = titulo;
  modalBody.innerHTML = corpoHtml;
  modalActions.innerHTML = acoesHtml ?? `<span></span><button type="button" class="btn" data-fechar-modal>Fechar</button>`;
  modalActions.querySelectorAll("[data-fechar-modal]").forEach((b) => b.addEventListener("click", fecharModal));
  modalOverlay.classList.add("open");
  const primeiro = modalBody.querySelector("input:not([type=hidden]), select, textarea");
  if (primeiro && window.matchMedia("(min-width:561px)").matches) setTimeout(() => primeiro.focus(), 40);
  return modalBody;
}

export function fecharModal() {
  if (modalOverlay) modalOverlay.classList.remove("open");
}

export function modalAberto() {
  return !!modalOverlay?.classList.contains("open");
}

export function acoesModal() {
  ensureModal();
  return modalActions;
}

export function confirmar(mensagem, { textoConfirmar = "Excluir", textoCancelar = "Cancelar", perigo = true } = {}) {
  return new Promise((resolve) => {
    ensureModal();
    abrirModal(
      "Confirmar ação",
      `<p style="margin:0;">${esc(mensagem)}</p>`,
      `<button type="button" class="btn" data-cancelar>${esc(textoCancelar)}</button>
       <button type="button" class="btn ${perigo ? "danger" : "primary"}" data-confirmar>${esc(textoConfirmar)}</button>`
    );
    modalActions.querySelector("[data-cancelar]").addEventListener("click", () => { fecharModal(); resolve(false); });
    modalActions.querySelector("[data-confirmar]").addEventListener("click", () => { fecharModal(); resolve(true); });
  });
}

/* ══════════════════ INDICADOR DE SINCRONIZAÇÃO ══════════════════ */
/*
  Bolinha no topo mostrando se há escrita local ainda não confirmada pelo
  servidor. Existe porque sem isso o app parece funcionar mesmo quando nada
  sincroniza — o que custou ~15 registros perdidos na Prospecção Rodrigues
  Alves em 2026-08-21. Todo onSnapshot passa { includeMetadataChanges: true }
  e chama rastrearSincronizacao().
*/

const _pendentesSync = new Map();

export function rastrearSincronizacao(nomeColecao, snap, resumoFn) {
  snap.docs.forEach((d) => {
    const chave = `${nomeColecao}/${d.id}`;
    if (d.metadata.hasPendingWrites) {
      _pendentesSync.set(chave, { colecao: nomeColecao, resumo: resumoFn ? resumoFn(d.data()) : d.id });
    } else {
      _pendentesSync.delete(chave);
    }
  });
  _renderBadgeSync();
}

let syncBadgeEl, syncOverlayEl, syncListaEl;

/** Monta a bolinha dentro de um container já existente no HTML. */
export function montarBadgeSincronizacao(container) {
  if (syncBadgeEl) return;
  syncBadgeEl = document.createElement("button");
  syncBadgeEl.type = "button";
  syncBadgeEl.className = "sync-badge";
  syncBadgeEl.setAttribute("aria-label", "Status de sincronização");
  container.appendChild(syncBadgeEl);

  syncOverlayEl = document.createElement("div");
  syncOverlayEl.className = "sync-painel-overlay";
  syncOverlayEl.innerHTML = `
    <div class="sync-painel">
      <div class="sync-painel-header">
        <strong>Sincronização</strong>
        <button type="button" aria-label="Fechar">&times;</button>
      </div>
      <div class="sync-painel-lista"></div>
    </div>`;
  document.body.appendChild(syncOverlayEl);
  syncListaEl = syncOverlayEl.querySelector(".sync-painel-lista");

  syncBadgeEl.addEventListener("click", () => syncOverlayEl.classList.toggle("open"));
  syncOverlayEl.querySelector("button[aria-label='Fechar']").addEventListener("click", () => syncOverlayEl.classList.remove("open"));
  syncOverlayEl.addEventListener("click", (e) => { if (e.target === syncOverlayEl) syncOverlayEl.classList.remove("open"); });
  _renderBadgeSync();
}

function _renderBadgeSync() {
  if (!syncBadgeEl) return;
  const n = _pendentesSync.size;
  syncBadgeEl.classList.toggle("pendente", n > 0);
  syncBadgeEl.innerHTML = n > 0 ? String(n) : `<span class="ico">${ICONS.check}</span>`;
  syncListaEl.innerHTML = n === 0
    ? `<div class="sync-painel-vazio">Tudo sincronizado.</div>`
    : [..._pendentesSync.values()].map((p) => `
        <div class="sync-item">
          <div class="sync-item-colecao">${esc(p.colecao)}</div>
          <div>${esc(p.resumo)}</div>
        </div>`).join("");
}

/* ══════════════════════ ESCRITA OTIMISTA ══════════════════════ */
/*
  Crença 11 / antecipacao.md A2: a Promise de set()/update() só resolve
  quando o servidor confirma. Sem sinal ela fica pendurada sem resolver nem
  rejeitar, e a tela travava em "Salvando…" pra sempre. Toda escrita deste
  app passa por aqui, e nada na interface espera a Promise.
*/
export async function emSegundoPlano(promise, mensagemErro, aoFalhar) {
  try {
    await promise;
    return true;
  } catch (err) {
    console.error(err);
    toast(mensagemErro || err.message || "Falha ao salvar", "erro");
    if (aoFalhar) await aoFalhar(err);
    return false;
  }
}

/* ══════════════════════ REGISTRO DE LISTENERS ══════════════════════ */
/*
  Crença 10 / antecipacao.md A1: uma escuta por recorte de coleção,
  compartilhada entre as telas, nunca um listener por tela. O que motivou:
  o Funil do SolarGreen-ERP lia 959 leads a cada abertura e estourou a cota
  diária gratuita em produção.
*/
const _listeners = new Map();

export function registrarListener(chave, fnCriar) {
  if (_listeners.has(chave)) return _listeners.get(chave);
  const unsub = fnCriar();
  _listeners.set(chave, unsub);
  return unsub;
}

export function desligarListeners() {
  _listeners.forEach((unsub) => { try { unsub(); } catch (_) {} });
  _listeners.clear();
}

/* ══════════════════════ NAVEGAÇÃO (pílula inferior) ══════════════════════ */
/*
  Decisão do Felipe em 2026-09-17: navegação principal em pílula inferior
  estilo Instagram, nunca menu lateral. Menu lateral só existe dentro da aba
  de perfil, atrás do ícone de três traços, e só pra Configurações.
*/
export function iniciarNavegacao({ onChange, inicial } = {}) {
  const navItems = [...document.querySelectorAll(".nav-item[data-view]")];
  const views = [...document.querySelectorAll(".view[id^='view-']")];

  function irPara(viewId) {
    navItems.forEach((b) => b.classList.toggle("active", b.dataset.view === viewId));
    views.forEach((v) => v.classList.toggle("active", v.id === `view-${viewId}`));
    window.scrollTo({ top: 0, behavior: "instant" });
    onChange?.(viewId);
  }

  navItems.forEach((b) => b.addEventListener("click", () => irPara(b.dataset.view)));
  irPara(inicial || navItems[0]?.dataset.view);
  return { irPara, atual: () => navItems.find((b) => b.classList.contains("active"))?.dataset.view };
}

/* ══════════════════════ PWA — BANNER DE INSTALAÇÃO ══════════════════════ */

export function iniciarBannerInstalacao({ dismissDias = 14 } = {}) {
  const chave = "rot_install_dismissed_until";
  if (Date.now() < Number(localStorage.getItem(chave) || 0)) return;
  if (window.matchMedia("(display-mode: standalone)").matches) return;
  if (window.navigator.standalone) return;

  let deferred;
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    deferred = e;
    mostrar(async () => { deferred.prompt(); await deferred.userChoice; deferred = null; });
  });

  if (/iphone|ipad|ipod/i.test(navigator.userAgent)) {
    mostrar(null, 'Toque em Compartilhar e depois em "Adicionar à Tela de Início".');
  }

  function mostrar(onInstalar, textoManual) {
    const el = document.createElement("div");
    el.className = "toast info";
    el.style.cssText = "display:flex;align-items:center;gap:10px;justify-content:space-between;";
    el.innerHTML = `<span style="flex:1;">${esc(textoManual || "Instale o AppRotina para acesso rápido.")}</span>`;
    if (onInstalar) {
      const b = document.createElement("button");
      b.className = "btn primary"; b.textContent = "Instalar"; b.style.padding = "7px 12px";
      b.addEventListener("click", () => { onInstalar(); el.remove(); });
      el.appendChild(b);
    }
    const x = document.createElement("button");
    x.type = "button"; x.innerHTML = ICONS.fechar;
    x.style.cssText = "background:none;border:none;color:inherit;cursor:pointer;width:18px;height:18px;padding:0;flex-shrink:0;";
    x.addEventListener("click", () => {
      localStorage.setItem(chave, String(Date.now() + dismissDias * 86400000));
      el.remove();
    });
    el.appendChild(x);
    getToastContainer().appendChild(el);
  }
}

/* ══════════════════════ TOOLTIP DE GRÁFICO ══════════════════════ */
/* O gráfico do painel é HTML, então ganha camada de hover por padrão. */

let gtipEl;
export function tooltipGrafico() {
  if (!gtipEl) {
    gtipEl = document.createElement("div");
    gtipEl.className = "gtip";
    document.body.appendChild(gtipEl);
  }
  return {
    mostrar(html, x, y) {
      gtipEl.innerHTML = html;
      gtipEl.classList.add("show");
      const r = gtipEl.getBoundingClientRect();
      const left = Math.min(Math.max(8, x - r.width / 2), window.innerWidth - r.width - 8);
      const top = y - r.height - 12 < 8 ? y + 16 : y - r.height - 12;
      gtipEl.style.left = `${left}px`;
      gtipEl.style.top = `${top}px`;
    },
    esconder() { gtipEl.classList.remove("show"); },
  };
}
