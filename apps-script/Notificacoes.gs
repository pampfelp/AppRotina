/* Lembretes do próprio AppRotina. As credenciais ficam no Apps Script;
   o navegador grava somente o endereço de push no espaço da própria conta. */
const PUSH_CACHE_SEGUNDOS = 240;
const PUSH_JANELA_MS = 5 * 60 * 1000;

function instalarGatilhoPush() {
  const vapidKey = PropertiesService.getScriptProperties().getProperty("VAPID_PUBLIC_KEY") || "";
  if (!/^[A-Za-z0-9_-]{87}$/.test(vapidKey)) throw new Error("Configure VAPID_PUBLIC_KEY com a chave pública Web Push do AppRotina.");
  // Valida o envio sem entregar mensagem a nenhum aparelho.
  const teste = UrlFetchApp.fetch(`https://fcm.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/messages:send`, {
    method: "post", contentType: "application/json", muteHttpExceptions: true,
    headers: { Authorization: "Bearer " + ScriptApp.getOAuthToken() },
    payload: JSON.stringify({ validate_only: true, message: { topic: "approtina-diagnostico", data: { tipo: "verificacao" } } }),
  });
  if (teste.getResponseCode() >= 300) throw new Error(`FCM recusou a verificação (${teste.getResponseCode()}). Confira API e permissão de envio do proprietário.`);
  const existentes = ScriptApp.getProjectTriggers().filter((t) => t.getHandlerFunction() === "enviarLembretesAppRotina");
  if (!existentes.length) ScriptApp.newTrigger("enviarLembretesAppRotina").timeBased().everyMinutes(1).create();
  existentes.slice(1).forEach((t) => ScriptApp.deleteTrigger(t));
  pushGravar_(`${FIRESTORE_BASE}/config/notificacoes`, { vapidKey });
  Logger.log("Lembretes do AppRotina: gatilho a cada minuto.");
}

function enviarLembretesAppRotina() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) return; // a próxima rodada recupera até cinco minutos
  const props = PropertiesService.getScriptProperties();
  const agora = Date.now();
  const anterior = Number(props.getProperty("push_ultima_rodada")) || agora - 60000;
  // Repassa também a janela do cache: uma tarefa criada depois do snapshot
  // ainda precisa ser encontrada quando ele for renovado. A marca por
  // aparelho e ocorrência impede repetir o aviso já entregue.
  const inicio = Math.max(Math.min(anterior, agora) - PUSH_CACHE_SEGUNDOS * 1000, agora - PUSH_JANELA_MS);
  let falhas = 0;
  try {
    const tokens = pushCache_("rot-push-tokens", pushListarTokens_);
    const porEmail = {};
    tokens.forEach((item) => {
      const email = pushEmailDoCaminho_(item.__name);
      if (!email || !item.token || !item.__id) return;
      (porEmail[email] || (porEmail[email] = [])).push(item);
    });
    Object.keys(porEmail).forEach((email) => {
      try {
        const base = `${FIRESTORE_BASE}/usuarios/${encodeURIComponent(email)}`;
        const dados = pushCache_("rot-push-dados-" + pushHash_(email), () => ({
          rotinas: pushQuery_(base, "rotinas", "ativa", "EQUAL", true),
          tarefas: pushQuery_(base, "tarefas", "estado", "EQUAL", "pendente"),
        }));
        const fontes = {};
        porEmail[email].forEach((aparelho) => {
          const fuso = pushFuso_(aparelho.fuso);
          for (let minuto = Math.floor(inicio / 60000) + 1; minuto <= Math.floor(agora / 60000); minuto++) {
            const momento = new Date(minuto * 60000);
            const data = Utilities.formatDate(momento, fuso, "yyyy-MM-dd");
            const hora = Utilities.formatDate(momento, fuso, "HH:mm");
            pushOcorrencias_(dados, data, hora).forEach((ocorrencia) => {
              try {
                if (aparelho.__invalido) return;
                const caminho = `${base}/${ocorrencia.colecao}/${encodeURIComponent(ocorrencia.id)}`;
                // Cache não pode avisar tarefa que foi concluída ou alterada.
                if (!(caminho in fontes)) fontes[caminho] = pushLer_(caminho);
                const atual = fontes[caminho];
                if (!atual || !pushConfereOcorrencia_(atual, ocorrencia.tipo, data, hora)) return;
                const id = pushHash_(`${aparelho.__id}|${ocorrencia.tipo}|${ocorrencia.id}`);
                const marcaUrl = `${base}/pushEnvios/${id}`;
                const chave = `${data}T${hora}`;
                if (pushLer_(marcaUrl)?.ocorrencia === chave) return;
                const titulo = ocorrencia.tipo === "rotina" ? atual.nome : atual.titulo;
                const corpo = ocorrencia.tipo === "atrasada" ? "Esta atividade continua pendente." : "Sua atividade está marcada para agora.";
                const resultado = pushEnviar_(aparelho.token, { titulo: String(titulo || "AppRotina").slice(0, 160), corpo, tag: `rot-${id}-${data}`, url: "index.html" });
                if (resultado === "invalido") {
                  aparelho.__invalido = true;
                  fsFetch_(aparelho.__name, { method: "delete" });
                  CacheService.getScriptCache().remove("rot-push-tokens");
                  return;
                }
                if (resultado !== "enviado") { falhas++; return; }
                pushGravar_(marcaUrl, { ocorrencia: chave, enviadoEm: agora });
              } catch (_) { falhas++; }
            });
          }
        });
      } catch (_) { falhas++; }
    });
    if (falhas) throw new Error(`${falhas} lembrete(s) não foram concluídos. A próxima rodada tentará novamente dentro da janela de cinco minutos.`);
    props.setProperty("push_ultima_rodada", String(agora));
  } finally { lock.releaseLock(); }
}

function pushHash_(valor) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, valor, Utilities.Charset.UTF_8)
    .map((b) => (b & 255).toString(16).padStart(2, "0")).join("");
}

function pushCache_(chave, carregar) {
  const cache = CacheService.getScriptCache();
  const salvo = cache.get(chave);
  if (salvo) { try { return JSON.parse(salvo); } catch (_) {} }
  const valor = carregar();
  const texto = JSON.stringify(valor);
  if (texto.length < 45000) cache.put(chave, texto, PUSH_CACHE_SEGUNDOS);
  return valor;
}

function pushListarTokens_() {
  const tokens = [];
  let ultimo = null;
  do {
    const consulta = {
      from: [{ collectionId: "pushTokens", allDescendants: true }],
      orderBy: [{ field: { fieldPath: "__name__" }, direction: "ASCENDING" }],
      limit: 300,
    };
    if (ultimo) consulta.startAt = { values: [{ referenceValue: ultimo }], before: false };
    const resposta = fsFetch_(`${FIRESTORE_BASE}:runQuery`, { method: "post", payload: { structuredQuery: consulta } });
    const documentos = (Array.isArray(resposta) ? resposta : []).filter((r) => r.document).map((r) => r.document);
    documentos.forEach((documento) => {
      const item = fsDocParaObjeto_(documento);
      item.__name = "https://firestore.googleapis.com/v1/" + documento.name;
      tokens.push(item);
    });
    ultimo = documentos.length === 300 ? documentos[documentos.length - 1].name : null;
  } while (ultimo);
  return tokens;
}

function pushEmailDoCaminho_(caminho) {
  const prefixo = `${FIRESTORE_BASE}/usuarios/`;
  if (!String(caminho).startsWith(prefixo)) return "";
  const partes = String(caminho).slice(prefixo.length).split("/");
  if (partes.length !== 3 || partes[1] !== "pushTokens") return "";
  try {
    const email = decodeURIComponent(partes[0]).toLowerCase();
    return email.includes("@") && !email.includes("/") ? email : "";
  } catch (_) { return ""; }
}

function pushQuery_(base, colecao, campo, operador, valor) {
  const resposta = fsFetch_(`${base}:runQuery`, { method: "post", payload: { structuredQuery: {
    from: [{ collectionId: colecao }],
    where: { fieldFilter: { field: { fieldPath: campo }, op: operador, value: paraValorFirestore_(valor) } },
  } } });
  return (Array.isArray(resposta) ? resposta : []).filter((r) => r.document).map((r) => fsDocParaObjeto_(r.document));
}

function pushLer_(url) {
  try { return fsDocParaObjeto_(fsFetch_(url)); }
  catch (err) {
    if (/^Firestore 404\b/.test(String(err.message))) return null;
    throw err;
  }
}

function pushGravar_(url, dados) {
  const fields = {};
  Object.keys(dados).forEach((chave) => { fields[chave] = paraValorFirestore_(dados[chave]); });
  fsFetch_(url, { method: "patch", payload: { fields } });
}

function pushFuso_(valor) {
  try { new Intl.DateTimeFormat("pt-BR", { timeZone: valor }).format(); return valor || "America/Sao_Paulo"; }
  catch (_) { return "America/Sao_Paulo"; }
}

function pushConfereOcorrencia_(item, tipo, data, hora) {
  if (!/^\d{2}:\d{2}$/.test(String(item.hora)) || item.hora !== hora) return false;
  if (tipo === "rotina") {
    const dia = new Date(`${data}T12:00:00Z`).getUTCDay();
    return item.ativa === true && (item.diasSemana || []).includes(dia);
  }
  if (item.estado !== "pendente") return false;
  if (tipo === "manual") return item.origem === "manual" && item.data === data;
  return tipo === "atrasada" && item.data < data;
}

function pushOcorrencias_(dados, data, hora) {
  const ocorrencias = [];
  (dados.rotinas || []).forEach((r) => {
    if (pushConfereOcorrencia_(r, "rotina", data, hora)) ocorrencias.push({ tipo: "rotina", colecao: "rotinas", id: r.__id });
  });
  (dados.tarefas || []).forEach((t) => {
    const tipo = t.data < data ? "atrasada" : "manual";
    if (pushConfereOcorrencia_(t, tipo, data, hora)) ocorrencias.push({ tipo, colecao: "tarefas", id: t.__id });
  });
  return ocorrencias;
}

function pushEnviar_(token, dados) {
  const resposta = UrlFetchApp.fetch(`https://fcm.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/messages:send`, {
    method: "post", contentType: "application/json", muteHttpExceptions: true,
    headers: { Authorization: "Bearer " + ScriptApp.getOAuthToken() },
    payload: JSON.stringify({ message: { token, data: dados, webpush: { headers: { Urgency: "high", TTL: "300" } } } }),
  });
  if (resposta.getResponseCode() >= 200 && resposta.getResponseCode() < 300) return "enviado";
  let erro = {};
  try { erro = JSON.parse(resposta.getContentText()).error || {}; } catch (_) {}
  if ((erro.details || []).some((d) => d.errorCode === "UNREGISTERED")) return "invalido";
  Logger.log("AppRotina: envio de lembrete recusado (%s).", resposta.getResponseCode());
  return "falhou";
}
