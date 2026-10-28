// O Firebase identifica a pessoa; o Google autoriza somente a agenda dela.
// Client secret e refresh tokens ficam apenas nas propriedades do script.
const FIREBASE_PUBLIC_API_KEY = "AIzaSyB2NeOyCUHYGwWzT6Vt8tKD0En-Iz-LmyA";
const PREFIXO_CONTA_OAUTH = "agenda_oauth_";

function doPost(e) {
  try {
    const p = e && e.parameter || {};
    if (!["conectar", "desconectar"].includes(p.action)) throw erroOAuth_("Ação indisponível. Inicie a conexão pelo AppRotina.");
    const pessoa = validarFirebaseAgenda_(p.idToken);
    if (p.action === "desconectar") return desconectarContaAgenda_(pessoa.email.toLowerCase());
    const config = configOAuthAgenda_();
    const estado = comLockAgenda_(() => {
      const cache = CacheService.getScriptCache();
      const limite = "agenda_limite_" + digestAgenda_(pessoa.localId);
      if (cache.get(limite)) throw erroOAuth_("Espere 30 segundos antes de tentar conectar novamente.");
      const state = (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, "");
      cache.put(limite, "1", 30);
      cache.put("agenda_estado_" + state, JSON.stringify({ email: pessoa.email.toLowerCase(), uid: pessoa.localId }), 600);
      return state;
    });
    const parametros = {
      client_id: config.clientId, redirect_uri: config.redirectUri,
      response_type: "code", scope: "https://www.googleapis.com/auth/calendar.events openid email",
      access_type: "offline", prompt: "consent", login_hint: pessoa.email,
      state: estado,
    };
    const url = "https://accounts.google.com/o/oauth2/v2/auth?" + formAgenda_(parametros);
    return paginaAgenda_("Conectar Google Agenda", "Continue com a mesma conta usada no AppRotina. A sincronização poderá continuar com o aplicativo fechado.", url);
  } catch (err) {
    return paginaAgenda_("Conexão não concluída", mensagemAgenda_(err));
  }
}

function doGet(e) {
  const p = e && e.parameter || {};
  if (!p.code && !p.error) return paginaAgenda_("Google Agenda", "Abra o AppRotina e use a opção de conectar sua agenda nas Configurações.");
  try {
    const estado = consumirEstadoAgenda_(p.state);
    if (p.error) throw erroOAuth_("A autorização do Google não foi concluída. Volte ao AppRotina para tentar novamente.");
    if (typeof p.code !== "string" || p.code.length > 4096) throw erroOAuth_("Autorização inválida. Inicie a conexão novamente pelo AppRotina.");
    const config = configOAuthAgenda_();
    const tokens = tokenOAuthAgenda_({
      code: p.code, client_id: config.clientId, client_secret: config.clientSecret,
      redirect_uri: config.redirectUri, grant_type: "authorization_code",
    });
    const pessoa = jsonOAuthAgenda_("https://openidconnect.googleapis.com/v1/userinfo", {
      method: "get", headers: { Authorization: "Bearer " + tokens.access_token },
    }, "Não foi possível conferir a conta autorizada pelo Google.");
    if (pessoa.email_verified !== true || String(pessoa.email || "").toLowerCase() !== estado.email) {
      throw erroOAuth_("A conta Google escolhida é diferente da conta do AppRotina. Conecte novamente escolhendo a mesma conta.");
    }
    return comLockAgenda_(() => comContaAgenda_(estado.email, tokens.access_token, true, () => {
      conferirContaAgenda_();
      const propriedades = PropertiesService.getScriptProperties();
      const chave = PREFIXO_CONTA_OAUTH + digestAgenda_(estado.email);
      const anterior = lerContaOAuth_(propriedades.getProperty(chave));
      const refreshToken = tokens.refresh_token || anterior && anterior.refreshToken;
      if (!refreshToken) throw erroOAuth_("O Google não liberou a sincronização com o aplicativo fechado. Conecte novamente e autorize o acesso.");
      propriedades.setProperty(chave, JSON.stringify({ email: estado.email, refreshToken }));
      if (estado.email === EMAIL_DONO.toLowerCase()) propriedades.deleteProperty("agenda_owner_desativado");
      const temGatilho = ScriptApp.getProjectTriggers().some((t) => t.getHandlerFunction() === "sincronizarAgendaAppRotina");
      if (!temGatilho) {
        fsConfigPatch_({ servidorAtivo: false, intervaloMinutos: 15, ultimoErro: "O proprietário precisa instalar o gatilho de sincronização.", versao: 13 });
        return paginaAgenda_("Conta autorizada", "Falta o proprietário instalar o gatilho do servidor. Sua autorização foi guardada e não precisa ser enviada a ninguém.");
      }
      fsConfigPatch_({ servidorAtivo: true, intervaloMinutos: 15, ultimoErro: "", versao: 13 });
      Utilities.sleep(30000);
      try {
        sincronizarRodada_();
        return paginaAgenda_("Google Agenda conectado", "A sincronização automática está ativa. Volte ao AppRotina pelo ícone do aplicativo. As mudanças são enviadas a cada 15 minutos.");
      } catch (err) {
        fsConfigPatch_({ servidorAtivo: true, ultimoErro: mensagemAgenda_(err) });
        return paginaAgenda_("Conta autorizada", "A primeira sincronização não terminou. O servidor tentará novamente automaticamente; confira o estado nas Configurações do AppRotina.");
      }
    }));
  } catch (err) {
    return paginaAgenda_("Conexão não concluída", mensagemAgenda_(err));
  }
}

function desconectarContaAgenda_(email) {
  return comLockAgenda_(() => comContaAgenda_(email, null, true, () => {
    const propriedades = PropertiesService.getScriptProperties();
    const chave = PREFIXO_CONTA_OAUTH + digestAgenda_(email);
    const conta = lerContaOAuth_(propriedades.getProperty(chave));
    if (conta) {
      let resposta;
      try {
        resposta = UrlFetchApp.fetch("https://oauth2.googleapis.com/revoke", {
          method: "post", contentType: "application/x-www-form-urlencoded",
          payload: formAgenda_({ token: conta.refreshToken }), muteHttpExceptions: true,
        });
      } catch (_) { throw erroOAuth_("Não foi possível revogar o acesso ao Google Agenda. Tente desconectar novamente."); }
      const status = resposta.getResponseCode();
      let erro = "";
      if (status >= 300) {
        try { erro = JSON.parse(resposta.getContentText()).error; } catch (_) {}
      }
      if (status >= 300 && !(status === 400 && erro === "invalid_token")) throw erroOAuth_("Não foi possível revogar o acesso ao Google Agenda. Tente desconectar novamente.");
    }
    if (email === EMAIL_DONO.toLowerCase()) propriedades.setProperty("agenda_owner_desativado", "1");
    fsConfigPatch_({ servidorAtivo: false, ultimoErro: "" });
    propriedades.deleteProperty(chave);
    return paginaAgenda_("Google Agenda desconectado", "A sincronização automática foi desligada. Os eventos que já estavam na agenda foram mantidos.");
  }));
}

function validarFirebaseAgenda_(idToken) {
  if (typeof idToken !== "string" || !idToken || idToken.length > 20000) throw erroOAuth_("Entre no AppRotina antes de conectar a agenda.");
  const resposta = jsonOAuthAgenda_("https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=" + FIREBASE_PUBLIC_API_KEY, {
    method: "post", contentType: "application/json", payload: JSON.stringify({ idToken }),
  }, "Sua sessão do AppRotina expirou. Entre novamente antes de conectar a agenda.");
  const pessoa = resposta.users && resposta.users[0];
  if (!pessoa || !pessoa.localId || !pessoa.email || pessoa.emailVerified !== true || pessoa.disabled) {
    throw erroOAuth_("Use uma conta do AppRotina com e-mail confirmado para conectar a agenda.");
  }
  return pessoa;
}

function consumirEstadoAgenda_(state) {
  if (typeof state !== "string" || !/^[a-f0-9]{64}$/i.test(state)) throw erroOAuth_("A conexão expirou. Inicie novamente pelo AppRotina.");
  return comLockAgenda_(() => {
    const cache = CacheService.getScriptCache();
    const chave = "agenda_estado_" + state;
    const valor = cache.get(chave);
    cache.remove(chave);
    if (!valor) throw erroOAuth_("A conexão expirou ou já foi utilizada. Inicie novamente pelo AppRotina.");
    return JSON.parse(valor);
  });
}

function configOAuthAgenda_() {
  const propriedades = PropertiesService.getScriptProperties();
  const config = {
    clientId: propriedades.getProperty("GOOGLE_CLIENT_ID"),
    clientSecret: propriedades.getProperty("GOOGLE_CLIENT_SECRET"),
    redirectUri: propriedades.getProperty("OAUTH_REDIRECT_URI"),
  };
  if (!config.clientId || !config.clientSecret || !/^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+\/exec$/.test(config.redirectUri || "")) {
    throw erroOAuth_("A conexão automática ainda não foi configurada pelo proprietário.");
  }
  return config;
}

function contasOAuth_() {
  const propriedades = PropertiesService.getScriptProperties().getProperties();
  return Object.keys(propriedades).filter((k) => k.startsWith(PREFIXO_CONTA_OAUTH)).map((k) => {
    return lerContaOAuth_(propriedades[k]) || { invalida: true };
  });
}

function lerContaOAuth_(valor) {
  if (!valor) return null;
  try {
    const conta = JSON.parse(valor);
    return typeof conta.email === "string" && conta.email && typeof conta.refreshToken === "string" && conta.refreshToken ? conta : null;
  } catch (_) { return null; }
}

function renovarTokenAgenda_(conta) {
  const config = configOAuthAgenda_();
  const resposta = tokenOAuthAgenda_({
    client_id: config.clientId, client_secret: config.clientSecret,
    refresh_token: conta.refreshToken, grant_type: "refresh_token",
  });
  if (resposta.refresh_token) {
    PropertiesService.getScriptProperties().setProperty(PREFIXO_CONTA_OAUTH + digestAgenda_(conta.email), JSON.stringify({ email: conta.email, refreshToken: resposta.refresh_token }));
  }
  return resposta.access_token;
}

function tokenOAuthAgenda_(campos) {
  const resposta = jsonOAuthAgenda_("https://oauth2.googleapis.com/token", {
    method: "post", contentType: "application/x-www-form-urlencoded", payload: formAgenda_(campos),
  }, "O acesso ao Google Agenda não pôde ser renovado. Conecte a conta novamente pelo AppRotina.");
  if (typeof resposta.access_token !== "string" || !resposta.access_token) throw erroOAuth_("O Google não autorizou o acesso à agenda. Conecte novamente pelo AppRotina.");
  return resposta;
}

function jsonOAuthAgenda_(url, options, mensagem) {
  try {
    const resposta = UrlFetchApp.fetch(url, Object.assign({ muteHttpExceptions: true }, options));
    if (resposta.getResponseCode() >= 300) throw new Error("Resposta recusada.");
    return JSON.parse(resposta.getContentText());
  } catch (_) { throw erroOAuth_(mensagem); }
}

function erroOAuth_(mensagem) {
  const err = new Error(mensagem);
  err.publico = mensagem;
  return err;
}

function digestAgenda_(texto) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, texto, Utilities.Charset.UTF_8)
    .map((b) => (b & 255).toString(16).padStart(2, "0")).join("");
}

function formAgenda_(obj) {
  return Object.keys(obj).map((k) => encodeURIComponent(k) + "=" + encodeURIComponent(obj[k])).join("&");
}

function htmlAgenda_(texto) {
  return String(texto).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

function paginaAgenda_(titulo, texto, url) {
  const link = url ? `<p><a target="_top" rel="noopener noreferrer" href="${htmlAgenda_(url)}">Continuar com o Google</a></p>` : "";
  return HtmlService.createHtmlOutput(`<!doctype html><html lang="pt-BR"><head><base target="_top"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${htmlAgenda_(titulo)}</title></head><body><main><h1>${htmlAgenda_(titulo)}</h1><p>${htmlAgenda_(texto)}</p>${link}</main></body></html>`).setTitle(titulo);
}
