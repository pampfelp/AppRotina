/*
  agenda.js — ligação com o Google Agenda.

  DECISÃO DE ARQUITETURA (2026-09-17, Felipe). O Felipe perguntou se o
  Firebase não resolvia isso sem Apps Script. Resolve, mas por Cloud
  Functions + Cloud Scheduler, que exigem o plano Blaze com cartão
  cadastrado — a mesma parede do Firebase Storage que parou a foto do Track
  Bravos do Norte em 2026-09-10 (antecipacao.md E1) — e ainda pedem pasta
  functions/ com package.json, o que contraria a crença 4 (sem build step).

  O caminho escolhido não precisa de servidor nenhum, porque a repetição
  quem faz é o próprio Google Agenda:

  1. Cada rotina ativa vira UM evento recorrente semanal
     (RRULE FREQ=WEEKLY;BYDAY=...). Criado uma vez, notifica pra sempre, com
     o app fechado.
  2. Cada tarefa AVULSA de hoje em diante vira UM evento no horário dela. As
     tarefas vindas de rotina não ganham evento próprio, porque o recorrente
     do item 1 já cobre o horário delas; criar os dois duplicaria a
     notificação.
  3. Cada tarefa atrasada e ainda pendente vira UMA série diária de 14 dias no
     horário original em que ela deveria ter sido feita. O Agenda cobra todo
     dia naquela hora até ele concluir ou descartar, e aí o app apaga a série.

  DIFERENÇA ENTRE OS DOIS TIPOS DE EVENTO, que decide o que é apagado:
  o evento do item 2 é REGISTRO de um compromisso, então concluir a tarefa
  não o apaga (a reunião aconteceu, e a agenda dele é lida por outras
  pessoas). A série do item 3 é COBRANÇA, então concluir ou descartar apaga.
  Descartar apaga os dois, porque descartar significa que o compromisso
  deixou de existir.

  CORRIGIDO EM 2026-09-17, depois de ele reportar "ao criar rotinas diárias
  ele não está ocupando minha agenda, somente um funcionou". Duas causas na
  mesma linha: o item 2 não existia (tarefa avulsa nunca chegava na agenda),
  e a condição de atraso lia `tf.concluida`/`tf.descartada`, campos que
  deixaram de existir quando o modelo passou a usar um campo `estado` só.
  Negar `undefined` dá `true`, então a condição virou só a data: atrasada já
  concluída ganhava cobrança, e concluir uma atrasada não apagava a
  cobrança, quebrando a promessa escrita no README e na tela. Os outros 20
  lugares que leem esse campo, todos no app.js, estavam certos — o único
  errado era o que fala com a agenda, que é justamente o que falha calado
  (crença 14 e crença 22).

  O furo conhecido, dito na cara: uma tarefa que vence num dia em que ele
  nunca abre o app só ganha a série de cobrança quando ele abrir. As rotinas
  continuam notificando nesses dias, porque o recorrente não depende do app.

  Sobre a API (antecipacao.md E3 — nunca presumir schema de terceiro): os
  campos usados aqui são os da referência Events do Calendar API v3
  (summary, description, start/end com dateTime + timeZone, recurrence com
  RRULE, reminders.overrides). Valor que muda de comportamento: sem
  reminders.useDefault=false, o evento herda o lembrete padrão da agenda
  dele, que pode ser nenhum.
*/

import { db } from "./firebase-init.js";
import { GOOGLE_CLIENT_ID } from "./firebase-init.js";
import { doc, updateDoc } from "https://www.gstatic.com/firebasejs/12.16.0/firebase-firestore.js";
import { toast, parseDataLocal, hojeISO, somarDiasISO, isoLocal, horaEmMinutos } from "./shared.js";

const API = "https://www.googleapis.com/calendar/v3/calendars/primary/events";
const ESCOPO = "https://www.googleapis.com/auth/calendar.events";
const CHAVE_CONECTADO = "rot_agenda_conectada";
const DIAS_COBRANCA = 14;      // tamanho da série diária de atrasada
const MAX_OPS_POR_RODADA = 25; // teto por sincronização, pra não travar a tela

const BYDAY = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];
const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone || "America/Sao_Paulo";

let tokenClient = null;
let token = null;        // { valor, expiraEm }
let gisPronto = false;
let sincronizando = false;
const ouvintes = new Set();

/*
  Sem isto a sincronização silenciosa falhava sem deixar rastro na tela, e a
  única forma de descobrir era abrir o Google Agenda e comparar item por
  item. Agora o app.js lê daqui e mostra.
*/
let avisouTokenNaSessao = false;
let avisouErroNaSessao = false;
const DIAG = { ultimoErro: null, ultimaSinc: null, ultimasOps: 0, faltouToken: false };
export function diagnosticoAgenda() {
  return { ...DIAG, configurada: agendaConfigurada(), conectada: agendaConectada(), autorizada: agendaJaAutorizada() };
}

export function aoMudarAgenda(fn) { ouvintes.add(fn); }
function avisar() { ouvintes.forEach((f) => { try { f(); } catch (_) {} }); }

export function agendaConfigurada() {
  return !String(GOOGLE_CLIENT_ID).includes("COLE_AQUI");
}

export function agendaConectada() {
  return !!token && token.expiraEm > Date.now() + 30000;
}

export function agendaJaAutorizada() {
  return localStorage.getItem(CHAVE_CONECTADO) === "1";
}

/* ───────────────────────── token ───────────────────────── */

function carregarGIS() {
  if (gisPronto) return Promise.resolve(true);
  return new Promise((resolve) => {
    if (window.google?.accounts?.oauth2) { gisPronto = true; return resolve(true); }
    const s = document.createElement("script");
    s.src = "https://accounts.google.com/gsi/client";
    s.async = true;
    s.onload = () => { gisPronto = true; resolve(true); };
    s.onerror = () => resolve(false);
    document.head.appendChild(s);
  });
}

async function montarTokenClient() {
  if (tokenClient) return tokenClient;
  if (!agendaConfigurada()) return null;
  if (!(await carregarGIS())) return null;
  tokenClient = window.google.accounts.oauth2.initTokenClient({
    client_id: GOOGLE_CLIENT_ID,
    scope: ESCOPO,
    callback: () => {}, // trocado a cada pedido
  });
  return tokenClient;
}

/**
 * Pede o token. `silencioso` tenta sem mostrar nada (só funciona se ele já
 * autorizou antes e a sessão Google está viva no navegador).
 */
function pedirToken({ silencioso }) {
  return new Promise(async (resolve) => {
    const cliente = await montarTokenClient();
    if (!cliente) return resolve(null);
    cliente.callback = (resp) => {
      if (resp?.access_token) {
        token = { valor: resp.access_token, expiraEm: Date.now() + (Number(resp.expires_in || 3600) - 60) * 1000 };
        localStorage.setItem(CHAVE_CONECTADO, "1");
        avisar();
        return resolve(token.valor);
      }
      resolve(null);
    };
    try {
      cliente.requestAccessToken(silencioso ? { prompt: "" } : { prompt: "consent" });
    } catch (_) {
      resolve(null);
    }
  });
}

/** Devolve um token válido, ou null. Nunca abre janela por conta própria. */
async function garantirToken() {
  if (agendaConectada()) return token.valor;
  if (!agendaJaAutorizada()) return null;
  return await pedirToken({ silencioso: true });
}

/** Chamado pelo botão "Conectar" nas Configurações. Pode abrir janela. */
export async function conectarAgenda() {
  if (!agendaConfigurada()) {
    toast("Falta o ID do cliente OAuth. Ver passo 6 do README.", "erro", 8000);
    return false;
  }
  const t = await pedirToken({ silencioso: false });
  if (!t) { toast("Não foi possível autorizar o Google Agenda.", "erro"); return false; }
  toast("Google Agenda conectado.", "sucesso");
  return true;
}

export function desconectarAgenda() {
  try { if (token?.valor) window.google?.accounts?.oauth2?.revoke(token.valor, () => {}); } catch (_) {}
  token = null;
  localStorage.removeItem(CHAVE_CONECTADO);
  avisar();
}

/* ───────────────────────── chamadas da API ───────────────────────── */

async function chamar(metodo, caminho, corpo) {
  const t = await garantirToken();
  if (!t) throw new Error("sem-token");
  const res = await fetch(`${API}${caminho}`, {
    method: metodo,
    headers: { Authorization: `Bearer ${t}`, "Content-Type": "application/json" },
    body: corpo ? JSON.stringify(corpo) : undefined,
  });
  if (res.status === 401) { token = null; throw new Error("token-expirado"); }
  if (res.status === 404 || res.status === 410) return { ausente: true };
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`calendar ${res.status}: ${txt.slice(0, 180)}`);
  }
  if (res.status === 204) return {};
  return await res.json();
}

const criarEvento = (ev) => chamar("POST", "", ev);
const atualizarEvento = (id, ev) => chamar("PUT", `/${encodeURIComponent(id)}`, ev);
const apagarEvento = (id) => chamar("DELETE", `/${encodeURIComponent(id)}`);

/* ───────────────────────── montagem dos eventos ───────────────────────── */

function iso(dataISO, hora, somarMin = 0) {
  const d = parseDataLocal(dataISO);
  const [h, m] = String(hora || "08:00").split(":").map(Number);
  d.setHours(h || 0, (m || 0) + somarMin, 0, 0);
  // dateTime sem offset + timeZone explícito: o Google resolve no fuso dado
  return `${isoLocal(d)}T${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:00`;
}

/** Primeira data >= hoje cujo dia da semana está em `dias`. */
function primeiraOcorrencia(dias) {
  const hoje = hojeISO();
  for (let i = 0; i < 7; i++) {
    const cand = somarDiasISO(hoje, i);
    if (dias.includes(parseDataLocal(cand).getDay())) return cand;
  }
  return hoje;
}

/**
 * Atividades que a rotina realmente lança. Sem nenhuma cadastrada, a rotina
 * é a própria atividade — usa a categoria dela mesma (crença nova,
 * 2026-09-18: "criar uma rotina, automaticamente ela é a própria
 * atividade"). Espelha app.js#atividadesEfetivas.
 */
function atividadesEfetivas(rotina) {
  if ((rotina.atividades || []).length) return rotina.atividades;
  return [{ id: "self", titulo: "", categoriaId: rotina.categoriaId || "" }];
}

function eventoDaRotina(rotina, nomeCategoria) {
  const dias = [...(rotina.diasSemana || [])].sort();
  const inicio = primeiraOcorrencia(dias);
  const dur = Number(rotina.duracaoMin) || 30;
  /*
    O título da atividade virou opcional (só a categoria é obrigatória), então
    uma atividade sem título geraria uma linha "• " vazia na descrição do
    evento. Quando falta o título, a categoria é o que descreve a linha.
  */
  const lista = atividadesEfetivas(rotina)
    .map((a) => {
      const cat = nomeCategoria(a.categoriaId);
      if (a.titulo && cat) return `• ${a.titulo} (${cat})`;
      return a.titulo || cat ? `• ${a.titulo || cat}` : "";
    })
    .filter(Boolean);
  return {
    summary: rotina.nome,
    description: [lista.join("\n"), "", "Lançado pelo AppRotina."].filter(Boolean).join("\n"),
    start: { dateTime: iso(inicio, rotina.hora), timeZone: TZ },
    end: { dateTime: iso(inicio, rotina.hora, dur), timeZone: TZ },
    recurrence: [`RRULE:FREQ=WEEKLY;BYDAY=${dias.map((d) => BYDAY[d]).join(",")}`],
    reminders: { useDefault: false, overrides: [{ method: "popup", minutes: 0 }, { method: "popup", minutes: 10 }] },
  };
}

function eventoDeAtraso(tarefa, nomeCategoria) {
  /*
    Começa hoje se a hora original ainda não passou; senão amanhã, senão o
    primeiro lembrete nasceria no passado e não notificaria nada.
  */
  const agoraMin = new Date().getHours() * 60 + new Date().getMinutes();
  const hoje = hojeISO();
  const inicio = horaEmMinutos(tarefa.hora) > agoraMin + 2 ? hoje : somarDiasISO(hoje, 1);
  const cat = nomeCategoria(tarefa.categoriaId);
  return {
    evento: {
      summary: `Atrasada · ${tarefa.titulo}`,
      description: [
        `Era pra ter sido feita em ${parseDataLocal(tarefa.data).toLocaleDateString("pt-BR")} às ${tarefa.hora || "--:--"}.`,
        cat ? `Categoria: ${cat}` : "",
        "",
        "A cobrança para quando você concluir ou descartar no AppRotina.",
      ].filter(Boolean).join("\n"),
      start: { dateTime: iso(inicio, tarefa.hora), timeZone: TZ },
      end: { dateTime: iso(inicio, tarefa.hora, 15), timeZone: TZ },
      recurrence: [`RRULE:FREQ=DAILY;COUNT=${DIAS_COBRANCA}`],
      reminders: { useDefault: false, overrides: [{ method: "popup", minutes: 0 }] },
    },
    cobreAte: somarDiasISO(inicio, DIAS_COBRANCA - 1),
  };
}

/**
 * Assinatura do conteúdo que o evento reflete. Se mudar, o evento é
 * reescrito; se não mudar, nenhuma chamada é feita. É o que impede a
 * sincronização de gastar cota reescrevendo tudo a cada abertura.
 */
function eventoDaTarefa(tarefa, nomeCategoria) {
  const dur = Number(tarefa.duracaoMin) || 30;
  const cat = nomeCategoria(tarefa.categoriaId);
  return {
    summary: tarefa.titulo,
    description: [cat ? `Categoria: ${cat}` : "", "Lançado pelo AppRotina."].filter(Boolean).join("\n"),
    start: { dateTime: iso(tarefa.data, tarefa.hora), timeZone: TZ },
    end: { dateTime: iso(tarefa.data, tarefa.hora, dur), timeZone: TZ },
    reminders: { useDefault: false, overrides: [{ method: "popup", minutes: 0 }, { method: "popup", minutes: 10 }] },
  };
}

function assinaturaTarefa(t) {
  return JSON.stringify([t.titulo, t.data, t.hora, t.duracaoMin || 30, t.categoriaId || ""]);
}

function assinaturaRotina(r) {
  return JSON.stringify([
    r.nome, r.hora, r.duracaoMin || 30, [...(r.diasSemana || [])].sort(),
    atividadesEfetivas(r).map((a) => [a.titulo, a.categoriaId]),
  ]);
}

/* ───────────────────────── sincronização ───────────────────────── */

/**
 * Compara o que está no Firestore com o que já foi pro Agenda e manda só a
 * diferença. Idempotente: rodar duas vezes seguidas não cria nada a mais.
 */
export async function sincronizarAgenda({ rotinas, tarefas, nomeCategoria, silencioso = true }) {
  if (sincronizando) return;
  if (!agendaConfigurada()) return;
  const t = await garantirToken();
  if (!t) {
    DIAG.faltouToken = true;
    if (!silencioso) {
      toast("Google Agenda não está conectado.", "erro");
    } else if (!avisouTokenNaSessao) {
      // Avisa UMA vez por sessão. Sem isso a sincronização falhava calada e
      // a única forma de descobrir era comparar com o Google Agenda na mão.
      avisouTokenNaSessao = true;
      toast("O Google Agenda não está conectado, nada está sendo lançado lá. Perfil › Configurações › Google Agenda.", "erro", 9000);
    }
    avisar();
    return;
  }
  DIAG.faltouToken = false;

  sincronizando = true;
  const hoje = hojeISO();
  let ops = 0, erros = 0;

  let tetoBatido = false;
  const passo = async (fn) => {
    if (ops >= MAX_OPS_POR_RODADA) { tetoBatido = true; return false; }
    ops++;
    try { await fn(); } catch (err) {
      erros++;
      DIAG.ultimoErro = { mensagem: err.message || String(err), quando: Date.now() };
      console.error("[agenda]", err);
      if (/sem-token|token-expirado/.test(String(err.message))) {
        ops = MAX_OPS_POR_RODADA; // para a rodada, tenta de novo depois
        tetoBatido = true;
      }
    }
    return true;
  };

  try {
    /* ── 1. rotinas ── */
    for (const r of rotinas) {
      const ref = doc(db, "rotinas", r.id);

      // rotina sem atividade cadastrada não é mais "sem conteúdo": ela é a
      // própria atividade agora, então só sai da agenda se estiver pausada
      // ou sem nenhum dia da semana marcado
      if (!r.ativa || !(r.diasSemana || []).length) {
        if (r.agendaEventoId) {
          await passo(async () => {
            await apagarEvento(r.agendaEventoId);
            await updateDoc(ref, { agendaEventoId: null, agendaHash: null });
          });
        }
        continue;
      }

      const hash = assinaturaRotina(r);
      if (r.agendaEventoId && r.agendaHash === hash) continue;

      await passo(async () => {
        const ev = eventoDaRotina(r, nomeCategoria);
        if (r.agendaEventoId) {
          const resp = await atualizarEvento(r.agendaEventoId, ev);
          if (resp.ausente) {
            const novo = await criarEvento(ev);
            await updateDoc(ref, { agendaEventoId: novo.id, agendaHash: hash });
          } else {
            await updateDoc(ref, { agendaHash: hash });
          }
        } else {
          const novo = await criarEvento(ev);
          await updateDoc(ref, { agendaEventoId: novo.id, agendaHash: hash });
        }
      });
    }

    /* ── 2. evento do compromisso, só pra tarefa avulsa ──
       Tarefa vinda de rotina não entra aqui: o recorrente do passo 1 já
       cobre o horário dela, e criar os dois duplicaria a notificação.
       Só de hoje em diante, pra não escrever histórico na agenda dele. */
    for (const tf of tarefas) {
      if (tf.origem !== "manual") continue;
      const ref = doc(db, "tarefas", tf.id);

      // descartada: o compromisso deixou de existir, sai da agenda.
      // concluída NÃO apaga, porque o evento é registro do que aconteceu.
      if (tf.estado === "descartada") {
        if (tf.agendaEventoId) {
          await passo(async () => {
            await apagarEvento(tf.agendaEventoId);
            await updateDoc(ref, { agendaEventoId: null, agendaHash: null });
          });
        }
        continue;
      }

      if (tf.data < hoje && !tf.agendaEventoId) continue; // passado nunca sincronizado

      const hash = assinaturaTarefa(tf);
      if (tf.agendaEventoId && tf.agendaHash === hash) continue;

      await passo(async () => {
        const ev = eventoDaTarefa(tf, nomeCategoria);
        if (tf.agendaEventoId) {
          const resp = await atualizarEvento(tf.agendaEventoId, ev);
          if (resp.ausente) {
            const novoEv = await criarEvento(ev);
            if (novoEv?.id) await updateDoc(ref, { agendaEventoId: novoEv.id, agendaHash: hash });
          } else {
            await updateDoc(ref, { agendaHash: hash });
          }
        } else {
          const novoEv = await criarEvento(ev);
          if (novoEv?.id) await updateDoc(ref, { agendaEventoId: novoEv.id, agendaHash: hash });
        }
      });
    }

    /* ── 3. cobrança diária das atrasadas ──
       `estado` é o campo real do modelo. A versão anterior lia
       tf.concluida/tf.descartada, que nunca existiram: negar undefined dá
       true, a condição virava só a data, atrasada já concluída ganhava
       cobrança e concluir não apagava nada. */
    for (const tf of tarefas) {
      const ref = doc(db, "tarefas", tf.id);
      const atrasada = tf.estado === "pendente" && tf.data < hoje;

      if (!atrasada) {
        if (tf.agendaAtrasoId) {
          await passo(async () => {
            await apagarEvento(tf.agendaAtrasoId);
            await updateDoc(ref, { agendaAtrasoId: null, agendaAtrasoAte: null });
          });
        }
        continue;
      }

      // série ainda cobrindo os próximos dias: nada a fazer
      if (tf.agendaAtrasoId && tf.agendaAtrasoAte && tf.agendaAtrasoAte >= hoje) continue;

      await passo(async () => {
        if (tf.agendaAtrasoId) await apagarEvento(tf.agendaAtrasoId);
        const { evento, cobreAte } = eventoDeAtraso(tf, nomeCategoria);
        const novoEv = await criarEvento(evento);
        if (novoEv?.id) await updateDoc(ref, { agendaAtrasoId: novoEv.id, agendaAtrasoAte: cobreAte });
      });
    }

    DIAG.ultimaSinc = Date.now();
    DIAG.ultimasOps = ops;
    if (!erros) DIAG.ultimoErro = null;

    if (!silencioso) {
      if (erros) toast(`A agenda recusou ${erros} evento(s). O motivo está em Configurações › Google Agenda.`, "erro", 9000);
      else if (ops) toast(`Agenda atualizada (${ops} evento${ops > 1 ? "s" : ""}).`, "sucesso");
      else toast("Agenda já estava em dia.", "info");
    } else if (erros && !avisouErroNaSessao) {
      avisouErroNaSessao = true;
      toast("Algo não foi pro Google Agenda. Veja Perfil › Configurações › Google Agenda.", "erro", 9000);
    }
  } finally {
    sincronizando = false;
    avisar();
    // Teto por rodada existe pra não travar a tela. Se ele bateu, ainda há
    // fila: em vez de esperar a próxima mudança, continua sozinho.
    if (tetoBatido && !DIAG.faltouToken) {
      setTimeout(() => sincronizarAgenda({ rotinas, tarefas, nomeCategoria, silencioso: true }), 4000);
    }
  }
}

/**
 * Apaga na hora os eventos de uma tarefa ou rotina que acabou de sair.
 * Chamado na exclusão, onde não dá pra esperar a próxima sincronização
 * porque o documento não vai mais existir pra ser comparado.
 */
export async function apagarEventosDe({ agendaEventoId, agendaAtrasoId }) {
  if (!agendaConfigurada()) return;
  const t = await garantirToken();
  if (!t) return;
  for (const id of [agendaEventoId, agendaAtrasoId].filter(Boolean)) {
    try { await apagarEvento(id); } catch (err) { console.error("[agenda]", err); }
  }
}
