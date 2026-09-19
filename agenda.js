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

import { db } from "./firebase-init.js?v=11";
import { GOOGLE_CLIENT_ID } from "./firebase-init.js?v=11";
import { doc, updateDoc } from "https://www.gstatic.com/firebasejs/12.16.0/firebase-firestore.js";
import { toast, parseDataLocal, hojeISO, somarDiasISO, isoLocal, horaEmMinutos } from "./shared.js?v=11";

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
    toast("A conexão com o Google Agenda está indisponível no momento.", "erro", 8000);
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
    const e = new Error(`Google Agenda ${res.status}: ${txt.slice(0, 180)}`);
    e.origem = "calendar";
    throw e;
  }
  if (res.status === 204) return {};
  return await res.json();
}

const criarEvento = (ev) => chamar("POST", "", ev);

/*
  Grava no Firestore marcando de onde veio o erro. Sem isso a mensagem
  culpava o lado errado: em 2026-09-17 a tela dizia "a agenda recusou 2
  evento(s)" quando quem recusou foi o Firestore ("Missing or insufficient
  permissions"), e o Felipe foi procurar o problema no OAuth do Google em vez
  de nas firestore.rules.
*/
async function gravar(ref, dados) {
  try {
    await updateDoc(ref, dados);
  } catch (err) {
    const e = new Error(`Firestore: ${err?.message || err}`);
    e.origem = "firestore";
    e.code = err?.code;
    throw e;
  }
}

/*
  Cria o evento e registra o id. Se o registro falhar, APAGA o evento que
  acabou de nascer.

  Por que isso é obrigatório: sem o id gravado, a próxima sincronização acha
  que a rotina não tem evento e cria outro, e outro, uma duplicata por
  abertura do app. Foi o que aconteceu em 2026-09-17, quando as regras
  publicadas recusaram a gravação e o evento continuou sendo criado. Efeito
  externo que eu não consigo registrar tem que ser desfeito, não deixado
  para trás.
*/
async function criarERegistrar(ref, ev, camposDoId) {
  const novo = await criarEvento(ev);
  if (!novo?.id) {
    const e = new Error("Google Agenda: criação não devolveu id");
    e.origem = "calendar";
    throw e;
  }
  try {
    await gravar(ref, camposDoId(novo.id));
  } catch (err) {
    await apagarEvento(novo.id).catch(() => {});
    err.desfeito = true;
    throw err;
  }
}
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
export async function sincronizarAgenda({ rotinas, tarefas, nomeCategoria, email, silencioso = true }) {
  // cada pessoa grava no próprio espaço (usuarios/{email}/...); sem isso, a
  // volta do id do evento cairia na conta errada
  const dono = String(email || "").toLowerCase();
  if (!dono) return; // sem dono não há espaço pra gravar o id do evento
  const docDoDono = (colecao, id) => doc(db, "usuarios", dono, colecao, id);
  if (sincronizando) return;
  if (!agendaConfigurada()) return;

  /*
    CORRIGIDO EM 2026-09-18. A sincronização AUTOMÁTICA (silencioso:true —
    disparada 2,5s depois de criar/editar tarefa, ou ao abrir o app) nunca
    tenta arrumar token sozinha. Só usa o que já está vivo na memória desta
    aba (uma conexão feita nesta mesma sessão, ainda dentro da hora).

    Por quê: pedirToken({silencioso:true}) deveria falhar calado quando não
    consegue renovar sem interação (`prompt:''` é documentado assim pelo
    Google), mas na prática, com cookie de terceiro bloqueado — o padrão no
    Safari, e cada vez mais comum no Chrome — o GIS às vezes mostra a tela
    de escolher conta mesmo com prompt vazio, contrariando a própria
    documentação. E como `token` é variável em memória, ela reseta a cada
    F5: a tentativa de renovar rodava de novo em TODA abertura fresca do
    app, não só de hora em hora. Ele reportou (2026-09-18): "sempre que eu
    crio uma atividade avulsa ele diz enviado pro Google Agenda, daí pede
    pra logar de novo" — batia exatamente com isso.

    Sem tentar renovar, a automática ou aproveita um token já vivo (grátis,
    sem risco) ou desiste na hora, sem popup nenhum. O que fecha a lacuna é
    o gatilho do Apps Script (apps-script/, a cada 15 min, sem navegador,
    sem popup — mesmo caminho que a Jornada do Milhão já usa) e o clique
    de propósito em "Sincronizar agora", que continua podendo pedir login.
  */
  const t = silencioso ? (agendaConectada() ? token.valor : null) : await garantirToken();
  if (!t) {
    DIAG.faltouToken = true;
    if (!silencioso) {
      toast("Google Agenda não está conectado.", "erro");
    } else if (!avisouTokenNaSessao) {
      // Avisa UMA vez por sessão. Sem isso a sincronização falhava calada e
      // a única forma de descobrir era comparar com o Google Agenda na mão.
      avisouTokenNaSessao = true;
      toast("Suas mudanças ainda não foram pro Google Agenda. Abra Perfil › Configurações › Google Agenda › Sincronizar agora.", "info", 9000);
    }
    avisar();
    return;
  }
  DIAG.faltouToken = false;

  sincronizando = true;
  const hoje = hojeISO();
  let ops = 0, erros = 0;
  const porOrigem = { calendar: 0, firestore: 0, outro: 0 };

  let tetoBatido = false;
  const passo = async (fn) => {
    if (ops >= MAX_OPS_POR_RODADA) { tetoBatido = true; return false; }
    ops++;
    try { await fn(); } catch (err) {
      erros++;
      porOrigem[err.origem || "outro"]++;
      DIAG.ultimoErro = {
        mensagem: err.message || String(err),
        origem: err.origem || "outro",
        desfeito: !!err.desfeito,
        quando: Date.now(),
      };
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
      const ref = docDoDono("rotinas", r.id);

      // rotina sem atividade cadastrada não é mais "sem conteúdo": ela é a
      // própria atividade agora, então só sai da agenda se estiver pausada
      // ou sem nenhum dia da semana marcado
      if (!r.ativa || !(r.diasSemana || []).length) {
        if (r.agendaEventoId) {
          await passo(async () => {
            await apagarEvento(r.agendaEventoId);
            await gravar(ref, { agendaEventoId: null, agendaHash: null });
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
            await criarERegistrar(ref, ev, (id) => ({ agendaEventoId: id, agendaHash: hash }));
          } else {
            await gravar(ref, { agendaHash: hash });
          }
        } else {
          await criarERegistrar(ref, ev, (id) => ({ agendaEventoId: id, agendaHash: hash }));
        }
      });
    }

    /* ── 2. evento do compromisso, só pra tarefa avulsa ──
       Tarefa vinda de rotina não entra aqui: o recorrente do passo 1 já
       cobre o horário dela, e criar os dois duplicaria a notificação.
       Só de hoje em diante, pra não escrever histórico na agenda dele. */
    for (const tf of tarefas) {
      if (tf.origem !== "manual") continue;
      const ref = docDoDono("tarefas", tf.id);

      // descartada: o compromisso deixou de existir, sai da agenda.
      // concluída NÃO apaga, porque o evento é registro do que aconteceu.
      if (tf.estado === "descartada") {
        if (tf.agendaEventoId) {
          await passo(async () => {
            await apagarEvento(tf.agendaEventoId);
            await gravar(ref, { agendaEventoId: null, agendaHash: null });
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
            await criarERegistrar(ref, ev, (id) => ({ agendaEventoId: id, agendaHash: hash }));
          } else {
            await gravar(ref, { agendaHash: hash });
          }
        } else {
          await criarERegistrar(ref, ev, (id) => ({ agendaEventoId: id, agendaHash: hash }));
        }
      });
    }

    /* ── 3. cobrança diária das atrasadas ──
       `estado` é o campo real do modelo. A versão anterior lia
       tf.concluida/tf.descartada, que nunca existiram: negar undefined dá
       true, a condição virava só a data, atrasada já concluída ganhava
       cobrança e concluir não apagava nada. */
    for (const tf of tarefas) {
      const ref = docDoDono("tarefas", tf.id);
      const atrasada = tf.estado === "pendente" && tf.data < hoje;

      if (!atrasada) {
        if (tf.agendaAtrasoId) {
          await passo(async () => {
            await apagarEvento(tf.agendaAtrasoId);
            await gravar(ref, { agendaAtrasoId: null, agendaAtrasoAte: null });
          });
        }
        continue;
      }

      // série ainda cobrindo os próximos dias: nada a fazer
      if (tf.agendaAtrasoId && tf.agendaAtrasoAte && tf.agendaAtrasoAte >= hoje) continue;

      await passo(async () => {
        if (tf.agendaAtrasoId) await apagarEvento(tf.agendaAtrasoId);
        const { evento, cobreAte } = eventoDeAtraso(tf, nomeCategoria);
        await criarERegistrar(ref, evento, (id) => ({ agendaAtrasoId: id, agendaAtrasoAte: cobreAte }));
      });
    }

    DIAG.ultimaSinc = Date.now();
    DIAG.ultimasOps = ops;
    if (!erros) DIAG.ultimoErro = null;

    /*
      Na tela, o número do que não passou — sem nomear a peça interna que
      recusou, que não muda nada do que o usuário pode fazer. A origem
      continua no console e no diagnóstico (DIAG.ultimoErro.origem), que é
      onde ela serve.
    */
    const culpa = erros === 1
      ? "1 item não foi pro Google Agenda."
      : `${erros} itens não foram pro Google Agenda.`;

    if (!silencioso) {
      if (erros) toast(`${culpa} Tente "Sincronizar agora" de novo.`, "erro", 9000);
      else if (ops) toast(`Agenda atualizada (${ops} evento${ops > 1 ? "s" : ""}).`, "sucesso");
      else toast("Agenda já estava em dia.", "info");
    } else if (erros && !avisouErroNaSessao) {
      avisouErroNaSessao = true;
      toast(`${culpa} Veja Perfil › Configurações › Google Agenda.`, "erro", 9000);
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

/* ══════════════════ LIMPEZA DE EVENTO ÓRFÃO ══════════════════ */

/*
  Existe por causa de um estrago real: enquanto a gravação do id falhava, o
  evento continuava sendo criado, e cada sincronização deixava uma duplicata
  na agenda dele. O `criarERegistrar` fecha a porta pra frente; isto limpa o
  que já passou.

  Órfão = evento criado por este app (a descrição termina em "Lançado pelo
  AppRotina.") cujo id NENHUM documento do Firestore aponta. Se nada aponta,
  o app não tem como gerenciá-lo: ele nunca vai ser atualizado nem apagado.

  Dois cuidados, porque apagar da agenda de alguém é destrutivo e
  irreversível:
  - a função só LISTA; apagar é uma segunda chamada, depois que ele confirma;
  - evento criado nos últimos 10 minutos é ignorado, porque pode ser do
    Apps Script, que grava o id no Firestore alguns segundos depois de criar.
*/

const MARCA = "Lançado pelo AppRotina.";
const CARENCIA_MS = 10 * 60 * 1000;

export async function procurarEventosOrfaos({ rotinas, tarefas, diasAtras = 120 }) {
  const t = await garantirToken();
  if (!t) throw new Error("Google Agenda não está conectado.");

  const usados = new Set();
  rotinas.forEach((r) => r.agendaEventoId && usados.add(r.agendaEventoId));
  tarefas.forEach((tf) => {
    if (tf.agendaEventoId) usados.add(tf.agendaEventoId);
    if (tf.agendaAtrasoId) usados.add(tf.agendaAtrasoId);
  });

  const desde = new Date(Date.now() - diasAtras * 86400000).toISOString();
  const orfaos = [];
  let pagina = null;
  const agora = Date.now();

  for (let volta = 0; volta < 10; volta++) {
    const qs = new URLSearchParams({
      q: "AppRotina",
      singleEvents: "false",
      maxResults: "250",
      timeMin: desde,
      ...(pagina ? { pageToken: pagina } : {}),
    });
    const resp = await chamar("GET", `?${qs}`);
    for (const ev of resp.items || []) {
      if (!String(ev.description || "").includes(MARCA)) continue;
      if (usados.has(ev.id)) continue;
      if (ev.status === "cancelled") continue;
      if (ev.created && agora - new Date(ev.created).getTime() < CARENCIA_MS) continue;
      orfaos.push({
        id: ev.id,
        titulo: ev.summary || "(sem título)",
        quando: ev.start?.dateTime || ev.start?.date || "",
        recorrente: !!(ev.recurrence || []).length,
      });
    }
    pagina = resp.nextPageToken;
    if (!pagina) break;
  }
  return orfaos;
}

/** Apaga a lista que ele confirmou. Devolve quantos saíram e quantos falharam. */
export async function apagarOrfaos(ids) {
  let apagados = 0, falhas = 0;
  for (const id of ids) {
    try { await apagarEvento(id); apagados++; } catch (err) { falhas++; console.error("[agenda]", err); }
  }
  return { apagados, falhas };
}
