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

  O servidor usa ScriptApp.getOAuthToken() para o Firestore, com a conta
  proprietária do projeto. Para o Calendar, cada pessoa autoriza sua própria
  conta pelo OAuth.gs; o refresh token fica só nas propriedades do script.
  Isso não concede acesso ao Firebase nem usa a agenda do proprietário no
  lugar da agenda de outra pessoa. A conta proprietária mantém a integração
  anterior até conectar pelo novo fluxo ou desligá-la explicitamente.

  Espelha a lógica de agenda.js (mesmo app, lado navegador): mesmas três
  regras (rotina vira evento recorrente semanal, tarefa avulsa vira evento
  único, atrasada pendente vira série diária de cobrança de 14 dias), mesma
  comparação por hash pra só escrever na agenda quando o conteúdo mudou de
  verdade. Ver LEIA-ME.md nesta pasta pra instalar.
*/

const FIREBASE_PROJECT_ID = "approtina-54752";

// Conta proprietária do script; outras contas entram pelo OAuth.gs, sem IAM.
const EMAIL_DONO = "felipecastiged@gmail.com";

const FIRESTORE_BASE = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents`;
let emailAgendaAtual = EMAIL_DONO.toLowerCase();
let ESPACO = `${FIRESTORE_BASE}/usuarios/${encodeURIComponent(emailAgendaAtual)}`;
let tokenCalendarAtual = null;
let contaUsaOAuth = false;
const DIAS_JANELA = 90;     // mesmo recorte de tarefas recentes que o app usa
const DIAS_COBRANCA = 14;   // tamanho da série diária de atrasada
const TZ = "America/Sao_Paulo";
const OFFSET_SP_MS = 3 * 60 * 60 * 1000; // América/São Paulo é UTC-3 o ano todo, sem horário de verão desde 2019

const BYDAY = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];
const CALENDAR_API = "https://www.googleapis.com/calendar/v3/calendars/primary/events";
let falhasDaRodada = 0;

/* ═══════════════════════ instalação (rode uma vez) ═══════════════════════ */

/** Rode esta função UMA VEZ pelo editor do Apps Script pra criar o gatilho. */
function instalarGatilho() {
  return comLockAgenda_(() => {
    const existentes = ScriptApp.getProjectTriggers()
      .filter((t) => t.getHandlerFunction() === "sincronizarAgendaAppRotina");
    let contaConferida = false;
    try {
      conferirContaAgenda_();
      contaConferida = true;
      PropertiesService.getScriptProperties().deleteProperty("agenda_owner_desativado");
      // O app deixa de escrever no Calendar ao ler este estado. A espera dá
      // tempo para uma sincronização já iniciada terminar antes da leitura.
      fsConfigPatch_({ servidorAtivo: true, intervaloMinutos: 15, versao: 13 });
      Utilities.sleep(30000);
      sincronizarRodada_();
      if (!existentes.length) {
        ScriptApp.newTrigger("sincronizarAgendaAppRotina").timeBased().everyMinutes(15).create();
      }
      existentes.slice(1).forEach((t) => ScriptApp.deleteTrigger(t));
      Logger.log("Gatilho instalado: sincronizarAgendaAppRotina a cada 15 minutos.");
    } catch (err) {
      if (contaConferida) fsConfigPatch_({ servidorAtivo: existentes.length > 0, ultimoErro: mensagemAgenda_(err) });
      throw err;
    }
  });
}

/* ═══════════════════════ ponto de entrada (gatilho) ═══════════════════════ */

function sincronizarAgendaAppRotina() {
  return comLockAgenda_(() => {
    const contas = contasOAuth_();
    const ownerDesativado = PropertiesService.getScriptProperties().getProperty("agenda_owner_desativado") === "1";
    if (!ownerDesativado && !contas.some((c) => c.email === EMAIL_DONO.toLowerCase())) contas.unshift({ email: EMAIL_DONO.toLowerCase(), proprietario: true });
    let total = 0, falhas = 0;
    contas.forEach((conta) => {
      if (conta.invalida) { falhas++; return; }
      comContaAgenda_(conta.email, null, !conta.proprietario, () => {
        try {
          tokenCalendarAtual = conta.proprietario ? ScriptApp.getOAuthToken() : renovarTokenAgenda_(conta);
          conferirContaAgenda_();
          total += sincronizarRodada_();
        } catch (err) {
          falhas++;
          try { fsConfigPatch_({ ultimoErro: mensagemAgenda_(err) }); }
          catch (_) { Logger.log("Não foi possível gravar o estado de uma conta."); }
          Logger.log("Falhou a sincronização de uma conta: %s", mensagemAgenda_(err));
        }
      });
    });
    if (falhas) throw new Error(`${falhas} conta(s) não foram sincronizadas. Consulte o estado de conexão no aplicativo.`);
    return total;
  });
}

function comContaAgenda_(email, token, usaOAuth, executar) {
  const anterior = { email: emailAgendaAtual, espaco: ESPACO, token: tokenCalendarAtual, oauth: contaUsaOAuth };
  emailAgendaAtual = email.toLowerCase();
  ESPACO = `${FIRESTORE_BASE}/usuarios/${encodeURIComponent(emailAgendaAtual)}`;
  tokenCalendarAtual = token;
  contaUsaOAuth = usaOAuth;
  try { return executar(); }
  finally {
    emailAgendaAtual = anterior.email; ESPACO = anterior.espaco;
    tokenCalendarAtual = anterior.token; contaUsaOAuth = anterior.oauth;
  }
}

function comLockAgenda_(executar) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) throw new Error("Já existe uma sincronização em andamento.");
  try {
    return executar();
  } finally {
    lock.releaseLock();
  }
}

function sincronizarRodada_() {
  falhasDaRodada = 0;
  const opsExclusoes = sincronizarExclusoes_();
  const categorias = fsListAll_("categorias");
  const nomeCategoria = criarNomeCategoria_(categorias);
  const rotinas = fsListAll_("rotinas");
  const tarefas = buscarTarefasRelevantes_();
  const hoje = hojeISO_();
  const opsRotinas = sincronizarRotinas_(rotinas, nomeCategoria);
  const opsAvulsas = sincronizarTarefasAvulsas_(tarefas, nomeCategoria, hoje);
  const opsAtraso = sincronizarAtrasadas_(tarefas, nomeCategoria, hoje);
  const total = opsExclusoes + opsRotinas + opsAvulsas + opsAtraso;
  Logger.log("AppRotina: %s operação(ões), %s falha(s).", total, falhasDaRodada);
  if (falhasDaRodada) throw new Error(`${falhasDaRodada} item(ns) não foram sincronizados. Consulte os erros desta execução.`);
  fsConfigPatch_({ servidorAtivo: true, intervaloMinutos: 15, ultimaSinc: Date.now(), ultimoErro: "", versao: 13 });
  return total;
}

function mensagemAgenda_(err) {
  if (err && err.publico) return err.publico;
  const texto = String(err && err.message || "");
  if (/Google Agenda 401/.test(texto)) return "O acesso ao Google Agenda expirou. Conecte a conta novamente.";
  if (/Google Agenda 403/.test(texto)) return "O Google Agenda recusou o acesso. Confira a autorização e a API do projeto.";
  if (/Firestore 40[13]/.test(texto)) return "O servidor não conseguiu acessar os dados desta conta.";
  if (/^\d+ item\(ns\)/.test(texto)) return texto;
  return "A sincronização não foi concluída. Consulte a execução do servidor.";
}

function sincronizarExclusoes_() {
  let ops = 0;
  fsListAll_("agendaExclusoes").forEach((item) => {
    try {
      if (item.agendaEventoId) apagarEventoSeExistir_(item.agendaEventoId);
      if (item.agendaAtrasoId) apagarEventoSeExistir_(item.agendaAtrasoId);
      fsFetch_(`${ESPACO}/agendaExclusoes/${encodeURIComponent(item.__id)}`, { method: "delete" });
      ops++;
    } catch (err) {
      falhasDaRodada++;
      Logger.log("AppRotina: falhou uma exclusão pendente — %s", err);
    }
  });
  return ops;
}

/* ═══════════════════════ rotinas → evento recorrente ═══════════════════════ */

function sincronizarRotinas_(rotinas, nomeCategoria) {
  let ops = 0;
  rotinas.forEach((r) => {
    try {
      // rotina sem atividade cadastrada não é mais "sem conteúdo": ela é a
      // própria atividade agora, então só sai da agenda se pausada ou sem dia
      const semConteudo = !r.ativa || !(r.diasSemana || []).length;

      if (semConteudo) {
        if (r.agendaEventoId) {
          apagarEventoSeExistir_(r.agendaEventoId);
          fsPatch_("rotinas", r.__id, { agendaEventoId: null, agendaHash: null });
          ops++;
        }
        return;
      }

      const hash = assinaturaRotina_(r);
      if (r.agendaEventoId && r.agendaHash === hash && !r.agendaEventoId.includes("@")) return;
      salvarEvento_("rotinas", r.__id, r.agendaEventoId, eventoDaRotina_(r, nomeCategoria),
        (id) => ({ agendaEventoId: id, agendaHash: hash }));
      ops++;
    } catch (err) {
      falhasDaRodada++;
      // uma rotina com problema não pode travar as outras — loga e segue
      Logger.log("AppRotina: falhou a rotina %s (%s) — %s", r.__id, r.nome, err);
    }
  });
  return ops;
}

/** Espelha app.js#atividadesEfetivas: sem atividade cadastrada, a rotina é
    a própria atividade, usando a categoria dela mesma. */
function atividadesEfetivas_(rotina) {
  if ((rotina.atividades || []).length) return rotina.atividades;
  return [{ id: "self", titulo: "", categoriaId: rotina.categoriaId || "" }];
}

function eventoDaRotina_(rotina, nomeCategoria) {
  const dias = (rotina.diasSemana || []).slice().sort((a, b) => a - b);
  const inicio = primeiraOcorrencia_(dias);
  const dur = Number(rotina.duracaoMin) || 30;
  // Título da atividade é opcional (só a categoria é obrigatória); sem
  // título, a categoria é o que descreve a linha.
  const lista = atividadesEfetivas_(rotina)
    .map((a) => {
      const cat = nomeCategoria(a.categoriaId);
      if (a.titulo && cat) return `• ${a.titulo} (${cat})`;
      return a.titulo || cat ? `• ${a.titulo || cat}` : "";
    })
    .filter(Boolean);
  return {
    summary: rotina.nome,
    description: [lista.join("\n"), "", "Lançado pelo AppRotina."].filter(Boolean).join("\n"),
    start: horarioEvento_(inicio, rotina.hora, 0),
    end: horarioEvento_(inicio, rotina.hora, dur),
    recurrence: [`RRULE:FREQ=WEEKLY;BYDAY=${dias.map((d) => BYDAY[d]).join(",")}`],
    reminders: { useDefault: false, overrides: [{ method: "popup", minutes: 0 }, { method: "popup", minutes: 10 }] },
  };
}

/* ═══════════════════════ tarefa avulsa → evento único ═══════════════════════ */

function sincronizarTarefasAvulsas_(tarefas, nomeCategoria, hoje) {
  let ops = 0;
  tarefas.forEach((t) => {
    try {
      if (t.origem !== "manual") return; // vinda de rotina já está coberta pelo recorrente

      // descartada: o compromisso deixou de existir, sai da agenda
      if (t.estado === "descartada") {
        if (t.agendaEventoId) {
          apagarEventoSeExistir_(t.agendaEventoId);
          fsPatch_("tarefas", t.__id, { agendaEventoId: null, agendaHash: null });
          ops++;
        }
        return;
      }

      if (t.data < hoje && !t.agendaEventoId) return; // passado nunca sincronizado, ignora

      const hash = assinaturaTarefa_(t);
      if (t.agendaEventoId && t.agendaHash === hash && !t.agendaEventoId.includes("@")) return;
      salvarEvento_("tarefas", t.__id, t.agendaEventoId, eventoDaTarefa_(t, nomeCategoria),
        (id) => ({ agendaEventoId: id, agendaHash: hash }));
      ops++;
    } catch (err) {
      falhasDaRodada++;
      Logger.log("AppRotina: falhou a tarefa avulsa %s (%s) — %s", t.__id, t.titulo, err);
    }
  });
  return ops;
}

function eventoDaTarefa_(t, nomeCategoria) {
  const dur = Number(t.duracaoMin) || 30;
  const cat = nomeCategoria(t.categoriaId);
  return {
    summary: t.titulo,
    description: [cat ? `Categoria: ${cat}` : "", "Lançado pelo AppRotina."].filter(Boolean).join("\n"),
    start: horarioEvento_(t.data, t.hora, 0),
    end: horarioEvento_(t.data, t.hora, dur),
    reminders: { useDefault: false, overrides: [{ method: "popup", minutes: 0 }, { method: "popup", minutes: 10 }] },
  };
}

/* ═══════════════════════ atrasada pendente → cobrança diária ═══════════════════════ */

function sincronizarAtrasadas_(tarefas, nomeCategoria, hoje) {
  let ops = 0;
  tarefas.forEach((t) => {
    try {
      const atrasada = t.estado === "pendente" && t.data < hoje;

      if (!atrasada) {
        if (t.agendaAtrasoId) {
          apagarEventoSeExistir_(t.agendaAtrasoId);
          fsPatch_("tarefas", t.__id, { agendaAtrasoId: null, agendaAtrasoAte: null });
          ops++;
        }
        return;
      }

      // série ainda cobrindo os próximos dias: nada a fazer
      if (t.agendaAtrasoId && t.agendaAtrasoAte && t.agendaAtrasoAte >= hoje) {
        if (t.agendaAtrasoId.includes("@")) {
          const id = resolverEventoId_(t.agendaAtrasoId);
          if (!id) throw new Error("Cobrança antiga não encontrada na agenda.");
          fsPatch_("tarefas", t.__id, { agendaAtrasoId: id });
        }
        return;
      }
      const ev = eventoDeAtraso_(t, nomeCategoria, hoje);
      salvarEvento_("tarefas", t.__id, t.agendaAtrasoId, ev.evento,
        (id) => ({ agendaAtrasoId: id, agendaAtrasoAte: ev.cobreAte }));
      ops++;
    } catch (err) {
      falhasDaRodada++;
      Logger.log("AppRotina: falhou a cobrança da tarefa %s (%s) — %s", t.__id, t.titulo, err);
    }
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
    evento: {
      summary: `Atrasada · ${t.titulo}`,
      description: [
        `Era pra ter sido feita em ${formatarDataBR_(t.data)} às ${t.hora || "--:--"}.`,
        cat ? `Categoria: ${cat}` : "",
        "",
        "A cobrança para quando você concluir ou descartar no AppRotina.",
      ].filter(Boolean).join("\n"),
      start: horarioEvento_(inicio, t.hora, 0),
      end: horarioEvento_(inicio, t.hora, 15),
      recurrence: [`RRULE:FREQ=DAILY;COUNT=${DIAS_COBRANCA}`],
      reminders: { useDefault: false, overrides: [{ method: "popup", minutes: 0 }] },
    },
    cobreAte: somarDiasISO_(inicio, DIAS_COBRANCA - 1),
  };
}

/* ═══════════════════════ assinatura (mesmo esquema de agenda.js) ═══════════════════════ */

function assinaturaRotina_(r) {
  return JSON.stringify([
    r.nome, r.hora, r.duracaoMin || 30, (r.diasSemana || []).slice().sort((a, b) => a - b),
    atividadesEfetivas_(r).map((a) => [a.titulo, a.categoriaId]),
  ]);
}

function assinaturaTarefa_(t) {
  return JSON.stringify([t.titulo, t.data, t.hora, t.duracaoMin || 30, t.categoriaId || ""]);
}

/* O navegador e o gatilho usam o mesmo id da Calendar API. CalendarApp
   devolvia iCalUID; o legado é resolvido por list, nunca por tentativa de
   recriar um evento que pode continuar existindo. */
function calendarFetch_(metodo, caminho, corpo, base = CALENDAR_API) {
  if (!tokenCalendarAtual && contaUsaOAuth) throw new Error("Conta sem acesso autorizado ao Google Agenda.");
  const options = {
    method: metodo, headers: { Authorization: `Bearer ${tokenCalendarAtual || ScriptApp.getOAuthToken()}` },
    muteHttpExceptions: true,
  };
  if (corpo) { options.contentType = "application/json"; options.payload = JSON.stringify(corpo); }
  const resp = UrlFetchApp.fetch(base + caminho, options);
  const status = resp.getResponseCode();
  if (status === 404 || status === 410) return { ausente: true };
  const texto = resp.getContentText();
  if (status >= 300) throw new Error(`Google Agenda ${status}: ${texto.slice(0, 300)}`);
  return texto ? JSON.parse(texto) : {};
}

function conferirContaAgenda_() {
  if (contaUsaOAuth) {
    calendarFetch_("get", "?maxResults=1");
    return;
  }
  const calendario = calendarFetch_("get", "", null, CALENDAR_API.replace(/\/events$/, ""));
  if (String(calendario.id || "").toLowerCase() !== emailAgendaAtual) {
    throw new Error("A conta Google que autorizou o script não é a dona dos dados. Autorize com a conta configurada em EMAIL_DONO.");
  }
}

function resolverEventoId_(id) {
  if (!id || !id.includes("@")) return id || null;
  const lista = calendarFetch_("get", `?iCalUID=${encodeURIComponent(id)}&singleEvents=false&showDeleted=false`);
  const itens = (lista.items || []).filter((e) => e.status !== "cancelled");
  if (lista.nextPageToken || itens.length > 1) throw new Error("Identificador antigo encontrou mais de um evento. Confira a agenda antes de sincronizar.");
  return itens.length ? itens[0].id : null;
}

function apagarEventoSeExistir_(id) {
  const resolvido = resolverEventoId_(id);
  if (resolvido) calendarFetch_("delete", `/${encodeURIComponent(resolvido)}`);
}

function salvarEvento_(colecao, docId, idAtual, evento, campos) {
  const id = resolverEventoId_(idAtual);
  const resposta = id ? calendarFetch_("patch", `/${encodeURIComponent(id)}`, evento) : { ausente: true };
  const criado = !!resposta.ausente;
  const salvo = criado ? calendarFetch_("post", "", evento) : resposta;
  if (!salvo.id) throw new Error("Google Agenda: resposta sem identificador do evento.");
  try {
    fsPatch_(colecao, docId, campos(salvo.id));
  } catch (err) {
    if (criado) apagarEventoSeExistir_(salvo.id);
    throw err;
  }
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

function horarioEvento_(dataISO, hora, somarMin) {
  return { dateTime: dataHoraSP_(dataISO, hora, somarMin).toISOString(), timeZone: TZ };
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
    const url = `${ESPACO}/${colecao}?pageSize=300${pageToken ? "&pageToken=" + encodeURIComponent(pageToken) : ""}`;
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
  const resp = fsFetch_(`${ESPACO}:runQuery`, { method: "post", payload: body });
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
  fsFetch_(`${ESPACO}/${colecao}/${id}?${mask}&currentDocument.exists=true`, { method: "patch", payload: { fields } });
}

// Estado operacional: só o servidor escreve; o aplicativo apenas consulta.
function fsConfigPatch_(campos) {
  const fields = {};
  Object.keys(campos).forEach((k) => { fields[k] = paraValorFirestore_(campos[k]); });
  const mask = Object.keys(campos).map((k) => `updateMask.fieldPaths=${encodeURIComponent(k)}`).join("&");
  fsFetch_(`${ESPACO}/config/agenda?${mask}`, { method: "patch", payload: { fields } });
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
