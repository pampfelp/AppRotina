/*
  Code.gs — sincronização do AppRotina com o Google Agenda rodando por
  gatilho de tempo, sem depender do navegador estar aberto.

  POR QUE ESSE ARQUIVO EXISTE (2026-09-18). O navegador guarda o token do
  Google Agenda só em memória, e ele expira em 1 hora (ver agenda.js). A
  renovação automática tenta renovar sozinha, mas depende de cookie de
  terceiro pro accounts.google.com, que o Chrome/Edge vêm bloqueando por
  padrão — então na prática ela falha calada e o app volta a pedir
  "Conectar" a cada sessão. Não dá pra resolver isso 100% no navegador sem
  um client_secret, e client_secret nunca pode ir pra um site estático
  público (crença 4: sem servidor, sem build step — mas também sem segredo
  exposto).

  A SAÍDA: um Apps Script rodando com a SUA conta Google (a mesma dona do
  projeto Firebase), autenticado por ScriptApp.getOAuthToken() — nunca uma
  senha, nunca um client_secret. Como você é dono do projeto, esse token já
  enxerga o Firestore direto pela API REST, sem passar pelas firestore.rules
  (elas só valem pra quem entra pelo SDK do navegador com login do app) e
  sem precisar de chave de service account nenhuma. O gatilho de tempo
  renova a autorização sozinho a cada execução — é o Google quem garante
  isso, não o Apps Script.

  Espelha a lógica de agenda.js (mesmo app, lado navegador): mesmas três
  regras (rotina vira evento recorrente semanal, tarefa avulsa vira evento
  único, atrasada pendente vira série diária de cobrança de 14 dias), mesma
  comparação por hash pra só escrever na agenda quando o conteúdo mudou de
  verdade. Ver LEIA-ME.md nesta pasta pra instalar.
*/

const FIREBASE_PROJECT_ID = "approtina-54752";
const FIRESTORE_BASE = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents`;
const DIAS_JANELA = 90;     // mesmo recorte de tarefas recentes que o app usa
const DIAS_COBRANCA = 14;   // tamanho da série diária de atrasada
const TZ = "America/Sao_Paulo";
const OFFSET_SP_MS = 3 * 60 * 60 * 1000; // América/São Paulo é UTC-3 o ano todo, sem horário de verão desde 2019

const WEEKDAYS = [
  CalendarApp.Weekday.SUNDAY, CalendarApp.Weekday.MONDAY, CalendarApp.Weekday.TUESDAY,
  CalendarApp.Weekday.WEDNESDAY, CalendarApp.Weekday.THURSDAY, CalendarApp.Weekday.FRIDAY,
  CalendarApp.Weekday.SATURDAY,
];

/* ═══════════════════════ instalação (rode uma vez) ═══════════════════════ */

/** Rode esta função UMA VEZ pelo editor do Apps Script pra criar o gatilho. */
function instalarGatilho() {
  removerGatilhos_();
  ScriptApp.newTrigger("sincronizarAgendaAppRotina").timeBased().everyMinutes(15).create();
  Logger.log("Gatilho instalado: sincronizarAgendaAppRotina a cada 15 minutos.");
  sincronizarAgendaAppRotina(); // já roda uma vez na hora, pra você ver o resultado sem esperar
}

function removerGatilhos_() {
  ScriptApp.getProjectTriggers()
    .filter((t) => t.getHandlerFunction() === "sincronizarAgendaAppRotina")
    .forEach((t) => ScriptApp.deleteTrigger(t));
}

/* ═══════════════════════ ponto de entrada (gatilho) ═══════════════════════ */

function sincronizarAgendaAppRotina() {
  const categorias = fsListAll_("categorias");
  const nomeCategoria = criarNomeCategoria_(categorias);
  const rotinas = fsListAll_("rotinas");
  const tarefas = buscarTarefasRelevantes_();
  const cal = CalendarApp.getDefaultCalendar();
  const hoje = hojeISO_();

  const opsRotinas = sincronizarRotinas_(cal, rotinas, nomeCategoria);
  const opsAvulsas = sincronizarTarefasAvulsas_(cal, tarefas, nomeCategoria, hoje);
  const opsAtraso = sincronizarAtrasadas_(cal, tarefas, nomeCategoria, hoje);

  const total = opsRotinas + opsAvulsas + opsAtraso;
  if (total) {
    Logger.log(
      "AppRotina: %s operação(ões) no Google Agenda (rotinas=%s, avulsas=%s, atraso=%s).",
      total, opsRotinas, opsAvulsas, opsAtraso
    );
  }
}

/* ═══════════════════════ rotinas → evento recorrente ═══════════════════════ */

function sincronizarRotinas_(cal, rotinas, nomeCategoria) {
  let ops = 0;
  rotinas.forEach((r) => {
    const semConteudo = !r.ativa || !(r.diasSemana || []).length || !(r.atividades || []).length;

    if (semConteudo) {
      if (r.agendaEventoId) {
        apagarSerieSeExistir_(cal, r.agendaEventoId);
        fsPatch_("rotinas", r.__id, { agendaEventoId: null, agendaHash: null });
        ops++;
      }
      return;
    }

    const hash = assinaturaRotina_(r);
    if (r.agendaEventoId && r.agendaHash === hash) return;

    // recriar em vez de editar: o CalendarApp não tem como mudar horário ou
    // regra de recorrência de uma série já criada, só apagar e criar de novo
    if (r.agendaEventoId) apagarSerieSeExistir_(cal, r.agendaEventoId);
    const ev = eventoDaRotina_(r, nomeCategoria);
    const novoId = criarSerieSemanal_(cal, ev);
    fsPatch_("rotinas", r.__id, { agendaEventoId: novoId, agendaHash: hash });
    ops++;
  });
  return ops;
}

function eventoDaRotina_(rotina, nomeCategoria) {
  const dias = (rotina.diasSemana || []).slice().sort((a, b) => a - b);
  const inicio = primeiraOcorrencia_(dias);
  const dur = Number(rotina.duracaoMin) || 30;
  // Título da atividade é opcional (só a categoria é obrigatória); sem
  // título, a categoria é o que descreve a linha.
  const lista = (rotina.atividades || [])
    .map((a) => {
      const cat = nomeCategoria(a.categoriaId);
      if (a.titulo && cat) return `• ${a.titulo} (${cat})`;
      return a.titulo || cat ? `• ${a.titulo || cat}` : "";
    })
    .filter(Boolean);
  return {
    titulo: rotina.nome,
    descricao: [lista.join("\n"), "", "Lançado pelo AppRotina."].filter(Boolean).join("\n"),
    inicio: dataHoraSP_(inicio, rotina.hora, 0),
    fim: dataHoraSP_(inicio, rotina.hora, dur),
    diasSemana: dias,
  };
}

function criarSerieSemanal_(cal, ev) {
  const recorrencia = CalendarApp.newRecurrence().addWeeklyRule()
    .onlyOnWeekdays(ev.diasSemana.map((d) => WEEKDAYS[d]));
  const serie = cal.createEventSeries(ev.titulo, ev.inicio, ev.fim, recorrencia);
  serie.setDescription(ev.descricao);
  serie.removeAllReminders();
  serie.addPopupReminder(0);
  serie.addPopupReminder(10);
  return serie.getId();
}

/* ═══════════════════════ tarefa avulsa → evento único ═══════════════════════ */

function sincronizarTarefasAvulsas_(cal, tarefas, nomeCategoria, hoje) {
  let ops = 0;
  tarefas.forEach((t) => {
    if (t.origem !== "manual") return; // vinda de rotina já está coberta pelo recorrente

    // descartada: o compromisso deixou de existir, sai da agenda
    if (t.estado === "descartada") {
      if (t.agendaEventoId) {
        apagarEventoSeExistir_(cal, t.agendaEventoId);
        fsPatch_("tarefas", t.__id, { agendaEventoId: null, agendaHash: null });
        ops++;
      }
      return;
    }

    if (t.data < hoje && !t.agendaEventoId) return; // passado nunca sincronizado, ignora

    const hash = assinaturaTarefa_(t);
    if (t.agendaEventoId && t.agendaHash === hash) return;

    if (t.agendaEventoId) apagarEventoSeExistir_(cal, t.agendaEventoId);
    const ev = eventoDaTarefa_(t, nomeCategoria);
    const evento = cal.createEvent(ev.titulo, ev.inicio, ev.fim, { description: ev.descricao });
    evento.removeAllReminders();
    evento.addPopupReminder(0);
    evento.addPopupReminder(10);
    fsPatch_("tarefas", t.__id, { agendaEventoId: evento.getId(), agendaHash: hash });
    ops++;
  });
  return ops;
}

function eventoDaTarefa_(t, nomeCategoria) {
  const dur = Number(t.duracaoMin) || 30;
  const cat = nomeCategoria(t.categoriaId);
  return {
    titulo: t.titulo,
    descricao: [cat ? `Categoria: ${cat}` : "", "Lançado pelo AppRotina."].filter(Boolean).join("\n"),
    inicio: dataHoraSP_(t.data, t.hora, 0),
    fim: dataHoraSP_(t.data, t.hora, dur),
  };
}

/* ═══════════════════════ atrasada pendente → cobrança diária ═══════════════════════ */

function sincronizarAtrasadas_(cal, tarefas, nomeCategoria, hoje) {
  let ops = 0;
  tarefas.forEach((t) => {
    const atrasada = t.estado === "pendente" && t.data < hoje;

    if (!atrasada) {
      if (t.agendaAtrasoId) {
        apagarSerieSeExistir_(cal, t.agendaAtrasoId);
        fsPatch_("tarefas", t.__id, { agendaAtrasoId: null, agendaAtrasoAte: null });
        ops++;
      }
      return;
    }

    // série ainda cobrindo os próximos dias: nada a fazer
    if (t.agendaAtrasoId && t.agendaAtrasoAte && t.agendaAtrasoAte >= hoje) return;

    if (t.agendaAtrasoId) apagarSerieSeExistir_(cal, t.agendaAtrasoId);
    const ev = eventoDeAtraso_(t, nomeCategoria, hoje);
    const recorrencia = CalendarApp.newRecurrence().addDailyRule().times(DIAS_COBRANCA);
    const serie = cal.createEventSeries(ev.titulo, ev.inicio, ev.fim, recorrencia);
    serie.setDescription(ev.descricao);
    serie.removeAllReminders();
    serie.addPopupReminder(0);
    fsPatch_("tarefas", t.__id, { agendaAtrasoId: serie.getId(), agendaAtrasoAte: ev.cobreAte });
    ops++;
  });
  return ops;
}

function eventoDeAtraso_(t, nomeCategoria, hoje) {
  // começa hoje se a hora original ainda não passou; senão amanhã, senão o
  // primeiro lembrete nasceria no passado e não notificaria nada
  const agora = new Date();
  const agoraMin = Number(Utilities.formatDate(agora, TZ, "H")) * 60 + Number(Utilities.formatDate(agora, TZ, "m"));
  const inicio = horaEmMinutos_(t.hora) > agoraMin + 2 ? hoje : somarDiasISO_(hoje, 1);
  const cat = nomeCategoria(t.categoriaId);
  return {
    titulo: `Atrasada · ${t.titulo}`,
    descricao: [
      `Era pra ter sido feita em ${formatarDataBR_(t.data)} às ${t.hora || "--:--"}.`,
      cat ? `Categoria: ${cat}` : "",
      "",
      "A cobrança para quando você concluir ou descartar no AppRotina.",
    ].filter(Boolean).join("\n"),
    inicio: dataHoraSP_(inicio, t.hora, 0),
    fim: dataHoraSP_(inicio, t.hora, 15),
    cobreAte: somarDiasISO_(inicio, DIAS_COBRANCA - 1),
  };
}

/* ═══════════════════════ assinatura (mesmo esquema de agenda.js) ═══════════════════════ */

function assinaturaRotina_(r) {
  return JSON.stringify([
    r.nome, r.hora, r.duracaoMin || 30, (r.diasSemana || []).slice().sort((a, b) => a - b),
    (r.atividades || []).map((a) => [a.titulo, a.categoriaId]),
  ]);
}

function assinaturaTarefa_(t) {
  return JSON.stringify([t.titulo, t.data, t.hora, t.duracaoMin || 30, t.categoriaId || ""]);
}

/* ═══════════════════════ Google Agenda: apagar com segurança ═══════════════════════ */
/* Um id que não existe mais na agenda (já apagado na mão, por exemplo) não
   pode travar a sincronização inteira — só loga e segue. */

function apagarSerieSeExistir_(cal, id) {
  try {
    const serie = cal.getEventSeriesById(id);
    if (serie) serie.deleteEventSeries();
  } catch (err) { Logger.log("Série %s não encontrada pra apagar (%s).", id, err); }
}

function apagarEventoSeExistir_(cal, id) {
  try {
    const evento = cal.getEventById(id);
    if (evento) evento.deleteEvent();
  } catch (err) { Logger.log("Evento %s não encontrado pra apagar (%s).", id, err); }
}

/* ═══════════════════════ datas (fuso fixo, nunca o default do runtime) ═══════════════════════ */

function hojeISO_() {
  return Utilities.formatDate(new Date(), TZ, "yyyy-MM-dd");
}

function somarDiasISO_(iso, dias) {
  const [y, m, d] = iso.split("-").map(Number);
  const data = new Date(Date.UTC(y, m - 1, d) + dias * 86400000);
  return `${data.getUTCFullYear()}-${String(data.getUTCMonth() + 1).padStart(2, "0")}-${String(data.getUTCDate()).padStart(2, "0")}`;
}

function diaSemanaISO_(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

function primeiraOcorrencia_(dias) {
  const hoje = hojeISO_();
  for (let i = 0; i < 7; i++) {
    const cand = somarDiasISO_(hoje, i);
    if (dias.includes(diaSemanaISO_(cand))) return cand;
  }
  return hoje;
}

function horaEmMinutos_(hora) {
  if (!hora) return 24 * 60 + 1;
  const [h, m] = String(hora).split(":").map(Number);
  return (h || 0) * 60 + (m || 0);
}

function formatarDataBR_(iso) {
  const [y, m, d] = iso.split("-");
  return `${d}/${m}/${y}`;
}

/** Data/hora em ponto-no-tempo (Date) que representa esse horário de
    parede em América/São Paulo — sempre por aritmética UTC pura, nunca
    pelo fuso default do runtime (que às vezes não é o de São Paulo). */
function dataHoraSP_(dataISO, hora, somarMin) {
  const [y, m, d] = dataISO.split("-").map(Number);
  const [h, mi] = String(hora || "08:00").split(":").map(Number);
  const ms = Date.UTC(y, m - 1, d, h || 0, (mi || 0) + (somarMin || 0), 0) + OFFSET_SP_MS;
  return new Date(ms);
}

function criarNomeCategoria_(categorias) {
  const porId = {};
  categorias.forEach((c) => { porId[c.__id] = c.nome; });
  return (id) => porId[id] || "";
}

/* ═══════════════════════ Firestore via REST, autenticado como você mesmo ═══════════════════════ */

function fsToken_() {
  return ScriptApp.getOAuthToken();
}

function fsFetch_(url, opts) {
  const options = Object.assign(
    { method: "get", headers: { Authorization: `Bearer ${fsToken_()}` }, muteHttpExceptions: true },
    opts || {}
  );
  if (options.payload && typeof options.payload !== "string") {
    options.contentType = "application/json";
    options.payload = JSON.stringify(options.payload);
  }
  const resp = UrlFetchApp.fetch(url, options);
  const codigo = resp.getResponseCode();
  const texto = resp.getContentText();
  if (codigo >= 300) throw new Error(`Firestore ${codigo}: ${texto.slice(0, 300)}`);
  return texto ? JSON.parse(texto) : {};
}

/** Lista todos os documentos de uma coleção, paginando sozinho. */
function fsListAll_(colecao) {
  const docs = [];
  let pageToken = "";
  do {
    const url = `${FIRESTORE_BASE}/${colecao}?pageSize=300${pageToken ? "&pageToken=" + encodeURIComponent(pageToken) : ""}`;
    const resp = fsFetch_(url);
    (resp.documents || []).forEach((d) => docs.push(fsDocParaObjeto_(d)));
    pageToken = resp.nextPageToken || "";
  } while (pageToken);
  return docs;
}

/** :runQuery com um único filtro — usado pro mesmo recorte que o app faz
    (pendentes de qualquer data + recentes dos últimos 90 dias), nunca a
    coleção `tarefas` inteira, que só cresce com o tempo. */
function fsRunQuery_(colecao, campo, operador, valor) {
  const body = {
    structuredQuery: {
      from: [{ collectionId: colecao }],
      where: { fieldFilter: { field: { fieldPath: campo }, op: operador, value: paraValorFirestore_(valor) } },
    },
  };
  const resp = fsFetch_(`${FIRESTORE_BASE}:runQuery`, { method: "post", payload: body });
  return (Array.isArray(resp) ? resp : [])
    .filter((r) => r.document)
    .map((r) => fsDocParaObjeto_(r.document));
}

function buscarTarefasRelevantes_() {
  const pendentes = fsRunQuery_("tarefas", "estado", "EQUAL", "pendente");
  const inicio = somarDiasISO_(hojeISO_(), -DIAS_JANELA);
  const recentes = fsRunQuery_("tarefas", "data", "GREATER_THAN_OR_EQUAL", inicio);
  const porId = {};
  recentes.forEach((t) => { porId[t.__id] = t; });
  pendentes.forEach((t) => { porId[t.__id] = t; }); // pendente sempre entra, mesmo fora da janela
  return Object.values(porId);
}

/** Atualiza só os campos passados — o mesmo espírito do updateDoc() do
    Firestore no navegador, nunca sobrescrevendo o documento inteiro. */
function fsPatch_(colecao, id, campos) {
  const fields = {};
  Object.keys(campos).forEach((k) => { fields[k] = paraValorFirestore_(campos[k]); });
  const mask = Object.keys(campos).map((k) => `updateMask.fieldPaths=${encodeURIComponent(k)}`).join("&");
  fsFetch_(`${FIRESTORE_BASE}/${colecao}/${id}?${mask}`, { method: "patch", payload: { fields } });
}

function fsDocParaObjeto_(doc) {
  const obj = deValorFirestore_({ mapValue: { fields: doc.fields || {} } });
  obj.__id = doc.name.split("/").pop();
  return obj;
}

function deValorFirestore_(v) {
  if (v.nullValue !== undefined) return null;
  if (v.stringValue !== undefined) return v.stringValue;
  if (v.integerValue !== undefined) return Number(v.integerValue);
  if (v.doubleValue !== undefined) return Number(v.doubleValue);
  if (v.booleanValue !== undefined) return v.booleanValue;
  if (v.timestampValue !== undefined) return v.timestampValue;
  if (v.arrayValue !== undefined) return (v.arrayValue.values || []).map(deValorFirestore_);
  if (v.mapValue !== undefined) {
    const out = {};
    const fields = v.mapValue.fields || {};
    Object.keys(fields).forEach((k) => { out[k] = deValorFirestore_(fields[k]); });
    return out;
  }
  return null;
}

function paraValorFirestore_(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === "string") return { stringValue: v };
  if (typeof v === "boolean") return { booleanValue: v };
  if (typeof v === "number") return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(paraValorFirestore_) } };
  if (typeof v === "object") {
    const fields = {};
    Object.keys(v).forEach((k) => { fields[k] = paraValorFirestore_(v[k]); });
    return { mapValue: { fields } };
  }
  return { nullValue: null };
}
