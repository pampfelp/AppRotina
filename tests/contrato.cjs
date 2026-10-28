const path = require("node:path");
const fs=require("node:fs"), vm=require("node:vm"), assert=require("node:assert/strict");
const source=fs.readFileSync(path.join(__dirname,"..","apps-script","Code.gs"),"utf8");
function load() {
 const ctx={Logger:{log(){}},ScriptApp:{getOAuthToken:()=>"fake"},Utilities:{sleep(){}},LockService:{getScriptLock:()=>({tryLock:()=>true,releaseLock(){}})}};
 vm.createContext(ctx); vm.runInContext(source,ctx); ctx.conferirContaAgenda_=()=>{}; ctx.contasOAuth_=()=>[]; ctx.PropertiesService={getScriptProperties:()=>({getProperty:()=>null,deleteProperty(){}})}; return ctx;
}
{
 const c=load(), requests=[];
 c.fsListAll_=()=>[{__id:"delete-id",agendaEventoId:"event",agendaAtrasoId:"overdue"}];
 c.apagarEventoSeExistir_=id=>requests.push(id);
 c.fsFetch_=(url,opt)=>requests.push(opt.method);
 assert.equal(c.sincronizarExclusoes_(),1);
 assert.deepEqual(requests,["event","overdue","delete"]);
 requests.length=0;
 c.apagarEventoSeExistir_=()=>{throw new Error("403 denied");};
 assert.equal(c.sincronizarExclusoes_(),0);
 assert.equal(requests.length,0,"queue must survive failed calendar delete");
 assert.equal(vm.runInContext("falhasDaRodada",c),1);
}
{
 const c=load(), statuses=[]; let unlocks=0;
 c.LockService.getScriptLock=()=>({tryLock:()=>true,releaseLock:()=>unlocks++});
 c.fsConfigPatch_=v=>statuses.push(v);
 c.fsListAll_=()=>[];c.buscarTarefasRelevantes_=()=>[];c.hojeISO_=()=>"2026-10-28";
 assert.equal(c.sincronizarAgendaAppRotina(),0);
 assert(statuses[0].servidorAtivo && statuses[0].ultimaSinc>0 && statuses[0].ultimoErro==="");
 assert.equal(statuses[0].versao,13);
 statuses.length=0;
 c.fsListAll_=()=>{throw new Error("upstream refused");};
 assert.throws(()=>c.sincronizarAgendaAppRotina(),/1 conta/);
 assert.equal(statuses.length,1);assert.equal(statuses[0].ultimoErro,"A sincronização não foi concluída. Consulte a execução do servidor.");assert(!("ultimaSinc" in statuses[0]));
 assert.equal(unlocks,2);
}
{
 const c=load(), order=[];let triggers=[];
 c.ScriptApp.getProjectTriggers=()=>triggers;
 c.ScriptApp.newTrigger=name=>({timeBased(){return this;},everyMinutes(n){assert.equal(n,15);return this;},create(){order.push("trigger");triggers.push({getHandlerFunction:()=>name});}});
 c.ScriptApp.deleteTrigger=t=>{triggers=triggers.filter(x=>x!==t);};
 c.fsConfigPatch_=v=>order.push(v.servidorAtivo===false?"disabled":"status");
 c.Utilities.sleep=n=>{assert.equal(n,30000);order.push("wait");};
 c.sincronizarRodada_=()=>order.push("sync");
 c.instalarGatilho();
 assert.deepEqual(order,["status","wait","sync","trigger"]);
 c.instalarGatilho();assert.equal(triggers.length,1,"reinstallation must retain one trigger");
 triggers=[];order.length=0;
 c.sincronizarRodada_=()=>{throw new Error("sync failed");};
 assert.throws(()=>c.instalarGatilho(),/sync failed/);
 assert.equal(triggers.length,0);assert.equal(order.at(-1),"disabled");
}
{
 const c=load();let invoked=false;
 c.LockService.getScriptLock=()=>({tryLock:()=>false,releaseLock(){throw new Error("unexpected release");}});
 c.sincronizarRodada_=()=>{invoked=true;};
 assert.throws(()=>c.sincronizarAgendaAppRotina(),/andamento/);
 assert.equal(invoked,false);
}
console.log("PASS: delete queue ordering/retry; success/error status; installation transition and trigger idempotency; failed first install rollback; script lock exclusion.");

{
 let writes=0;
 const c={ScriptApp:{getOAuthToken:()=>"fake",getProjectTriggers:()=>[]},Logger:{log(){}},LockService:{getScriptLock:()=>({tryLock:()=>true,releaseLock(){}})},UrlFetchApp:{fetch(url,opt){assert(url.endsWith("/calendars/primary"));assert.equal(opt.method,"get");return{getResponseCode:()=>200,getContentText:()=>JSON.stringify({id:"wrong-account@example.invalid"})};}}};
 vm.createContext(c);vm.runInContext(source,c);c.fsConfigPatch_=()=>writes++;
 assert.throws(()=>c.instalarGatilho(),/conta Google/);assert.equal(writes,0,"wrong account must not change operational state");
 c.contasOAuth_=()=>[]; c.PropertiesService={getScriptProperties:()=>({getProperty:()=>null})}; assert.throws(()=>c.sincronizarAgendaAppRotina(),/1 conta/);
 console.log("PASS: primary calendar account validation before writes.");
}

