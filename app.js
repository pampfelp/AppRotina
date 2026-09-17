/*
  app.js — AppRotina.

  Um app.js único, porque são quatro telas e a crença 8 só manda dividir em
  js/ modular a partir de cinco telas complexas. Login e Google Agenda ficam
  em módulos próprios porque são integrações, não telas.

  MODELO DE DADOS
  ───────────────
  categorias/{id}   { nome, cor, ordem, ativa, createdAt }
  rotinas/{id}      { nome, hora, duracaoMin, diasSemana:[0..6], ativa,
                      categoriaId, atividades:[{ id, titulo, categoriaId }],
                      agendaEventoId, agendaHash, createdAt }

  A rotina sempre tem `categoriaId` própria: é a categoria usada quando ela
  não tem nenhuma atividade cadastrada, porque nesse caso a rotina É a
  própria atividade (decisão do Felipe em 2026-09-18 — "criar uma rotina,
  automaticamente ela é a própria atividade"). Ver atividadesEfetivas().
  tarefas/{id}      { data:"YYYY-MM-DD", hora:"HH:MM", duracaoMin, titulo,
                      categoriaId,
                      estado:"pendente"|"concluida"|"descartada",
                      origem:"rotina"|"manual", rotinaId, rotinaAtividadeId,
                      concluidaEm, descartadaEm,
                      agendaEventoId, agendaHash,
                      agendaAtrasoId, agendaAtrasoAte, createdAt }
  config/perfil     { nome, telefone, nascimento, ocupacao }
  config/estado     { ultimaMaterializacao:"YYYY-MM-DD" }

  Por que `estado` em vez de um booleano `concluida`: com um campo só, a
  escuta das pendentes é uma igualdade simples (sem índice composto) e os
  três estados usam o mesmo vocabulário nos dois lados, que é a crença 14.

  ID DETERMINÍSTICO. Tarefa vinda de rotina tem id
  `<data>__<rotinaId>__<atividadeId>`. É isso que faz o lançamento diário ser
  idempotente: rodar duas vezes, em dois aparelhos, no mesmo dia, não cria
  duplicata. A materialização ainda confere antes de gravar, porque
  sobrescrever apagaria um "concluída" já marcado (crença 9).

  RECORTE DAS ESCUTAS (crença 10 / antecipacao.md A1). Duas escutas, as duas
  limitadas: as pendentes de qualquer data, e tudo dos últimos 90 dias.
  Nunca a coleção inteira. O Funil do SolarGreen-ERP lia 959 leads a cada
  abertura e derrubou a cota diária gratuita em produção.
*/

import { db, auth, configurado } from "./firebase-init.js";
import {
  collection, doc, getDoc, getDocs, setDoc, updateDoc, deleteDoc,
  onSnapshot, query, where, writeBatch, serverTimestamp,
} from "https://www.gstatic.com/firebasejs/12.16.0/firebase-firestore.js";

import { montarTelaLogin, observarSessao, sair } from "./auth.js";
import {
  agendaConfigurada, agendaConectada, agendaJaAutorizada,
  conectarAgenda, desconectarAgenda, sincronizarAgenda, apagarEventosDe, aoMudarAgenda,
  diagnosticoAgenda, procurarEventosOrfaos, apagarOrfaos,
} from "./agenda.js";
import { DIAGNOSTICO_SESSAO } from "./firebase-init.js";
import {
  esc, toast, abrirModal, fecharModal, confirmar, emSegundoPlano,
  iniciarNavegacao, iniciarBannerInstalacao, registrarListener, desligarListeners,
  montarBadgeSincronizacao, rastrearSincronizacao, tooltipGrafico,
  ICONS, parseDataLocal, isoLocal, hojeISO, somarDiasISO, diffDiasISO,
  diaSemanaISO, nomeDiaSemana, curtoDiaSemana, diaMes, rotuloDia, maiusculaInicial,
  horaEmMinutos, gerarId, slugId, fmtDataHora,
} from "./shared.js";

const DIAS_JANELA = 90;   // recorte da escuta de histórico recente
const MAX_RECUPERACAO = 45; // teto de dias que o lançamento recupera de uma vez
const CORES_CAT = ["#02AD58", "#A867FF", "#C48001", "#0A9DD3", "#FF3457", "#0CA5A7"];
const CATEGORIAS_INICIAIS = ["Trabalho", "Faculdade", "Religião", "Relacionamento"];

const STATE = {
  user: null,
  categorias: [],
  rotinas: [],
  mapaPendentes: new Map(),
  mapaRecentes: new Map(),
  tarefas: [],
  perfil: {},
  hoje: hojeISO(),
  periodoDias: 30,
  histFiltroCat: "",
  histLimite: 25,
  rotinasCarregadas: false,
  materializou: false,
};

const $ = (id) => document.getElementById(id);
const tip = tooltipGrafico();
let nav = null;

/* ═══════════════════════════ ícones ═══════════════════════════ */
/* Nunca emoji (crença 5). Os spans .ico do HTML nascem vazios e recebem o
   SVG aqui, num lugar só. */
function pintarIcones() {
  const mapa = {
    "btn-menu-perfil": "menu", "btn-fechar-drawer": "fechar", "btn-nova-tarefa": "mais",
    "cfg-categorias": "tag", "cfg-agenda": "agenda", "cfg-sobre": "info", "cfg-sair": "sair",
  };
  for (const [id, nome] of Object.entries(mapa)) {
    const ico = $(id)?.querySelector(".ico");
    // Botão sem o span .ico nasce vazio e o defeito passa batido, porque
    // nada quebra e o clique continua funcionando. Aconteceu duas vezes
    // durante a construção, então o aviso fica.
    if (!ico) { console.warn(`[icones] #${id} não tem <span class="ico">`); continue; }
    ico.innerHTML = ICONS[nome];
  }
  document.querySelectorAll(".nav-item[data-view]").forEach((b) => {
    b.querySelector(".ico").innerHTML = ICONS[b.dataset.view] || ICONS.painel;
  });
  document.querySelectorAll(".aviso.info .ico").forEach((e) => { e.innerHTML = ICONS.info; });
}

/* ═══════════════════════════ boot ═══════════════════════════ */

pintarIcones();

if (!configurado) {
  $("tela-login").classList.add("show");
  $("tela-login").innerHTML = `
    <div class="login-card">
      <div class="login-marca"><span class="ico">${ICONS.alerta}</span><strong>Falta ligar o Firebase</strong></div>
      <p class="sub">O <code>firebase-init.js</code> ainda está com <code>COLE_AQUI</code>.
      O passo a passo para criar o projeto e colar a config está no
      <code>README.md</code> deste repositório, do passo 1 ao 5.</p>
    </div>`;
} else {
  montarTelaLogin();
  observarSessao({ aoEntrar: entrar, aoSair: deslogar });
}

function deslogar() {
  desligarListeners();
  STATE.user = null;
  STATE.mapaPendentes.clear();
  STATE.mapaRecentes.clear();
  STATE.tarefas = [];
  STATE.rotinasCarregadas = false;
  STATE.materializou = false;
  $("app").classList.remove("pronto");
  $("tela-login").classList.add("show");
}

function entrar(user) {
  STATE.user = user;
  $("tela-login").classList.remove("show");
  $("app").classList.add("pronto");

  if (!nav) {
    nav = iniciarNavegacao({ inicial: "hoje", onChange: aoTrocarAba });
    montarBadgeSincronizacao($("topbar-acoes"));
    ligarEventos();
    iniciarBannerInstalacao();
    aoMudarAgenda(atualizarLinhaAgenda);
    vigiarViradaDoDia();
  }
  renderPerfil();
  abrirEscutas();
}

/* ═══════════════════════════ escutas ═══════════════════════════ */

function abrirEscutas() {
  registrarListener("categorias", () =>
    onSnapshot(collection(db, "categorias"), { includeMetadataChanges: true }, (snap) => {
      STATE.categorias = snap.docs.map((d) => ({ id: d.id, ...d.data() }))
        .filter((c) => c.ativa !== false)
        .sort((a, b) => (a.ordem ?? 99) - (b.ordem ?? 99) || String(a.nome).localeCompare(String(b.nome), "pt-BR"));
      rastrearSincronizacao("categorias", snap, (d) => d.nome);
      if (!snap.metadata.fromCache && snap.empty) semearCategorias();
      renderTudo();
    }, erro)
  );

  registrarListener("rotinas", () =>
    onSnapshot(collection(db, "rotinas"), { includeMetadataChanges: true }, (snap) => {
      STATE.rotinas = snap.docs.map((d) => ({ id: d.id, ...d.data() }))
        .sort((a, b) => horaEmMinutos(a.hora) - horaEmMinutos(b.hora) || String(a.nome).localeCompare(String(b.nome), "pt-BR"));
      rastrearSincronizacao("rotinas", snap, (d) => d.nome);
      STATE.rotinasCarregadas = true;
      renderTudo();
      if (!STATE.materializou && !snap.metadata.fromCache) {
        STATE.materializou = true;
        materializar().then(agendarSincronizacao);
      }
    }, erro)
  );

  // recorte 1: pendentes de qualquer data (é o que segura a atrasada no topo)
  registrarListener("tarefas-pendentes", () =>
    onSnapshot(query(collection(db, "tarefas"), where("estado", "==", "pendente")),
      { includeMetadataChanges: true }, (snap) => {
        STATE.mapaPendentes = new Map(snap.docs.map((d) => [d.id, { id: d.id, ...d.data() }]));
        rastrearSincronizacao("tarefas", snap, (d) => d.titulo);
        juntarTarefas();
      }, erro)
  );

  // recorte 2: tudo dos últimos 90 dias (feitas de hoje, futuras, painel, histórico)
  registrarListener("tarefas-recentes", () =>
    onSnapshot(query(collection(db, "tarefas"), where("data", ">=", somarDiasISO(STATE.hoje, -DIAS_JANELA))),
      { includeMetadataChanges: true }, (snap) => {
        STATE.mapaRecentes = new Map(snap.docs.map((d) => [d.id, { id: d.id, ...d.data() }]));
        rastrearSincronizacao("tarefas", snap, (d) => d.titulo);
        juntarTarefas();
      }, erro)
  );

  registrarListener("perfil", () =>
    onSnapshot(doc(db, "config", "perfil"), (snap) => {
      STATE.perfil = snap.exists() ? snap.data() : {};
      renderPerfil();
    }, erro)
  );
}

function juntarTarefas() {
  const uniao = new Map(STATE.mapaRecentes);
  STATE.mapaPendentes.forEach((v, k) => uniao.set(k, v));
  STATE.tarefas = [...uniao.values()];
  renderTudo();
}

function erro(err) {
  console.error(err);
  if (err?.code === "permission-denied") {
    toast("Sem permissão no Firestore. Confira se seu e-mail está na lista das firestore.rules.", "erro", 9000);
  } else {
    toast(err.message || "Falha ao ler os dados.", "erro");
  }
}

async function semearCategorias() {
  const batch = writeBatch(db);
  CATEGORIAS_INICIAIS.forEach((nome, i) => {
    batch.set(doc(db, "categorias", slugId(nome)), {
      nome, cor: CORES_CAT[i % CORES_CAT.length], ordem: i, ativa: true, createdAt: serverTimestamp(),
    });
  });
  await emSegundoPlano(batch.commit(), "Não foi possível criar as categorias iniciais.");
}

/* ═══════════════════════ lançamento diário ═══════════════════════ */

const idTarefaRotina = (data, rotinaId, atividadeId) => `${data}__${rotinaId}__${atividadeId}`;

/** Primeira data, a partir de AMANHÃ, cujo dia da semana está em `dias`.
    Usado só quando hoje não é dia da rotina — se fosse, a data é hoje. */
function proximaOcorrenciaISO(dias, base) {
  for (let i = 1; i <= 7; i++) {
    const cand = somarDiasISO(base, i);
    if (dias.includes(diaSemanaISO(cand))) return cand;
  }
  return base; // nunca deveria chegar aqui — modalRotina exige >=1 dia marcado
}

/** "hoje", "amanhã", ou "quarta (24/09)" — pro toast do lançamento manual. */
function rotuloDataCurta(iso) {
  const rot = rotuloDia(iso, STATE.hoje);
  if (rot) return rot.toLowerCase();
  return `${nomeDiaSemana(diaSemanaISO(iso)).replace("-feira", "")} (${diaMes(iso)})`;
}

function tarefaDaAtividade(data, rotina, ativ) {
  return {
    data, hora: rotina.hora || "08:00",
    duracaoMin: Number(rotina.duracaoMin) || 30,
    // O título da tarefa é o nome da rotina, não da atividade: a atividade
    // deixou de exigir um título próprio (só a categoria é obrigatória),
    // então o que identifica a linha no checklist é sempre a rotina.
    titulo: rotina.nome,
    categoriaId: ativ.categoriaId || "",
    estado: "pendente",
    origem: "rotina",
    rotinaId: rotina.id,
    rotinaAtividadeId: ativ.id,
    rotinaNome: rotina.nome,
    concluidaEm: null, descartadaEm: null,
    agendaEventoId: null, agendaHash: null,
    agendaAtrasoId: null, agendaAtrasoAte: null,
    createdAt: serverTimestamp(),
  };
}

/**
 * Lança no checklist as tarefas das rotinas ativas, do último dia lançado
 * até hoje. Recupera dias em que o app não foi aberto, com teto de 45 dias
 * pra uma volta de viagem não gerar centenas de registros de uma vez.
 */
async function materializar() {
  if (!STATE.rotinasCarregadas) return;
  const hoje = STATE.hoje;
  const estadoRef = doc(db, "config", "estado");

  let ultima = null;
  try {
    const s = await getDoc(estadoRef);
    ultima = s.exists() ? s.data().ultimaMaterializacao : null;
  } catch (err) { console.error(err); }

  let inicio = ultima ? somarDiasISO(ultima, 1) : hoje;
  if (inicio > hoje) return;                                  // já lançado hoje
  if (diffDiasISO(inicio, hoje) > MAX_RECUPERACAO) inicio = somarDiasISO(hoje, -MAX_RECUPERACAO);

  // upsert: lê o que já existe no intervalo e grava só o que falta, nunca por
  // cima, senão uma tarefa já concluída voltaria pra pendente (crença 9)
  const existentes = new Set();
  try {
    const qs = await getDocs(query(collection(db, "tarefas"), where("data", ">=", inicio)));
    qs.forEach((d) => existentes.add(d.id));
  } catch (err) { console.error(err); return; }

  const novas = [];
  for (let dia = inicio; dia <= hoje; dia = somarDiasISO(dia, 1)) {
    const dow = diaSemanaISO(dia);
    for (const r of STATE.rotinas) {
      if (!r.ativa || !(r.diasSemana || []).includes(dow)) continue;
      for (const a of atividadesEfetivas(r)) {
        const id = idTarefaRotina(dia, r.id, a.id);
        if (existentes.has(id)) continue;
        novas.push([id, tarefaDaAtividade(dia, r, a)]);
      }
    }
  }

  // writeBatch aceita no máximo 500 operações, e a marca do dia ocupa uma
  for (let i = 0; i < novas.length; i += 450) {
    const batch = writeBatch(db);
    novas.slice(i, i + 450).forEach(([id, dados]) => batch.set(doc(db, "tarefas", id), dados));
    await emSegundoPlano(batch.commit(), "Não foi possível lançar as rotinas do dia.");
  }
  await emSegundoPlano(setDoc(estadoRef, { ultimaMaterializacao: hoje }, { merge: true }),
    "Não foi possível marcar o dia como lançado.");

  if (novas.length) toast(`${novas.length} tarefa${novas.length > 1 ? "s" : ""} de rotina lançada${novas.length > 1 ? "s" : ""}.`, "info");
}

/**
 * Ação explícita (botão em Rotinas fixas): lança de uma vez o que falta das
 * rotinas ativas de hoje e dos próximos `dias` dias. Diferente de
 * materializar(), não mexe em `config/estado.ultimaMaterializacao` — aquele
 * marcador é só da recuperação automática de dias passados perdidos.
 */
async function lancarProximosDias(dias) {
  const inicio = STATE.hoje;
  const fim = somarDiasISO(inicio, dias); // inclui hoje + `dias` dias à frente

  const existentes = new Set();
  try {
    const qs = await getDocs(query(collection(db, "tarefas"),
      where("data", ">=", inicio), where("data", "<=", fim)));
    qs.forEach((d) => existentes.add(d.id));
  } catch (err) { console.error(err); return toast("Não foi possível conferir o que já está lançado.", "erro"); }

  const novas = [];
  for (let dia = inicio; dia <= fim; dia = somarDiasISO(dia, 1)) {
    const dow = diaSemanaISO(dia);
    for (const r of STATE.rotinas) {
      if (!r.ativa || !(r.diasSemana || []).includes(dow)) continue;
      for (const a of atividadesEfetivas(r)) {
        const id = idTarefaRotina(dia, r.id, a.id);
        if (existentes.has(id)) continue;
        novas.push([id, tarefaDaAtividade(dia, r, a)]);
      }
    }
  }

  if (!novas.length) return toast("Já está tudo lançado até lá.", "info");

  for (let i = 0; i < novas.length; i += 450) {
    const batch = writeBatch(db);
    novas.slice(i, i + 450).forEach(([id, dados]) => batch.set(doc(db, "tarefas", id), dados));
    const ok = await emSegundoPlano(batch.commit(), "Não foi possível lançar as rotinas dos próximos dias.");
    if (!ok) return;
  }
  toast(`${novas.length} tarefa${novas.length > 1 ? "s" : ""} lançada${novas.length > 1 ? "s" : ""} de hoje até ${diaMes(fim)}.`, "sucesso");
  agendarSincronizacao();
}

/** Lança hoje as atividades de uma rotina recém-salva, se hoje for dia dela. */
async function lancarRotinaHoje(rotina) {
  const dow = diaSemanaISO(STATE.hoje);
  if (!rotina.ativa || !(rotina.diasSemana || []).includes(dow)) return;
  const existentes = new Set(STATE.tarefas.filter((t) => t.data === STATE.hoje).map((t) => t.id));
  const batch = writeBatch(db);
  let n = 0;
  for (const a of atividadesEfetivas(rotina)) {
    const id = idTarefaRotina(STATE.hoje, rotina.id, a.id);
    if (existentes.has(id)) continue;
    batch.set(doc(db, "tarefas", id), tarefaDaAtividade(STATE.hoje, rotina, a));
    n++;
  }
  if (n) await emSegundoPlano(batch.commit(), "Não foi possível lançar a rotina de hoje.");
}

/*
  Lançamento manual de UMA rotina, pedido pelo Felipe em 2026-09-18: um
  botão na linha da rotina que lança a atividade dela agora, escolhendo a
  data certa sozinho.

  Regra exata que ele descreveu: se hoje for dia da rotina, lança hoje; se
  hoje não for, lança na próxima ocorrência (não força hoje fora do dia
  certo). Se já existir tarefa daquela rotina naquela data — em QUALQUER
  estado, inclusive já concluída ou descartada — avisa que já existe, em
  vez de recriar. Recriar por cima apagaria uma marcação real (crença 9);
  "já existe" e "eu descartei de propósito" são coisas diferentes, e este
  botão não pode confundir as duas.
*/
async function lancarAtividadeAgora(rotina) {
  const dias = [...(rotina.diasSemana || [])].sort((a, b) => a - b);
  if (!dias.length) return toast("Essa rotina não tem dia da semana marcado.", "erro");

  const dow = diaSemanaISO(STATE.hoje);
  const alvo = dias.includes(dow) ? STATE.hoje : proximaOcorrenciaISO(dias, STATE.hoje);

  const atividades = atividadesEfetivas(rotina);
  const existentes = new Set(
    STATE.tarefas
      .filter((t) => t.data === alvo && t.rotinaId === rotina.id)
      .map((t) => t.rotinaAtividadeId)
  );
  const faltando = atividades.filter((a) => !existentes.has(a.id));
  const quando = rotuloDataCurta(alvo);

  if (!faltando.length) {
    return toast(`Já existe: "${rotina.nome}" já está lançada em ${quando}.`, "info");
  }

  const batch = writeBatch(db);
  faltando.forEach((a) =>
    batch.set(doc(db, "tarefas", idTarefaRotina(alvo, rotina.id, a.id)), tarefaDaAtividade(alvo, rotina, a))
  );
  const ok = await emSegundoPlano(batch.commit(), "Não foi possível lançar a atividade.");
  if (!ok) return;

  const parcial = existentes.size > 0;
  toast(`"${rotina.nome}" lançada em ${quando}${parcial ? " (o resto já existia)" : ""}.`, "sucesso");
  agendarSincronizacao();
}

/**
 * Atividade removida de uma rotina deixaria tarefa órfã no checklist, sem
 * nada que a explique. Duas situações, dois critérios:
 * - rotina PAUSADA: sai tudo dela de hoje em diante, feito ou não — pausar
 *   significa "para de valer a partir de agora", e o Felipe pediu que o
 *   lançamento (não só o pendente) suma do dia em diante (2026-09-17).
 * - rotina ainda ativa, mas atividade removida ou dia tirado da semana: só
 *   o PENDENTE some; o que já foi concluído fica no histórico, porque
 *   aconteceu de verdade.
 */
async function limparOrfasDaRotina(rotina) {
  const vivos = new Set(atividadesEfetivas(rotina).map((a) => a.id));
  const daRotinaEmDiante = (t) => t.rotinaId === rotina.id && t.data >= STATE.hoje;

  const orfas = !rotina.ativa
    ? STATE.tarefas.filter(daRotinaEmDiante)
    : STATE.tarefas.filter((t) => daRotinaEmDiante(t) && t.estado === "pendente" &&
        (!vivos.has(t.rotinaAtividadeId) || !(rotina.diasSemana || []).includes(diaSemanaISO(t.data))));

  if (!orfas.length) return;
  // a cobrança de atrasada é por tarefa; apagando o documento, ninguém mais
  // vê esse id pra apagar o evento correspondente no Google Agenda
  for (const t of orfas) {
    if (t.agendaAtrasoId) await apagarEventosDe({ agendaAtrasoId: t.agendaAtrasoId });
  }
  const batch = writeBatch(db);
  orfas.forEach((t) => batch.delete(doc(db, "tarefas", t.id)));
  await emSegundoPlano(batch.commit(), "Não foi possível limpar as tarefas antigas da rotina.");
}

/** O app pode ficar aberto atravessando a meia-noite. */
function vigiarViradaDoDia() {
  const checar = () => {
    const agora = hojeISO();
    if (agora === STATE.hoje) return;
    STATE.hoje = agora;
    STATE.materializou = false;
    materializar().then(() => { STATE.materializou = true; agendarSincronizacao(); });
    renderTudo();
  };
  setInterval(checar, 60000);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) checar(); });
}

/* ═══════════════════════════ helpers de dado ═══════════════════════════ */

const catPorId = (id) => STATE.categorias.find((c) => c.id === id);
const nomeCategoria = (id) => catPorId(id)?.nome || "";
const corCategoria = (id) => catPorId(id)?.cor || "var(--ink-faint)";

function tagCategoria(id) {
  const nome = nomeCategoria(id);
  if (!nome) return `<span class="cat-tag" style="color:var(--ink-faint);">sem categoria</span>`;
  return `<span class="cat-tag"><span class="cat-ponto" style="background:${esc(corCategoria(id))}"></span>${esc(nome)}</span>`;
}

/** Nome de exibição de uma atividade de rotina, já que o próprio título dela
    deixou de ser obrigatório (a categoria virou o que identifica a linha). */
const rotuloAtividade = (a) => a.titulo || nomeCategoria(a.categoriaId) || "atividade";

/**
 * Atividades que a rotina realmente lança. Sem nenhuma cadastrada, a rotina
 * é a própria atividade — usa o nome e a categoria dela mesma, com um id
 * fixo ("self") pra manter o esquema de id determinístico das tarefas
 * (`idTarefaRotina`) funcionando igual.
 */
function atividadesEfetivas(rotina) {
  if ((rotina.atividades || []).length) return rotina.atividades;
  return [{ id: "self", titulo: "", categoriaId: rotina.categoriaId || "" }];
}

/* Cria uma categoria "on the fly", a partir do combobox de categoria. Ainda
   assim ela nasce como um registro de verdade em `categorias/`, com id e cor
   — nunca vira texto solto dentro de uma tarefa ou atividade, que é o que
   evitaria "Igreja" e "igreja" virarem duas linhas no ranking. */
async function criarCategoriaRapida(nomeDigitado) {
  const nome = nomeDigitado.trim();
  const existente = STATE.categorias.find((c) => c.nome.toLowerCase() === nome.toLowerCase());
  if (existente) return existente;
  const id = slugId(nome) || `c-${gerarId()}`;
  const cat = { id, nome, cor: CORES_CAT[STATE.categorias.length % CORES_CAT.length], ordem: STATE.categorias.length, ativa: true };
  // otimista: entra na lista local já, porque quem chamou precisa do id na
  // hora pra selecionar a categoria recém-criada (crença 11)
  STATE.categorias = [...STATE.categorias, cat].sort((a, b) => (a.ordem ?? 99) - (b.ordem ?? 99) || a.nome.localeCompare(b.nome, "pt-BR"));
  await emSegundoPlano(
    setDoc(doc(db, "categorias", id), { ...cat, createdAt: serverTimestamp() }, { merge: true }),
    "Não foi possível criar a categoria."
  );
  return cat;
}

/*
  Combobox digitável de categoria. Guarda o id de verdade num <input hidden>
  (que carrega data-i/data-campo pra continuar entrando no mesmo fluxo de
  sincronização de array que as outras linhas editáveis), e o texto visível
  é só um filtro — nunca é ele que vira o valor salvo. Sem opção clicada (ou
  sem "+ Cadastrar" clicado), o texto volta pro nome da categoria escolhida.
*/
function htmlComboCategoria({ dataI, dataCampo = "categoriaId", categoriaId, permitirVazio = false, placeholder = "Categoria…", inputId = "" }) {
  return `
    <div class="combo-cat" data-combo data-permitir-vazio="${permitirVazio ? "1" : "0"}">
      <input type="text" ${inputId ? `id="${esc(inputId)}"` : ""} class="combo-input" autocomplete="off" placeholder="${esc(placeholder)}"
             value="${esc(nomeCategoria(categoriaId))}" />
      <input type="hidden" data-i="${dataI}" data-campo="${dataCampo}" class="combo-valor" value="${esc(categoriaId || "")}" />
      <div class="combo-lista" hidden></div>
    </div>`;
}

/** Liga o comportamento de todo combobox de categoria dentro de `raiz`. */
function ligarCombosCategoria(raiz) {
  raiz.querySelectorAll("[data-combo]").forEach((combo) => {
    const input = combo.querySelector(".combo-input");
    const valor = combo.querySelector(".combo-valor");
    const lista = combo.querySelector(".combo-lista");
    const permitirVazio = combo.dataset.permitirVazio === "1";

    function selecionar(cat) {
      valor.value = cat?.id || "";
      input.value = cat?.nome || "";
      valor.dispatchEvent(new Event("input", { bubbles: true }));
      fechar();
    }

    function fechar() { lista.hidden = true; }

    function abrir() {
      const texto = input.value.trim().toLowerCase();
      const opcoes = STATE.categorias.filter((c) => c.nome.toLowerCase().includes(texto));
      const existeExata = STATE.categorias.some((c) => c.nome.toLowerCase() === texto);

      const linhasOpcoes = opcoes.map((c) => `
        <div class="combo-item ${c.id === valor.value ? "ativa" : ""}" data-id="${esc(c.id)}">
          <span class="cat-ponto" style="background:${esc(c.cor)}"></span>${esc(c.nome)}
        </div>`).join("");
      const linhaVazia = permitirVazio ? `<div class="combo-item" data-id="">Sem categoria</div>` : "";
      const linhaCriar = texto && !existeExata
        ? `<div class="combo-item criar" data-criar="${esc(input.value.trim())}"><span class="ico">${ICONS.mais}</span> Cadastrar "${esc(input.value.trim())}"</div>`
        : "";

      lista.innerHTML = linhaVazia + linhasOpcoes + linhaCriar ||
        `<div class="combo-item vazia">Nenhuma categoria encontrada.</div>`;
      lista.hidden = false;

      lista.querySelectorAll("[data-id]").forEach((el) =>
        el.addEventListener("mousedown", (e) => {
          e.preventDefault();
          selecionar(el.dataset.id ? STATE.categorias.find((c) => c.id === el.dataset.id) : null);
        }));
      lista.querySelectorAll("[data-criar]").forEach((el) =>
        el.addEventListener("mousedown", async (e) => {
          e.preventDefault();
          const cat = await criarCategoriaRapida(el.dataset.criar);
          selecionar(cat);
        }));
    }

    input.addEventListener("focus", abrir);
    input.addEventListener("input", abrir);
    input.addEventListener("blur", () => {
      // dá tempo do mousedown da lista rodar antes de fechar e reverter
      setTimeout(() => {
        fechar();
        input.value = nomeCategoria(valor.value);
      }, 150);
    });
  });
}

/** Tarefas visíveis no checklist, na regra exata que o Felipe descreveu. */
function tarefasDoChecklist() {
  const hoje = STATE.hoje;
  return STATE.tarefas
    .filter((t) => {
      if (t.estado === "descartada") return false;
      // concluída de dia passado sai da tela (e vive no Histórico do Painel)
      if (t.estado === "concluida" && t.data < hoje) return false;
      return true;
    })
    .sort((a, b) =>
      a.data.localeCompare(b.data) ||
      horaEmMinutos(a.hora) - horaEmMinutos(b.hora) ||
      String(a.titulo).localeCompare(String(b.titulo), "pt-BR")
    );
}

/* ═══════════════════════════ render ═══════════════════════════ */

function renderTudo() {
  if (!STATE.user) return;
  renderChecklist();
  renderPainel();
  renderRotinas();
  renderPerfilNumeros();
  atualizarLinhaAgenda();
}

function aoTrocarAba(view) {
  const titulos = {
    hoje: ["Checklist", "Hoje"],
    painel: ["Painel", "Seu progresso"],
    rotinas: ["Configuração", "Rotinas fixas"],
    perfil: ["Conta", "Perfil"],
  };
  const [sub, tit] = titulos[view] || ["", ""];
  $("topbar-sub").textContent = sub;
  $("topbar-titulo").textContent = tit;
  // O menu de três traços existe só na aba de perfil, como no Instagram
  $("btn-menu-perfil").style.display = view === "perfil" ? "" : "none";
  if (view !== "perfil") fecharDrawer();
}

/* ─────────────────────────── checklist ─────────────────────────── */

function renderChecklist() {
  const lista = tarefasDoChecklist();
  const hoje = STATE.hoje;
  const doDia = lista.filter((t) => t.data === hoje);
  const feitasHoje = doDia.filter((t) => t.estado === "concluida").length;
  const atrasadas = lista.filter((t) => t.data < hoje).length;
  const pct = doDia.length ? Math.round((feitasHoje / doDia.length) * 100) : 0;

  $("anel-hoje").style.setProperty("--pct", pct);
  $("anel-hoje").querySelector("span").textContent = `${pct}%`;
  $("prog-hoje").style.width = `${pct}%`;
  $("prog-hoje-num").textContent = `${feitasHoje}/${doDia.length}`;
  $("kpi-hoje-total").textContent = doDia.length;
  $("kpi-atrasadas").textContent = atrasadas;
  $("kpi-feitas-hoje").textContent = feitasHoje;
  $("kpi-sequencia").textContent = calcularSequencia();

  const hint = $("hint-atrasadas");
  if (atrasadas) {
    hint.style.display = "";
    hint.textContent = `${atrasadas} tarefa${atrasadas > 1 ? "s" : ""} de dias anteriores esperando no topo.`;
  } else {
    hint.style.display = "none";
  }

  const badge = $("badge-hoje");
  const pendentesHoje = doDia.length - feitasHoje + atrasadas;
  badge.textContent = pendentesHoje > 99 ? "99" : String(pendentesHoje);
  badge.classList.toggle("on", pendentesHoje > 0);

  const alvo = $("lista-checklist");
  const vazio = $("empty-checklist");

  if (!lista.length) {
    alvo.innerHTML = "";
    vazio.style.display = "";
    vazio.innerHTML = `
      <div class="ico">${ICONS.vazio}</div>
      <p>${STATE.rotinas.length
        ? "Nada pra hoje ainda. Cadastre uma rotina que caia hoje, ou toque no + para adicionar algo."
        : "Comece cadastrando suas rotinas fixas. Elas passam a cair no checklist sozinhas, todo dia."}</p>
      <button class="btn primary" id="btn-vazio-acao">${STATE.rotinas.length ? "Adicionar tarefa" : "Cadastrar rotina"}</button>`;
    $("btn-vazio-acao").addEventListener("click", () =>
      STATE.rotinas.length ? modalTarefa() : nav.irPara("rotinas"));
    return;
  }
  vazio.style.display = "none";

  // agrupado por data, do mais antigo pro mais novo
  const grupos = new Map();
  lista.forEach((t) => {
    if (!grupos.has(t.data)) grupos.set(t.data, []);
    grupos.get(t.data).push(t);
  });

  alvo.innerHTML = [...grupos.entries()].map(([data, itens]) => {
    const feitas = itens.filter((t) => t.estado === "concluida").length;
    const atrasado = data < hoje;
    const futuro = data > hoje;
    const rot = rotuloDia(data, hoje);
    return `
      <div class="dia-bloco ${atrasado ? "atrasado" : ""} ${futuro ? "futuro" : ""}">
        <div class="dia-no"></div>
        <div class="dia-head">
          <span class="dia-data">${rot ? esc(rot) : esc(diaMes(data))}</span>
          <span class="dia-semana">${rot ? esc(diaMes(data)) + " · " : ""}${esc(rot ? nomeDiaSemana(diaSemanaISO(data)) : maiusculaInicial(nomeDiaSemana(diaSemanaISO(data))))}</span>
          ${atrasado ? `<span class="tag-atraso">atrasado</span>` : ""}
          <span class="dia-cont">${feitas}/${itens.length}</span>
        </div>
        ${itens.map(linhaTarefa).join("")}
      </div>`;
  }).join("");

  alvo.querySelectorAll("[data-toggle]").forEach((b) =>
    b.addEventListener("click", () => alternarTarefa(b.dataset.toggle)));
  alvo.querySelectorAll("[data-descartar]").forEach((b) =>
    b.addEventListener("click", () => descartarTarefa(b.dataset.descartar)));
  alvo.querySelectorAll("[data-editar]").forEach((b) =>
    b.addEventListener("click", () => modalTarefa(STATE.tarefas.find((t) => t.id === b.dataset.editar))));
  alvo.querySelectorAll("[data-excluir]").forEach((b) =>
    b.addEventListener("click", () => excluirTarefa(b.dataset.excluir)));
}

function linhaTarefa(t) {
  const feita = t.estado === "concluida";
  const manual = t.origem === "manual";
  /*
    Marcador de agenda. Antes disso não havia como saber se um item tinha
    chegado no Google Agenda sem abrir o Google Agenda e comparar na mão, que
    é exatamente como o Felipe descobriu que as avulsas não estavam indo
    (2026-09-17). Regra invisível é indistinguível de bug (crença 32).
  */
  const naAgenda = manual
    ? !!t.agendaEventoId
    : !!STATE.rotinas.find((r) => r.id === t.rotinaId)?.agendaEventoId;
  const cobrando = !!t.agendaAtrasoId;
  const marcaAgenda = cobrando
    ? `<span class="cat-tag ag on" title="Cobrando todo dia no Google Agenda"><span class="ico">${ICONS.agenda}</span></span>`
    : naAgenda
      ? `<span class="cat-tag ag on" title="No Google Agenda"><span class="ico">${ICONS.agenda}</span></span>`
      : `<span class="cat-tag ag off" title="Ainda não está no Google Agenda"><span class="ico">${ICONS.agenda}</span></span>`;
  return `
    <div class="tarefa ${feita ? "feita" : ""}">
      <button type="button" class="tarefa-check ${feita ? "on" : ""}" data-toggle="${esc(t.id)}"
              aria-label="${feita ? "Desmarcar" : "Concluir"}">
        <span class="ico">${ICONS.check}</span>
      </button>
      <div class="tarefa-corpo">
        <div class="tarefa-titulo">${esc(t.titulo)}</div>
        <div class="tarefa-meta">
          <span class="hora">${esc(t.hora || "--:--")}</span>
          ${tagCategoria(t.categoriaId)}
          ${manual ? `<span class="pill neutro">avulsa</span>`
                   : `<span class="cat-tag" style="color:var(--ink-faint);">${esc(t.rotinaNome || "rotina")}</span>`}
          ${marcaAgenda}
        </div>
      </div>
      <div class="tarefa-acoes">
        ${!feita ? `<button type="button" data-descartar="${esc(t.id)}" aria-label="Descartar" title="Não vou fazer"><span class="ico">${ICONS.descartar}</span></button>` : ""}
        ${manual ? `<button type="button" data-editar="${esc(t.id)}" aria-label="Editar"><span class="ico">${ICONS.lapis}</span></button>
                    <button type="button" data-excluir="${esc(t.id)}" aria-label="Excluir"><span class="ico">${ICONS.excluir}</span></button>` : ""}
      </div>
    </div>`;
}

/** Dias seguidos, terminando em ontem ou hoje, em que tudo foi concluído. */
function calcularSequencia() {
  const porDia = new Map();
  STATE.tarefas.forEach((t) => {
    if (t.estado === "descartada" || t.data > STATE.hoje) return;
    if (!porDia.has(t.data)) porDia.set(t.data, { total: 0, feitas: 0 });
    const g = porDia.get(t.data);
    g.total++;
    if (t.estado === "concluida") g.feitas++;
  });
  let seq = 0;
  let dia = STATE.hoje;
  const g0 = porDia.get(dia);
  if (!g0 || g0.feitas < g0.total) dia = somarDiasISO(dia, -1); // hoje em andamento não quebra
  for (let i = 0; i < DIAS_JANELA; i++) {
    const g = porDia.get(dia);
    if (!g) { dia = somarDiasISO(dia, -1); continue; } // dia sem tarefa não conta nem quebra
    if (g.feitas < g.total) break;
    seq++;
    dia = somarDiasISO(dia, -1);
  }
  return seq;
}

/* ─────────────────────────── ações de tarefa ─────────────────────────── */

async function alternarTarefa(id) {
  const t = STATE.tarefas.find((x) => x.id === id);
  if (!t) return;
  const virando = t.estado !== "concluida";
  // Feedback otimista: a interface muda antes da resposta do servidor
  // (crença 11). Sem sinal a Promise fica pendurada e nada pode esperá-la.
  t.estado = virando ? "concluida" : "pendente";
  renderChecklist();
  renderPainel();

  await emSegundoPlano(
    updateDoc(doc(db, "tarefas", id), {
      estado: virando ? "concluida" : "pendente",
      concluidaEm: virando ? serverTimestamp() : null,
    }),
    "Não foi possível salvar a marcação."
  );
  agendarSincronizacao();
}

async function descartarTarefa(id) {
  const t = STATE.tarefas.find((x) => x.id === id);
  if (!t) return;
  const ok = await confirmar(
    `Descartar "${t.titulo}"? Ela sai do checklist e para de cobrar no Google Agenda, e NÃO conta como concluída no ranking.`,
    { textoConfirmar: "Descartar", textoCancelar: "Voltar" }
  );
  if (!ok) return;

  t.estado = "descartada";
  renderTudo();
  await emSegundoPlano(
    updateDoc(doc(db, "tarefas", id), { estado: "descartada", descartadaEm: serverTimestamp() }),
    "Não foi possível descartar."
  );
  toast("Descartada. Ela fica no Histórico, no Painel.", "sucesso");
  agendarSincronizacao();
}

async function restaurarTarefa(id) {
  await emSegundoPlano(
    updateDoc(doc(db, "tarefas", id), { estado: "pendente", concluidaEm: null, descartadaEm: null }),
    "Não foi possível desfazer."
  );
  toast("Voltou pro checklist.", "sucesso");
  agendarSincronizacao();
}

async function excluirTarefa(id) {
  const t = STATE.tarefas.find((x) => x.id === id);
  if (!t) return;
  const ok = await confirmar(`Excluir "${t.titulo}" de vez? Isso não dá pra desfazer.`);
  if (!ok) return;
  await apagarEventosDe({ agendaEventoId: t.agendaEventoId, agendaAtrasoId: t.agendaAtrasoId });
  await emSegundoPlano(deleteDoc(doc(db, "tarefas", id)), "Não foi possível excluir.");
  toast("Tarefa excluída.", "sucesso");
}

/* Modal de tarefa avulsa. Data e hora em campos separados (mais fácil de
   mudar só um dos dois do que editar um datetime-local inteiro), já
   preenchidos com o momento atual na criação (design-system regra 11). */
function modalTarefa(tarefa) {
  const editando = !!tarefa;
  const agora = new Date();
  const dataInicial = editando ? tarefa.data : isoLocal(agora);
  const horaInicial = editando ? (tarefa.hora || "08:00")
    : `${String(agora.getHours()).padStart(2, "0")}:${String(agora.getMinutes()).padStart(2, "0")}`;

  const corpo = abrirModal(
    editando ? "Editar tarefa" : "Nova tarefa",
    `<div class="field">
       <label for="t-titulo">O que é <span class="obr">*</span></label>
       <input id="t-titulo" type="text" maxlength="160" value="${esc(tarefa?.titulo || "")}" placeholder="Ex.: levar o contrato assinado" />
     </div>
     <div class="field field-2">
       <div>
         <label for="t-data">Data <span class="obr">*</span></label>
         <input id="t-data" type="date" value="${esc(dataInicial)}" />
       </div>
       <div>
         <label for="t-hora">Hora <span class="obr">*</span></label>
         <input id="t-hora" type="time" value="${esc(horaInicial)}" />
       </div>
     </div>
     <div class="field">
       <label for="t-dur">Duração (min)</label>
       <input id="t-dur" type="number" min="5" max="600" step="5" value="${esc(String(tarefa?.duracaoMin || 30))}" />
       <div class="hint">É o tamanho do bloco que essa tarefa ocupa no Google Agenda.</div>
     </div>
     <div class="field">
       <label for="t-cat">Categoria</label>
       ${htmlComboCategoria({ dataI: 0, categoriaId: tarefa?.categoriaId || "", permitirVazio: true, placeholder: "Sem categoria", inputId: "t-cat" })}
       <div class="hint">A categoria é o que alimenta o ranking do Painel.</div>
     </div>`,
    `<span></span>
     <button type="button" class="btn" data-fechar-modal>Cancelar</button>
     <button type="button" class="btn primary" id="t-salvar">Salvar</button>`
  );
  ligarCombosCategoria(corpo);

  corpo.querySelector("#t-titulo").addEventListener("keydown", (e) => {
    if (e.key === "Enter") $("t-salvar").click();
  });

  $("t-salvar").addEventListener("click", async () => {
    const titulo = corpo.querySelector("#t-titulo").value.trim();
    const data = corpo.querySelector("#t-data").value;
    const hora = corpo.querySelector("#t-hora").value;
    const duracaoMin = Number(corpo.querySelector("#t-dur").value) || 30;
    const categoriaId = corpo.querySelector(".combo-valor").value;
    if (!titulo) return toast("Informe o que é a tarefa.", "erro");
    if (!data) return toast("Informe a data.", "erro");
    if (!hora) return toast("Informe a hora.", "erro");

    fecharModal();

    if (editando) {
      await emSegundoPlano(
        updateDoc(doc(db, "tarefas", tarefa.id), { titulo, data, hora, duracaoMin, categoriaId }),
        "Não foi possível salvar a tarefa."
      );
      toast("Tarefa atualizada.", "sucesso");
    } else {
      await emSegundoPlano(
        setDoc(doc(db, "tarefas", `m-${gerarId()}`), {
          data, hora, duracaoMin, titulo, categoriaId,
          estado: "pendente", origem: "manual",
          rotinaId: null, rotinaAtividadeId: null, rotinaNome: null,
          concluidaEm: null, descartadaEm: null,
          agendaEventoId: null, agendaHash: null,
          agendaAtrasoId: null, agendaAtrasoAte: null,
          createdAt: serverTimestamp(),
        }),
        "Não foi possível salvar a tarefa."
      );
      toast("Tarefa adicionada. Indo pro Google Agenda.", "sucesso");
      if (data > STATE.hoje) toast("Ela é de um dia futuro e aparece mais abaixo no checklist.", "info", 6000);
    }
    agendarSincronizacao();
  });
}

/* ─────────────────────────── painel ─────────────────────────── */

/*
  Devolve os recortes NOMEADOS, não um array anônimo (antecipacao.md C4).
  A busca/filtro encolhe a lista e não pode encolher o KPI, e um retorno
  único não dá como o chamador perceber que pegou o recorte errado.
*/
function recortesDoPeriodo() {
  const inicio = somarDiasISO(STATE.hoje, -(STATE.periodoDias - 1));
  const doPeriodo = STATE.tarefas.filter((t) => t.data >= inicio && t.data <= STATE.hoje);
  const historico = doPeriodo
    .filter((t) => t.estado !== "pendente")
    .filter((t) => !STATE.histFiltroCat || t.categoriaId === STATE.histFiltroCat)
    .sort((a, b) => b.data.localeCompare(a.data) || horaEmMinutos(b.hora) - horaEmMinutos(a.hora));
  return { inicio, doPeriodo, historico };
}

function renderPainel() {
  const { doPeriodo, historico } = recortesDoPeriodo();

  const concluidas = doPeriodo.filter((t) => t.estado === "concluida").length;
  const descartadas = doPeriodo.filter((t) => t.estado === "descartada").length;
  const base = doPeriodo.length - descartadas; // descartada não entra na taxa
  const taxa = base ? Math.round((concluidas / base) * 100) : 0;

  $("kpi-p-lancadas").textContent = doPeriodo.length;
  $("kpi-p-concluidas").textContent = concluidas;
  $("kpi-p-taxa").innerHTML = `${taxa}<small>%</small>`;
  $("kpi-p-descartadas").textContent = descartadas;

  renderRanking(doPeriodo);
  renderHistorico(historico);
}

/*
  Ranking por categoria. O trabalho do dado é comparar magnitude entre
  categorias, então barra horizontal ordenada. Cada barra leva rótulo direto
  com o nome da categoria, e por isso a identidade nunca depende só da cor —
  o que também dispensa legenda. Os números ficam em tinta de texto, nunca na
  cor da série.
*/
function renderRanking(doPeriodo) {
  const por = new Map();
  doPeriodo.forEach((t) => {
    const k = t.categoriaId || "__sem";
    if (!por.has(k)) por.set(k, { total: 0, concluidas: 0, descartadas: 0 });
    const g = por.get(k);
    g.total++;
    if (t.estado === "concluida") g.concluidas++;
    if (t.estado === "descartada") g.descartadas++;
  });

  const linhas = [...por.entries()]
    .map(([id, g]) => {
      const base = g.total - g.descartadas;
      return {
        id,
        nome: id === "__sem" ? "Sem categoria" : nomeCategoria(id) || "Categoria removida",
        cor: id === "__sem" ? "var(--ink-faint)" : corCategoria(id),
        ...g, base,
        pct: base ? Math.round((g.concluidas / base) * 100) : 0,
      };
    })
    .sort((a, b) => b.concluidas - a.concluidas || b.pct - a.pct);

  const alvo = $("rank-lista");
  const vazio = $("rank-vazio");
  if (!linhas.length) {
    alvo.innerHTML = "";
    vazio.style.display = "";
    vazio.innerHTML = `<div class="ico">${ICONS.painel}</div><p>Nada concluído nesse período ainda.</p>`;
    return;
  }
  vazio.style.display = "none";
  const maior = Math.max(...linhas.map((l) => l.concluidas), 1);

  alvo.innerHTML = linhas.map((l, i) => `
    <div class="rank-linha" data-rank="${esc(l.id)}">
      <div class="rank-topo">
        <span class="rank-pos num">${i + 1}</span>
        <span class="rank-nome">
          <span class="cat-ponto" style="background:${esc(l.cor)}"></span>
          <span class="txt">${esc(l.nome)}</span>
        </span>
        <span class="rank-valor num"><b>${l.concluidas}</b><em>/${l.base} · ${l.pct}%</em></span>
      </div>
      <div class="rank-barra">
        <div class="rank-feito" style="width:${Math.round((l.concluidas / maior) * 100)}%; background:${esc(l.cor)}"></div>
      </div>
    </div>`).join("");

  alvo.querySelectorAll("[data-rank]").forEach((el) => {
    const l = linhas.find((x) => x.id === el.dataset.rank);
    const mostrar = (e) => tip.mostrar(
      `<b>${esc(l.nome)}</b>
       ${l.concluidas} concluída${l.concluidas === 1 ? "" : "s"} de ${l.base} lançada${l.base === 1 ? "" : "s"}<br>
       Conclusão <span class="num">${l.pct}%</span>${l.descartadas ? `<br>${l.descartadas} descartada${l.descartadas === 1 ? "" : "s"}` : ""}`,
      e.clientX, el.getBoundingClientRect().top
    );
    el.addEventListener("mouseenter", mostrar);
    el.addEventListener("mousemove", mostrar);
    el.addEventListener("mouseleave", () => tip.esconder());
  });
}

function renderHistorico(historico) {
  const sel = $("hist-filtro-cat");
  const atual = STATE.histFiltroCat;
  sel.innerHTML = `<option value="">Todas</option>` +
    STATE.categorias.map((c) => `<option value="${esc(c.id)}" ${c.id === atual ? "selected" : ""}>${esc(c.nome)}</option>`).join("");

  $("hist-cont").textContent = historico.length ? `${historico.length} registro${historico.length > 1 ? "s" : ""}` : "";
  const tbody = $("tbody-historico");
  const vazio = $("hist-vazio");
  const maisEl = $("hist-mais");

  if (!historico.length) {
    tbody.innerHTML = "";
    vazio.style.display = "";
    maisEl.style.display = "none";
    vazio.innerHTML = `<div class="ico">${ICONS.historico}</div><p>Nada concluído nem descartado nesse período.</p>`;
    return;
  }
  vazio.style.display = "none";

  const visiveis = historico.slice(0, STATE.histLimite);
  const restam = historico.length - visiveis.length;
  maisEl.style.display = restam ? "" : "none";
  maisEl.textContent = `Ver mais ${Math.min(restam, 25)} de ${restam}`;

  tbody.innerHTML = visiveis.map((t) => `
    <tr>
      <td class="num">${esc(diaMes(t.data))}</td>
      <td class="larga">${esc(t.titulo)}</td>
      <td>${tagCategoria(t.categoriaId)}</td>
      <td>${t.estado === "concluida" ? `<span class="pill credit">concluída</span>` : `<span class="pill neutro">descartada</span>`}</td>
      <td class="acao">
        <button type="button" class="btn ghost icone" data-desfazer="${esc(t.id)}" aria-label="Voltar pro checklist" title="Voltar pro checklist"><span class="ico">${ICONS.historico}</span></button>
        <button type="button" class="btn ghost icone" data-apagar="${esc(t.id)}" aria-label="Excluir"><span class="ico">${ICONS.excluir}</span></button>
      </td>
    </tr>`).join("");

  tbody.querySelectorAll("[data-desfazer]").forEach((b) =>
    b.addEventListener("click", () => restaurarTarefa(b.dataset.desfazer)));
  tbody.querySelectorAll("[data-apagar]").forEach((b) =>
    b.addEventListener("click", () => excluirTarefa(b.dataset.apagar)));
}

/* ─────────────────────────── rotinas ─────────────────────────── */

function renderRotinas() {
  const ativas = STATE.rotinas.filter((r) => r.ativa);
  $("kpi-r-ativas").textContent = ativas.length;
  $("kpi-r-semana").textContent = ativas.reduce(
    (s, r) => s + (r.diasSemana || []).length * atividadesEfetivas(r).length, 0);

  const alvo = $("lista-rotinas");
  const vazio = $("empty-rotinas");

  if (!STATE.rotinas.length) {
    alvo.innerHTML = "";
    vazio.style.display = "";
    vazio.innerHTML = `
      <div class="ico">${ICONS.rotinas}</div>
      <p>Nenhuma rotina cadastrada. Uma rotina é um bloco com hora, dias da semana
      e as atividades dentro dele. Depois de salva, ela cai no checklist sozinha.</p>
      <button class="btn primary" id="btn-vazio-rotina">Cadastrar a primeira</button>`;
    $("btn-vazio-rotina").addEventListener("click", () => modalRotina());
    return;
  }
  vazio.style.display = "none";

  // organizada por dia da semana, domingo primeiro: cada rotina entra pelo
  // menor dia em que ela cai, e dentro do mesmo dia segue por horário
  const rotinasOrdenadas = [...STATE.rotinas].sort((a, b) => {
    const diaA = Math.min(...(a.diasSemana?.length ? a.diasSemana : [7]));
    const diaB = Math.min(...(b.diasSemana?.length ? b.diasSemana : [7]));
    return diaA - diaB || horaEmMinutos(a.hora) - horaEmMinutos(b.hora) || String(a.nome).localeCompare(String(b.nome), "pt-BR");
  });

  alvo.innerHTML = rotinasOrdenadas.map((r) => `
    <div class="rotina ${r.ativa ? "" : "inativa"}">
      <div class="rotina-topo">
        <div style="flex:1; min-width:0;">
          <div class="rotina-nome">${esc(r.nome)}</div>
          <div style="display:flex; align-items:center; gap:9px; margin-top:3px; flex-wrap:wrap;">
            <span class="rotina-hora">${esc(r.hora || "--:--")}</span>
            ${tagCategoria(r.categoriaId)}
            ${(r.atividades || []).length ? `<span class="cat-tag" style="color:var(--ink-faint);">+${(r.atividades || []).length} atividade${(r.atividades || []).length === 1 ? "" : "s"}</span>` : ""}
          </div>
        </div>
        <div class="tarefa-acoes">
          <button type="button" class="pill ${r.ativa ? "credit" : "neutro"}" data-toggle-rotina="${esc(r.id)}"
                  title="${r.ativa ? "Pausar: para de lançar no checklist" : "Reativar: volta a lançar no checklist"}"
                  style="border:none; cursor:pointer;">${r.ativa ? "Ativa" : "Pausada"}</button>
          <button type="button" data-lancar-rotina="${esc(r.id)}" aria-label="Lançar atividade agora"
                  title="${r.ativa ? "Lança hoje se hoje for dia dela, senão na próxima ocorrência" : "Rotina pausada — reative pra lançar"}"
                  ${r.ativa ? "" : "disabled"}><span class="ico">${ICONS.lancar}</span></button>
          <button type="button" data-ver="${esc(r.id)}" aria-label="Ver"><span class="ico">${ICONS.info}</span></button>
          <button type="button" data-editar-rotina="${esc(r.id)}" aria-label="Editar"><span class="ico">${ICONS.lapis}</span></button>
          <button type="button" data-excluir-rotina="${esc(r.id)}" aria-label="Excluir"><span class="ico">${ICONS.excluir}</span></button>
        </div>
      </div>
      <div class="dias-chips">
        ${[1, 2, 3, 4, 5, 6, 0].map((d) =>
          `<span class="dia-chip fixo ${(r.diasSemana || []).includes(d) ? "on" : ""}">${curtoDiaSemana(d)}</span>`).join("")}
      </div>
      ${(r.atividades || []).length ? `<div class="rotina-atividades">
        ${r.atividades.map((a) => `
          <div class="rotina-atividade">
            <span class="cat-ponto" style="background:${esc(corCategoria(a.categoriaId))}"></span>
            <span class="txt">${esc(rotuloAtividade(a))}</span>
            <span style="color:var(--ink-faint); font-size:12px; flex-shrink:0;">${esc(nomeCategoria(a.categoriaId))}</span>
          </div>`).join("")}
      </div>` : ""}
    </div>`).join("");

  alvo.querySelectorAll("[data-toggle-rotina]").forEach((b) =>
    b.addEventListener("click", () => alternarRotinaAtiva(b.dataset.toggleRotina)));
  alvo.querySelectorAll("[data-lancar-rotina]").forEach((b) =>
    b.addEventListener("click", () => lancarAtividadeAgora(STATE.rotinas.find((r) => r.id === b.dataset.lancarRotina))));
  alvo.querySelectorAll("[data-ver]").forEach((b) =>
    b.addEventListener("click", () => modalVerRotina(b.dataset.ver)));
  alvo.querySelectorAll("[data-editar-rotina]").forEach((b) =>
    b.addEventListener("click", () => modalRotina(STATE.rotinas.find((r) => r.id === b.dataset.editarRotina))));
  alvo.querySelectorAll("[data-excluir-rotina]").forEach((b) =>
    b.addEventListener("click", () => excluirRotina(b.dataset.excluirRotina)));
}

/* Registro existente abre visualizando; editar é ação explícita atrás do
   lápis (crença 16). O lápis clicado na linha é a exceção declarada. */
function modalVerRotina(id) {
  const r = STATE.rotinas.find((x) => x.id === id);
  if (!r) return;
  const lancadas = STATE.tarefas.filter((t) => t.rotinaId === r.id);
  const feitas = lancadas.filter((t) => t.estado === "concluida").length;

  abrirModal(r.nome,
    `<div class="dado-linha"><span class="rot">Categoria</span><span class="val">${tagCategoria(r.categoriaId)}</span></div>
     <div class="dado-linha"><span class="rot">Horário</span><span class="val num">${esc(r.hora || "--:--")}</span></div>
     <div class="dado-linha"><span class="rot">Duração</span><span class="val num">${esc(String(r.duracaoMin || 30))} min</span></div>
     <div class="dado-linha"><span class="rot">Dias</span><span class="val">${
       (r.diasSemana || []).slice().sort().map((d) => nomeDiaSemana(d).replace("-feira", "")).join(", ") || "nenhum"
     }</span></div>
     <div class="dado-linha"><span class="rot">Situação</span><span class="val">${r.ativa ? "ativa" : "pausada"}</span></div>
     <div class="dado-linha"><span class="rot">No Google Agenda</span><span class="val">${
       r.agendaEventoId ? "evento recorrente criado" : "ainda não sincronizada"
     }</span></div>
     <div class="dado-linha"><span class="rot">Nos últimos 90 dias</span><span class="val num">${feitas}/${lancadas.length}</span></div>
     ${(r.atividades || []).length ? `<div style="margin-top:16px;">
       <label>Atividades extras</label>
       <div class="rotina-atividades">
         ${r.atividades.map((a) => `
           <div class="rotina-atividade">
             <span class="cat-ponto" style="background:${esc(corCategoria(a.categoriaId))}"></span>
             <span class="txt">${esc(rotuloAtividade(a))}</span>
             <span style="color:var(--ink-faint); font-size:12px;">${esc(nomeCategoria(a.categoriaId))}</span>
           </div>`).join("")}
       </div>
     </div>` : `<div class="hint" style="margin-top:12px;">Sem atividades extras — a categoria da própria rotina já é o que lança no checklist.</div>`}`,
    `<span></span>
     <button type="button" class="btn" data-fechar-modal>Fechar</button>
     <button type="button" class="btn primary" id="r-editar">Editar</button>`
  );
  $("r-editar").addEventListener("click", () => { fecharModal(); modalRotina(r); });
}

function modalRotina(rotina) {
  const editando = !!rotina;
  const dias = new Set(rotina?.diasSemana ?? [1, 2, 3, 4, 5]);
  let atividades = (rotina?.atividades ?? [{ id: gerarId(), titulo: "", categoriaId: "" }]).map((a) => ({ ...a }));

  const corpo = abrirModal(
    editando ? "Editar rotina" : "Nova rotina",
    `<div class="field">
       <label for="r-nome">Nome da rotina <span class="obr">*</span></label>
       <input id="r-nome" type="text" maxlength="80" value="${esc(rotina?.nome || "")}" placeholder="Ex.: Bloco da manhã" />
     </div>
     <div class="field">
       <label>Categoria da rotina <span class="obr">*</span></label>
       <div id="r-cat-wrap">${htmlComboCategoria({ dataI: "r", categoriaId: rotina?.categoriaId || "" })}</div>
       <div class="hint">Vale pro ranking sempre que a rotina não tiver nenhuma atividade cadastrada — nesse caso, ela é a própria atividade.</div>
     </div>
     <div class="field field-2">
       <div>
         <label for="r-hora">Horário <span class="obr">*</span></label>
         <input id="r-hora" type="time" value="${esc(rotina?.hora || "07:00")}" />
       </div>
       <div>
         <label for="r-dur">Duração (min)</label>
         <input id="r-dur" type="number" min="5" max="600" step="5" value="${esc(String(rotina?.duracaoMin || 30))}" />
       </div>
     </div>
     <div class="field">
       <label>Dias da semana <span class="obr">*</span></label>
       <div class="dias-chips" id="r-dias">
         ${[1, 2, 3, 4, 5, 6, 0].map((d) =>
           `<button type="button" class="dia-chip ${dias.has(d) ? "on" : ""}" data-dia="${d}"
                    title="${nomeDiaSemana(d)}">${curtoDiaSemana(d)}</button>`).join("")}
       </div>
       <div class="hint">Segunda a sexta já vem marcado.</div>
     </div>
     <div class="field">
       <label>Atividades desta rotina</label>
       <div class="hint" style="margin:0 0 8px;">Opcional. Se adicionar uma, ela precisa de categoria — o título é livre.</div>
       <div id="r-ativs"></div>
       <button type="button" class="btn bloco" id="r-add-ativ" style="margin-top:4px;">
         <span class="ico">${ICONS.mais}</span> Adicionar atividade
       </button>
     </div>
     ${editando ? `
     <div class="field">
       <label for="r-ativa">Situação</label>
       <select id="r-ativa">
         <option value="1" ${rotina.ativa ? "selected" : ""}>Ativa — lança no checklist</option>
         <option value="0" ${!rotina.ativa ? "selected" : ""}>Pausada — para de lançar</option>
       </select>
     </div>` : ""}
     <div class="aviso" style="margin-top:4px;">
       <span class="ico">${ICONS.agenda}</span>
       <span>Ao salvar, esta rotina vira um evento recorrente no seu Google Agenda,
       com lembrete na hora e 10 minutos antes.</span>
     </div>`,
    `${editando ? `<button type="button" class="btn danger" id="r-excluir">Excluir</button>` : `<span></span>`}
     <button type="button" class="btn primary" id="r-salvar">Salvar</button>`
  );

  ligarCombosCategoria(corpo.querySelector("#r-cat-wrap"));

  const alvoAtivs = corpo.querySelector("#r-ativs");
  function renderAtivs() {
    alvoAtivs.innerHTML = atividades.map((a, i) => `
      <div class="ativ-edit">
        <input type="text" maxlength="160" data-i="${i}" data-campo="titulo"
               value="${esc(a.titulo)}" placeholder="Título (opcional)" />
        ${htmlComboCategoria({ dataI: i, categoriaId: a.categoriaId })}
        <button type="button" data-remover="${i}" aria-label="Remover"><span class="ico">${ICONS.excluir}</span></button>
      </div>`).join("") || `<div class="hint">Nenhuma atividade extra — a categoria da rotina acima já é o que lança no checklist.</div>`;

    ligarCombosCategoria(alvoAtivs);
    alvoAtivs.querySelectorAll("[data-campo]").forEach((el) => {
      el.addEventListener("input", () => { atividades[Number(el.dataset.i)][el.dataset.campo] = el.value; });
    });
    alvoAtivs.querySelectorAll("[data-remover]").forEach((b) => {
      b.addEventListener("click", () => { atividades.splice(Number(b.dataset.remover), 1); renderAtivs(); });
    });
  }
  renderAtivs();

  corpo.querySelector("#r-add-ativ").addEventListener("click", () => {
    atividades.push({ id: gerarId(), titulo: "", categoriaId: "" });
    renderAtivs();
    alvoAtivs.querySelector(".ativ-edit:last-child input")?.focus();
  });

  corpo.querySelectorAll("#r-dias [data-dia]").forEach((b) => {
    b.addEventListener("click", () => {
      const d = Number(b.dataset.dia);
      if (dias.has(d)) dias.delete(d); else dias.add(d);
      b.classList.toggle("on", dias.has(d));
    });
  });

  $("r-excluir")?.addEventListener("click", () => { fecharModal(); excluirRotina(rotina.id); });

  $("r-salvar").addEventListener("click", async () => {
    const nome = corpo.querySelector("#r-nome").value.trim();
    const categoriaId = corpo.querySelector("#r-cat-wrap .combo-valor").value;
    const hora = corpo.querySelector("#r-hora").value;
    const duracaoMin = Number(corpo.querySelector("#r-dur").value) || 30;
    const ativa = editando ? corpo.querySelector("#r-ativa").value === "1" : true;
    // uma linha só conta como atividade de verdade se tiver título ou
    // categoria escolhida; uma linha totalmente vazia é descartada em
    // silêncio (é só o que sobra de "adicionar" e não preencher)
    const tocadas = atividades
      .map((a) => ({ id: a.id || gerarId(), titulo: String(a.titulo || "").trim(), categoriaId: a.categoriaId || "" }))
      .filter((a) => a.titulo || a.categoriaId);

    if (!nome) return toast("Informe o nome da rotina.", "erro");
    if (!categoriaId) return toast("Escolha a categoria da rotina.", "erro");
    if (!hora) return toast("Informe o horário.", "erro");
    if (!dias.size) return toast("Marque pelo menos um dia da semana.", "erro");
    if (tocadas.some((a) => !a.categoriaId)) return toast("Toda atividade precisa de uma categoria.", "erro");
    const limpas = tocadas;

    const id = rotina?.id || `r-${gerarId()}`;
    const dados = {
      nome, categoriaId, hora, duracaoMin, ativa,
      diasSemana: [...dias].sort(),
      atividades: limpas,
      ...(editando ? {} : { agendaEventoId: null, agendaHash: null, createdAt: serverTimestamp() }),
    };

    fecharModal();
    const ok = await emSegundoPlano(
      setDoc(doc(db, "rotinas", id), dados, { merge: true }),
      "Não foi possível salvar a rotina."
    );
    if (!ok) return;
    toast(editando ? "Rotina atualizada." : "Rotina criada.", "sucesso");

    const salva = { id, ...dados };
    await limparOrfasDaRotina(salva);
    await lancarRotinaHoje(salva);
    agendarSincronizacao();
  });
}

/** Pausar/reativar direto na lista, sem abrir o formulário inteiro. */
async function alternarRotinaAtiva(id) {
  const r = STATE.rotinas.find((x) => x.id === id);
  if (!r) return;
  const ativa = !r.ativa;
  const atualizada = { ...r, ativa };
  const ok = await emSegundoPlano(updateDoc(doc(db, "rotinas", id), { ativa }), "Não foi possível atualizar a rotina.");
  if (!ok) return;
  await limparOrfasDaRotina(atualizada);
  await lancarRotinaHoje(atualizada);
  toast(ativa ? "Rotina ativada." : "Rotina pausada. Ela para de lançar no checklist.", "sucesso");
  agendarSincronizacao();
}

async function excluirRotina(id) {
  const r = STATE.rotinas.find((x) => x.id === id);
  if (!r) return;
  const pendentes = STATE.tarefas.filter((t) => t.rotinaId === id && t.estado === "pendente").length;
  const ok = await confirmar(
    `Excluir a rotina "${r.nome}"? O evento recorrente sai do Google Agenda e ${pendentes
      ? `as ${pendentes} tarefa(s) pendentes dela saem do checklist`
      : "nada pendente é afetado"}. O que já foi concluído fica no Histórico.`
  );
  if (!ok) return;

  await apagarEventosDe({ agendaEventoId: r.agendaEventoId });

  const orfas = STATE.tarefas.filter((t) => t.rotinaId === id && t.estado === "pendente");
  for (let i = 0; i < orfas.length; i += 450) {
    const batch = writeBatch(db);
    orfas.slice(i, i + 450).forEach((t) => batch.delete(doc(db, "tarefas", t.id)));
    await emSegundoPlano(batch.commit(), "Não foi possível limpar as tarefas da rotina.");
  }
  await emSegundoPlano(deleteDoc(doc(db, "rotinas", id)), "Não foi possível excluir a rotina.");
  toast("Rotina excluída.", "sucesso");
}

/* ─────────────────────────── perfil ─────────────────────────── */

function renderPerfil() {
  const u = STATE.user;
  if (!u) return;
  const nome = STATE.perfil.nome || u.displayName || u.email?.split("@")[0] || "—";
  const inicial = String(nome).trim().charAt(0).toUpperCase() || "?";

  const av = $("perfil-avatar");
  if (u.photoURL) {
    av.innerHTML = `<img src="${esc(u.photoURL)}" alt="" style="width:100%;height:100%;border-radius:50%;object-fit:cover;" />`;
  } else {
    av.textContent = inicial;
  }
  $("perfil-nome").textContent = nome;
  $("perfil-email").textContent = u.email || "";

  const provedores = (u.providerData || []).map((p) =>
    p.providerId === "google.com" ? "Google" : p.providerId === "password" ? "E-mail e senha" : p.providerId);

  $("perfil-dados").innerHTML = [
    ["Nome completo", STATE.perfil.nome],
    ["Telefone", STATE.perfil.telefone],
    ["Nascimento", STATE.perfil.nascimento ? parseDataLocal(STATE.perfil.nascimento).toLocaleDateString("pt-BR") : ""],
    ["Ocupação", STATE.perfil.ocupacao],
    ["Entra por", provedores.join(" · ")],
  ].map(([rot, val]) => `
    <div class="dado-linha">
      <span class="rot">${esc(rot)}</span>
      <span class="val">${val ? esc(val) : `<span style="color:var(--ink-faint);">não informado</span>`}</span>
    </div>`).join("");
}

function renderPerfilNumeros() {
  const feitas = STATE.tarefas.filter((t) => t.estado === "concluida").length;
  $("kpi-u-total").textContent = feitas;
  const datas = STATE.tarefas.map((t) => t.data).filter(Boolean).sort();
  $("kpi-u-dias").textContent = datas.length ? diffDiasISO(datas[0], STATE.hoje) + 1 : 0;
}

function modalPerfil() {
  const p = STATE.perfil;
  const corpo = abrirModal("Meus dados",
    `<div class="field">
       <label for="p-nome">Nome completo</label>
       <input id="p-nome" type="text" maxlength="120" value="${esc(p.nome || STATE.user?.displayName || "")}" />
     </div>
     <div class="field">
       <label for="p-tel">Telefone</label>
       <input id="p-tel" type="tel" maxlength="20" value="${esc(p.telefone || "")}" placeholder="(00) 00000-0000" />
     </div>
     <div class="field field-2">
       <div>
         <label for="p-nasc">Nascimento</label>
         <input id="p-nasc" type="date" value="${esc(p.nascimento || "")}" />
       </div>
       <div>
         <label for="p-ocup">Ocupação</label>
         <input id="p-ocup" type="text" maxlength="80" value="${esc(p.ocupacao || "")}" />
       </div>
     </div>
     <div class="hint">O e-mail vem do login e não muda por aqui.</div>`,
    `<span></span>
     <button type="button" class="btn" data-fechar-modal>Cancelar</button>
     <button type="button" class="btn primary" id="p-salvar">Salvar</button>`
  );

  $("p-salvar").addEventListener("click", async () => {
    const dados = {
      nome: corpo.querySelector("#p-nome").value.trim(),
      telefone: corpo.querySelector("#p-tel").value.trim(),
      nascimento: corpo.querySelector("#p-nasc").value || "",
      ocupacao: corpo.querySelector("#p-ocup").value.trim(),
    };
    fecharModal();
    await emSegundoPlano(setDoc(doc(db, "config", "perfil"), dados, { merge: true }),
      "Não foi possível salvar seus dados.");
    toast("Dados salvos.", "sucesso");
  });
}

/* ─────────────────── drawer de configurações ─────────────────── */

function abrirDrawer() {
  $("drawer-config").classList.add("open");
  $("drawer-backdrop").classList.add("show");
  atualizarLinhaAgenda();
}
function fecharDrawer() {
  $("drawer-config").classList.remove("open");
  $("drawer-backdrop").classList.remove("show");
}

function atualizarLinhaAgenda() {
  const sub = $("cfg-agenda-sub");
  if (!sub) return;
  const ativas = STATE.rotinas.filter((r) => r.ativa);
  const avulsas = STATE.tarefas.filter((t) => t.origem === "manual" && t.estado !== "descartada" && t.data >= STATE.hoje);
  const atrasadas = STATE.tarefas.filter((t) => t.estado === "pendente" && t.data < STATE.hoje);
  const faltando = ativas.filter((r) => !r.agendaEventoId).length
    + avulsas.filter((t) => !t.agendaEventoId).length
    + atrasadas.filter((t) => !t.agendaAtrasoId).length;

  if (!agendaConfigurada()) sub.textContent = "falta o ID do cliente OAuth";
  else if (!agendaConectada() && !agendaJaAutorizada()) sub.textContent = "não conectado, nada é lançado";
  else if (faltando) sub.textContent = `${faltando} item(ns) fora da agenda`;
  else sub.textContent = "tudo sincronizado";

  const cats = $("cfg-categorias-sub");
  if (cats) cats.textContent = `${STATE.categorias.length} cadastrada${STATE.categorias.length === 1 ? "" : "s"}`;
  const sobre = $("cfg-sobre-sub");
  if (sobre) sobre.textContent = "AppRotina · versão 1";
}

function modalCategorias() {
  let lista = STATE.categorias.map((c) => ({ ...c }));

  function render() {
    const corpo = abrirModal("Categorias",
      `<div class="aviso info">
         <span class="ico">${ICONS.info}</span>
         <span>Categoria é escolhida numa lista, nunca digitada solta. Sem isso
         "Igreja" e "igreja" virariam duas linhas no ranking.</span>
       </div>
       <div id="c-lista"></div>
       <button type="button" class="btn bloco" id="c-add" style="margin-top:8px;">
         <span class="ico">${ICONS.mais}</span> Nova categoria
       </button>`,
      `<span></span>
       <button type="button" class="btn" data-fechar-modal>Fechar</button>
       <button type="button" class="btn primary" id="c-salvar">Salvar</button>`
    );

    const alvo = corpo.querySelector("#c-lista");
    function renderLinhas() {
      alvo.innerHTML = lista.map((c, i) => `
        <div class="ativ-edit">
          <input type="text" maxlength="40" data-i="${i}" value="${esc(c.nome)}" placeholder="Nome da categoria" />
          <select data-cor="${i}">
            ${CORES_CAT.map((cor) => `<option value="${cor}" ${cor === c.cor ? "selected" : ""}>${nomeCor(cor)}</option>`).join("")}
          </select>
          <button type="button" data-rm="${i}" aria-label="Remover"><span class="ico">${ICONS.excluir}</span></button>
        </div>`).join("") || `<div class="hint">Nenhuma categoria ainda.</div>`;

      alvo.querySelectorAll("input[data-i]").forEach((el) =>
        el.addEventListener("input", () => { lista[Number(el.dataset.i)].nome = el.value; }));
      alvo.querySelectorAll("select[data-cor]").forEach((el) =>
        el.addEventListener("change", () => { lista[Number(el.dataset.cor)].cor = el.value; }));
      alvo.querySelectorAll("[data-rm]").forEach((b) =>
        b.addEventListener("click", async () => {
          const i = Number(b.dataset.rm);
          const cat = lista[i];
          const usos = STATE.tarefas.filter((t) => t.categoriaId === cat.id).length;
          if (cat.id && usos) {
            const ok = await confirmar(
              `"${cat.nome}" está em ${usos} tarefa(s). Remover deixa ela fora da lista de escolha, mas o histórico continua mostrando o nome.`,
              { textoConfirmar: "Remover da lista" }
            );
            if (!ok) return render();
          }
          lista.splice(i, 1);
          renderLinhas();
        }));
    }
    renderLinhas();

    corpo.querySelector("#c-add").addEventListener("click", () => {
      lista.push({ id: "", nome: "", cor: CORES_CAT[lista.length % CORES_CAT.length], ativa: true });
      renderLinhas();
      alvo.querySelector(".ativ-edit:last-child input")?.focus();
    });

    $("c-salvar").addEventListener("click", async () => {
      const nomes = lista.map((c) => String(c.nome || "").trim()).filter(Boolean);
      if (nomes.length !== new Set(nomes.map((n) => n.toLowerCase())).size) {
        return toast("Tem duas categorias com o mesmo nome.", "erro");
      }
      const batch = writeBatch(db);
      const mantidos = new Set();
      lista.forEach((c, i) => {
        const nome = String(c.nome || "").trim();
        if (!nome) return;
        const id = c.id || slugId(nome) || `c-${gerarId()}`;
        mantidos.add(id);
        batch.set(doc(db, "categorias", id), { nome, cor: c.cor, ordem: i, ativa: true }, { merge: true });
      });
      // remover da lista é desativar, nunca apagar: o histórico ainda precisa
      // resolver o nome da categoria (crença 32)
      STATE.categorias.forEach((c) => {
        if (!mantidos.has(c.id)) batch.set(doc(db, "categorias", c.id), { ativa: false }, { merge: true });
      });
      fecharModal();
      await emSegundoPlano(batch.commit(), "Não foi possível salvar as categorias.");
      toast("Categorias salvas.", "sucesso");
    });
  }
  render();
}

function nomeCor(hex) {
  return { "#02AD58": "Verde", "#A867FF": "Violeta", "#C48001": "Âmbar", "#0A9DD3": "Azul", "#FF3457": "Vermelho", "#0CA5A7": "Turquesa" }[hex] || hex;
}

function modalAgenda() {
  const d = diagnosticoAgenda();
  const conectada = d.conectada || d.autorizada;
  const ativas = STATE.rotinas.filter((r) => r.ativa);
  const rotOk = ativas.filter((r) => r.agendaEventoId).length;

  /*
    As contagens abaixo existem por causa do que ele reportou em 2026-09-17:
    três tarefas avulsas não chegaram na agenda e a única forma de descobrir
    foi abrir o Google Agenda e comparar item por item. O número tem que
    estar aqui, não na cabeça dele.
  */
  const avulsas = STATE.tarefas.filter((t) => t.origem === "manual" && t.estado !== "descartada" && t.data >= STATE.hoje);
  const avulsasOk = avulsas.filter((t) => t.agendaEventoId).length;
  const atrasadas = STATE.tarefas.filter((t) => t.estado === "pendente" && t.data < STATE.hoje);
  const atrasadasOk = atrasadas.filter((t) => t.agendaAtrasoId).length;
  const faltando = (ativas.length - rotOk) + (avulsas.length - avulsasOk) + (atrasadas.length - atrasadasOk);

  const linha = (rot, ok, total) => `
    <div class="dado-linha">
      <span class="rot">${esc(rot)}</span>
      <span class="val num">${ok}/${total}${ok < total ? ` <span class="pill warn">falta ${total - ok}</span>` : ""}</span>
    </div>`;

  abrirModal("Google Agenda",
    `${!d.configurada ? `
      <div class="aviso">
        <span class="ico">${ICONS.alerta}</span>
        <span>Falta o ID do cliente OAuth em <code>firebase-init.js</code>.
        Passo 6 do <code>README.md</code>.</span>
      </div>` : ""}
     ${d.configurada && !conectada ? `
      <div class="aviso">
        <span class="ico">${ICONS.alerta}</span>
        <span>Não conectado. Enquanto estiver assim, <strong>nada</strong> é lançado
        na sua agenda, e o app não tem como avisar disso sozinho.</span>
      </div>` : ""}
     ${d.ultimoErro ? `
      <div class="aviso">
        <span class="ico">${ICONS.alerta}</span>
        <span>
          <strong>${d.ultimoErro.origem === "firestore"
            ? "As regras do Firestore recusaram a gravação."
            : d.ultimoErro.origem === "calendar"
              ? "O Google Agenda recusou a chamada."
              : "A sincronização falhou."}</strong>
          ${d.ultimoErro.origem === "firestore" ? `
            <br>Quem recusa isso são as <code>firestore.rules</code>, não o Google.
            O evento é criado e o app não consegue guardar o id dele.
            Republicar as regras do repositório no console do Firebase resolve
            (passo 4 do README).` : ""}
          ${d.ultimoErro.desfeito ? `<br>O evento criado nessa tentativa foi apagado, pra não sobrar duplicata.` : ""}
          <br><br>Em ${esc(new Date(d.ultimoErro.quando).toLocaleString("pt-BR"))}:
          <br><code style="font-size:11.5px; word-break:break-all;">${esc(String(d.ultimoErro.mensagem).slice(0, 220))}</code>
        </span>
      </div>` : ""}
     ${conectada && !faltando && !d.ultimoErro ? `
      <div class="aviso info">
        <span class="ico">${ICONS.info}</span>
        <span>Tudo que devia estar na agenda está.</span>
      </div>` : ""}

     <div class="dado-linha"><span class="rot">Situação</span><span class="val">${
       d.conectada ? "conectado" : d.autorizada ? "autorizado, reconecta quando precisar" : "não conectado"
     }</span></div>
     ${linha("Rotinas com evento recorrente", rotOk, ativas.length)}
     ${linha("Tarefas avulsas de hoje em diante", avulsasOk, avulsas.length)}
     ${linha("Atrasadas com cobrança diária", atrasadasOk, atrasadas.length)}
     <div class="dado-linha">
       <span class="rot">Última sincronização</span>
       <span class="val num">${d.ultimaSinc ? esc(new Date(d.ultimaSinc).toLocaleTimeString("pt-BR")) : "nunca nesta sessão"}</span>
     </div>
     ${conectada ? `<button type="button" class="btn danger bloco" id="a-desconectar" style="margin-top:14px;">Desconectar do Google Agenda</button>` : ""}

     <div class="aviso info" style="margin-top:14px;">
       <span class="ico">${ICONS.info}</span>
       <span><strong>Rotina</strong> vira um evento semanal que notifica pra sempre,
       mesmo com o app fechado.<br>
       <strong>Tarefa avulsa</strong> vira um evento no horário dela. Concluir não
       apaga esse evento, porque ele é registro do que aconteceu; descartar apaga.<br>
       <strong>Atrasada</strong> vira uma série diária de 14 dias no horário original,
       e essa para de cobrar quando você conclui ou descarta.<br><br>
       O que depende de você abrir o app: uma tarefa que vence num dia em que você
       nunca abriu ganha a cobrança só na próxima abertura.</span>
     </div>`,
    `${conectada ? `<button type="button" class="btn" id="a-limpar">Procurar duplicatas</button>` : `<span></span>`}
     <button type="button" class="btn primary" id="a-sinc">${conectada ? "Sincronizar agora" : "Conectar"}</button>`
  );

  $("a-limpar")?.addEventListener("click", modalOrfaos);

  $("a-desconectar")?.addEventListener("click", () => {
    desconectarAgenda();
    fecharModal();
    toast("Google Agenda desconectado. Os eventos já criados continuam lá.", "info", 7000);
  });

  $("a-sinc").addEventListener("click", async () => {
    fecharModal();
    if (!conectada && !(await conectarAgenda())) return;
    await sincronizarAgenda({
      rotinas: STATE.rotinas, tarefas: STATE.tarefas, nomeCategoria, silencioso: false,
    });
  });
}

/*
  Varredura de evento órfão na agenda.

  Apagar da agenda de alguém é destrutivo, irreversível e aparece pra quem
  compartilha o calendário. Então a função nunca apaga sozinha: ela lista,
  mostra título e data de cada um, e só apaga depois de ele confirmar.
*/
async function modalOrfaos() {
  fecharModal();
  toast("Procurando na sua agenda…", "info", 3000);

  let orfaos;
  try {
    orfaos = await procurarEventosOrfaos({ rotinas: STATE.rotinas, tarefas: STATE.tarefas });
  } catch (err) {
    return toast(err.message || "Não foi possível procurar.", "erro", 8000);
  }

  if (!orfaos.length) {
    return abrirModal("Duplicatas na agenda",
      `<div class="aviso info">
         <span class="ico">${ICONS.info}</span>
         <span>Nenhum evento solto. Tudo que o app criou na sua agenda nos
         últimos 120 dias está sendo gerenciado por ele.</span>
       </div>`);
  }

  abrirModal("Duplicatas na agenda",
    `<div class="aviso">
       <span class="ico">${ICONS.alerta}</span>
       <span>Encontrei <strong>${orfaos.length}</strong> evento(s) que este app
       criou e não consegue mais gerenciar: nenhuma rotina ou tarefa aponta pra
       eles, então nunca vão ser atualizados nem apagados sozinhos. Quase sempre
       são duplicatas de uma gravação que falhou.</span>
     </div>
     <div class="aviso info">
       <span class="ico">${ICONS.info}</span>
       <span>Confira a lista antes. Apagar evento da agenda não tem como desfazer.</span>
     </div>
     <div class="table-wrap">
       <table>
         <thead><tr><th>Evento</th><th>Quando</th><th>Tipo</th></tr></thead>
         <tbody>
           ${orfaos.map((o) => `
             <tr>
               <td class="larga">${esc(o.titulo)}</td>
               <td class="num">${esc(o.quando ? fmtDataHora(o.quando) : "—")}</td>
               <td>${o.recorrente ? `<span class="pill warn">série</span>` : `<span class="pill neutro">único</span>`}</td>
             </tr>`).join("")}
         </tbody>
       </table>
     </div>`,
    `<button type="button" class="btn" data-fechar-modal>Deixar como está</button>
     <button type="button" class="btn danger" id="o-apagar">Apagar os ${orfaos.length}</button>`
  );

  $("o-apagar").addEventListener("click", async () => {
    fecharModal();
    const ok = await confirmar(
      `Apagar ${orfaos.length} evento(s) da sua Google Agenda? Isso não tem como desfazer.`,
      { textoConfirmar: `Apagar ${orfaos.length}` }
    );
    if (!ok) return;
    toast("Apagando…", "info", 3000);
    const { apagados, falhas } = await apagarOrfaos(orfaos.map((o) => o.id));
    toast(
      falhas ? `${apagados} apagado(s), ${falhas} falharam.` : `${apagados} evento(s) apagado(s) da agenda.`,
      falhas ? "erro" : "sucesso", 8000
    );
  });
}

function modalSobre() {
  /*
    A linha "Sessão salva em" existe por causa de um relato real (2026-09-17):
    o Felipe reportou que o F5 pedia login de novo, no celular e no
    notebook. Sem visibilidade nenhuma sobre qual mecanismo de persistência
    o navegador aceitou, o único jeito de investigar seria adivinhar. Agora
    fica registrado aqui: "IndexedDB" é o normal e sobrevive fechar o
    navegador; "localStorage" e "somente esta aba" são os degraus de
    fallback, e "somente esta aba" quer dizer que o navegador (ou uma
    extensão) está bloqueando armazenamento persistente — nesse caso um F5
    comum não desloga, mas fechar a aba desloga.
  */
  const persistencia = {
    indexedDB: "IndexedDB (sobrevive fechar o navegador)",
    localStorage: "localStorage (sobrevive fechar o navegador)",
    sessao: "somente esta aba (o navegador está bloqueando armazenamento persistente)",
  }[DIAGNOSTICO_SESSAO.persistenciaAlvo] || DIAGNOSTICO_SESSAO.persistenciaAlvo;

  abrirModal("Sobre o AppRotina",
    `<div class="dado-linha"><span class="rot">Versão</span><span class="val num">1</span></div>
     <div class="dado-linha"><span class="rot">Janela do histórico</span><span class="val num">${DIAS_JANELA} dias</span></div>
     <div class="dado-linha"><span class="rot">Recuperação de lançamento</span><span class="val num">${MAX_RECUPERACAO} dias</span></div>
     <div class="dado-linha"><span class="rot">Último lançamento</span><span class="val num">${esc(STATE.hoje)}</span></div>
     <div class="dado-linha"><span class="rot">Sessão salva em</span><span class="val">${esc(persistencia)}</span></div>
     ${DIAGNOSTICO_SESSAO.persistenciaAlvo === "sessao" ? `
     <div class="aviso" style="margin-top:8px;">
       <span class="ico">${ICONS.alerta}</span>
       <span>Este navegador não está guardando sua sessão de forma persistente.
       Confira se há navegação privada, ou uma extensão bloqueando cookies/
       armazenamento de terceiros, ativa.</span>
     </div>` : ""}
     <div class="aviso info" style="margin-top:14px;">
       <span class="ico">${ICONS.info}</span>
       <span>O painel e o histórico olham no máximo ${DIAS_JANELA} dias pra trás,
       de propósito: escutar a coleção inteira estouraria a cota diária gratuita do
       Firestore conforme a base cresce. Tarefa pendente de qualquer idade continua
       aparecendo no checklist, sem esse limite.</span>
     </div>`
  );
}

/* ─────────────────────────── eventos ─────────────────────────── */

function ligarEventos() {
  $("btn-nova-tarefa").addEventListener("click", () => modalTarefa());
  $("btn-nova-rotina").addEventListener("click", () => modalRotina());
  $("btn-lancar-semana").addEventListener("click", () => lancarProximosDias(7));
  $("btn-editar-perfil").addEventListener("click", modalPerfil);

  $("btn-menu-perfil").addEventListener("click", abrirDrawer);
  $("btn-fechar-drawer").addEventListener("click", fecharDrawer);
  $("drawer-backdrop").addEventListener("click", fecharDrawer);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && $("drawer-config").classList.contains("open")) fecharDrawer();
  });

  $("cfg-categorias").addEventListener("click", () => { fecharDrawer(); modalCategorias(); });
  $("cfg-agenda").addEventListener("click", () => { fecharDrawer(); modalAgenda(); });
  $("cfg-sobre").addEventListener("click", () => { fecharDrawer(); modalSobre(); });
  $("cfg-sair").addEventListener("click", async () => {
    fecharDrawer();
    if (await confirmar("Sair da sua conta?", { textoConfirmar: "Sair", perigo: false })) await sair();
  });

  $("seg-periodo").querySelectorAll("[data-dias]").forEach((b) => {
    b.addEventListener("click", () => {
      STATE.periodoDias = Number(b.dataset.dias);
      $("seg-periodo").querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === b));
      renderPainel();
    });
  });

  $("hist-filtro-cat").addEventListener("change", (e) => {
    STATE.histFiltroCat = e.target.value;
    STATE.histLimite = 25;
    renderPainel();
  });

  $("hist-mais").addEventListener("click", () => {
    STATE.histLimite += 25;
    renderPainel();
  });
}

/* ─────────────────── sincronização com a agenda ─────────────────── */

let timerSinc = null;
/** Junta várias mudanças seguidas numa chamada só, pra não gastar cota. */
function agendarSincronizacao() {
  clearTimeout(timerSinc);
  timerSinc = setTimeout(() => {
    sincronizarAgenda({
      rotinas: STATE.rotinas, tarefas: STATE.tarefas, nomeCategoria, silencioso: true,
    });
  }, 2500);
}
