const path = require("node:path");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const source = fs.readFileSync(path.join(__dirname,"..","apps-script","Code.gs"), "utf8");
const calls = [];
let responses = [];
let unlocked = 0;
const context = {
  console,
  ScriptApp: { getOAuthToken: () => "fake-test-token" },
  UrlFetchApp: { fetch(url, options) {
    calls.push({url, ...options, data: options.payload ? JSON.parse(options.payload) : null});
    const item = responses.shift();
    if (!item) throw new Error("Unexpected request " + url);
    return { getResponseCode: () => item[0], getContentText: () => item[1] === null ? "" : JSON.stringify(item[1]) };
  } },
  LockService: { getScriptLock: () => ({tryLock: () => true, releaseLock: () => unlocked++}) },
  Logger: {log(){}},
  Utilities: { formatDate: () => "2026-10-28" },
};
vm.createContext(context);
vm.runInContext(source, context);
function reset(items) { calls.length=0; responses=items; }
reset([[200,{id:"api-id"}], [200,{}]]);
context.salvarEvento_("tarefas","task","api-id",{summary:"changed"}, id=>({agendaEventoId:id}));
assert.equal(calls[0].method,"patch");
assert(calls[0].url.endsWith("/api-id"));
assert.equal(calls.filter(x=>x.method==="post").length,0);
assert(calls[1].url.includes("currentDocument.exists=true"));
reset([[200,{items:[{id:"api-legacy",status:"confirmed"}]}], [200,{id:"api-legacy"}], [200,{}]]);
context.salvarEvento_("rotinas","routine","old-uid@google.com",{summary:"updated"},id=>({agendaEventoId:id}));
assert(calls[0].url.includes("iCalUID=old-uid%40google.com"));
assert(calls[1].url.endsWith("/api-legacy"));
assert.equal(calls[1].method,"patch");
assert.equal(calls[2].data.fields.agendaEventoId.stringValue,"api-legacy");
reset([[404,{error:"missing"}],[200,{id:"created"}],[200,{}]]);
context.salvarEvento_("tarefas","task","old-id",{summary:"created"},id=>({agendaEventoId:id}));
assert.equal(calls[1].method,"post");
reset([[403,{error:"forbidden"}]]);
assert.throws(()=>context.salvarEvento_("tarefas","task","old-id",{},id=>({agendaEventoId:id})),/Google Agenda 403/);
assert.equal(calls.length,1);
reset([[403,{error:"forbidden"}]]);
assert.throws(()=>context.apagarEventoSeExistir_("api-id"),/Google Agenda 403/);
reset([[410,null]]);
assert.doesNotThrow(()=>context.apagarEventoSeExistir_("api-id"));
reset([[200,{id:"created"}],[404,{error:"document deleted"}],[204,null]]);
assert.throws(()=>context.salvarEvento_("tarefas","deleted",null,{},id=>({agendaEventoId:id})),/Firestore 404/);
assert.equal(calls[2].method,"delete");
assert(calls[2].url.endsWith("/created"));
reset([[200,{items:[{id:"a"},{id:"b"}]}]]);
assert.throws(()=>context.resolverEventoId_("old@google.com"),/mais de um evento/);
const task={titulo:"test",data:"2026-10-28",hora:"23:55",duracaoMin:30,categoriaId:"category"};
const event=context.eventoDaTarefa_(task,()=>"Work");
assert.equal(event.start.dateTime,"2026-10-29T02:55:00.000Z");
assert.equal(event.end.dateTime,"2026-10-29T03:25:00.000Z");
assert.equal(event.reminders.useDefault,false);
assert.deepEqual(Array.from(event.reminders.overrides,x=>x.minutes),[0,10]);
context.conferirContaAgenda_=()=>{};
context.contasOAuth_=()=>[];
context.PropertiesService={getScriptProperties:()=>({getProperty:()=>null})};
context.fsConfigPatch_=()=>{};
context.fsListAll_=()=>[];
context.buscarTarefasRelevantes_=()=>[];
context.sincronizarRotinas_=()=>{throw new Error("read failed");};
assert.throws(()=>context.sincronizarAgendaAppRotina(),/1 conta/);
assert.equal(unlocked,1);
context.sincronizarRotinas_=()=>{vm.runInContext("falhasDaRodada++",context);return 0;};
context.sincronizarTarefasAvulsas_=()=>0;
context.sincronizarAtrasadas_=()=>0;
assert.throws(()=>context.sincronizarAgendaAppRotina(),/1 conta/);
assert.equal(unlocked,2);
console.log("PASS: PATCH existing, legacy ID migration, 404 recreation, 403 stop, safe DELETE, rollback deleted document, ambiguous legacy stop, timezone/reminders, aggregate failures and lock release.");
