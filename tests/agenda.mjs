import path from "node:path";
import { fileURLToPath } from "node:url";
const pasta = path.dirname(fileURLToPath(import.meta.url));
import fs from "node:fs";
import vm from "node:vm";
import assert from "node:assert/strict";
const source = fs.readFileSync(path.resolve(pasta, process.argv[2] || "../agenda.js"), "utf8");
async function ambiente({ servidor = true, erroStatus = false } = {}) {
  const escritas = [], toasts = [], pedidos = [];
  let chamadasGoogle = 0, configGIS;
  const cliente = { requestAccessToken(opts) { pedidos.push(opts); configGIS.error_callback({type:"popup_failed_to_open"}); } };
  const ctx = vm.createContext({ console, URLSearchParams, Date, Intl, TextEncoder, setTimeout, clearTimeout,
    crypto: { randomUUID: () => "id-unico" },
    localStorage: { getItem: () => "1", setItem() {}, removeItem() {} },
    window: { google: { accounts: { oauth2: { initTokenClient(config) { chamadasGoogle++; configGIS = config; return cliente; } } } } },
    fetch: () => { chamadasGoogle++; throw new Error("Calendar não deveria ser chamado"); },
  });
  const stubs = {
    db: {}, auth: {currentUser:{email:"teste@example.invalid"}}, GOOGLE_CLIENT_ID: "cliente-teste", AGENDA_SERVIDOR_URL: "",
    doc: (...args) => args.slice(1).join("/"),
    updateDoc: async () => { throw new Error("Não deveria atualizar item"); },
    getDocFromServer: async () => { if(erroStatus) throw new Error("Sem permissão"); return {exists:()=>servidor, data:()=>({servidorAtivo:servidor,intervaloMinutos:15,ultimaSinc:12345,ultimoErro:""})}; },
    setDoc: async (...args) => { escritas.push(args); },
    toast: (...args) => toasts.push(args),
    parseDataLocal: (x) => new Date(x), hojeISO: () => "2026-10-28", somarDiasISO: (x) => x,
    isoLocal: (x) => x, horaEmMinutos: () => 0,
  };
  const mod = new vm.SourceTextModule(source, {context:ctx});
  await mod.link(async (url) => {
    const names = url.includes("firebase-init") ? ["db","auth","GOOGLE_CLIENT_ID","AGENDA_SERVIDOR_URL"] : url.includes("firebase-firestore") ? ["doc","updateDoc","getDocFromServer","setDoc"] : ["toast","parseDataLocal","hojeISO","somarDiasISO","isoLocal","horaEmMinutos"];
    return new vm.SyntheticModule(names,function(){ for(const name of names)this.setExport(name,stubs[name]); },{context:ctx});
  });
  await mod.evaluate();
  return { api:mod.namespace, escritas,toasts,pedidos, google:()=>chamadasGoogle };
}
const dados = {email:"teste@example.invalid",rotinas:[],tarefas:[],nomeCategoria:()=>"",silencioso:false};
{
  const a=await ambiente();
  await a.api.sincronizarAgenda(dados);
  assert.equal(a.google(),0,"servidor ativo não inicia GIS nem Calendar");
  assert.equal(a.api.diagnosticoAgenda().servidor.ultimaSinc,12345);
  await a.api.apagarEventosDe({agendaEventoId:"evento-1"});
  assert.equal(a.google(),0);
  assert.equal(a.escritas.length,1);
  assert.match(a.escritas[0][0],/usuarios\/teste@example.invalid\/agendaExclusoes\/id-unico$/);
  assert.equal(a.escritas[0][1].agendaEventoId,"evento-1");
  assert.equal(a.escritas[0][1].agendaAtrasoId,null);
  assert.match(a.toasts[0][0],/até 15 minutos/);
}
{
  const a=await ambiente({erroStatus:true});
  await a.api.sincronizarAgenda(dados);
  assert.equal(a.google(),0,"falha no status não libera Calendar");
  await assert.rejects(()=>a.api.apagarEventosDe({agendaEventoId:"evento-1"}));
  assert.equal(a.escritas.length,0);
  assert.equal(a.google(),0);
  assert.ok(a.api.diagnosticoAgenda().erroStatus);
}
{
  const a=await ambiente({servidor:false});
  await a.api.carregarStatusAgenda("teste@example.invalid");
  assert.equal(a.api.diagnosticoAgenda().conectada,false,"flag antiga não equivale a token vivo");
  assert.equal(a.api.diagnosticoAgenda().autorizada,true);
  const conectado=await Promise.race([a.api.conectarAgenda(),new Promise((_,reject)=>setTimeout(()=>reject(new Error("popup deixou Promise pendente")),1000))]);
  assert.equal(conectado,false);
  assert.equal(a.pedidos[0].prompt,"consent");
  await a.api.conectarAgenda();
  assert.equal(a.pedidos.length,2,"pedido posterior pode tentar novamente após popup falhar");
}
console.log("PASS: servidor ativo, exclusão enfileirada, status indisponível fail closed, flag antiga e callback de popup.");