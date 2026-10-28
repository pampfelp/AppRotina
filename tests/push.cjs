const path = require("node:path");
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const crypto = require('node:crypto');
const root = path.join(__dirname, '..') + path.sep;
const script = fs.readFileSync(root+'apps-script/Notificacoes.gs','utf8');
new vm.Script(script);
const hora = Date.parse('2026-10-28T13:00:00Z');
function servidor(tipo = 'sucesso') {
  let now = hora, enviados = 0, leituras = 0, apagados = 0;
  const props = new Map(), cache = new Map(), marcas = new Map();
  const base = 'https://firestore.googleapis.com/v1/projects/test/databases/(default)/documents';
  const rotina = {__id:'rot1',nome:'Rotina',hora:'10:00',ativa:true,diasSemana:[3]};
  const manual = {__id:'tar1',titulo:'Tarefa',hora:'10:00',data:'2026-10-28',estado:'pendente',origem:'manual'};
  const atrasada = {__id:'tar2',titulo:'Atrasada',hora:'10:00',data:'2026-10-27',estado:'pendente',origem:'rotina'};
  const fontes = new Map([[base+'/usuarios/pessoa%40example.com/rotinas/rot1',rotina],[base+'/usuarios/pessoa%40example.com/tarefas/tar1',manual],[base+'/usuarios/pessoa%40example.com/tarefas/tar2',atrasada]]);
  class Clock extends Date { static now(){return now;} }
  const context = {
    Date:Clock,Intl,JSON,Number,String,Object,Array,Math,Error,encodeURIComponent,decodeURIComponent,
    FIRESTORE_BASE:base,FIREBASE_PROJECT_ID:'test',
    ScriptApp:{getOAuthToken:()=> 'token-de-teste'},
    CacheService:{getScriptCache:()=>({get:k=>cache.get(k),put:(k,v)=>cache.set(k,v),remove:k=>cache.delete(k)})},
    PropertiesService:{getScriptProperties:()=>({getProperty:k=>props.get(k),setProperty:(k,v)=>props.set(k,v)})},
    LockService:{getScriptLock:()=>({tryLock:()=>true,releaseLock:()=>{}})},
    Utilities:{DigestAlgorithm:{SHA_256:'sha256'},Charset:{UTF_8:'utf8'},computeDigest:(_,s)=>Array.from(crypto.createHash('sha256').update(s).digest()),formatDate:(d,tz,format)=> {
      const f = new Intl.DateTimeFormat('en-CA',{timeZone:tz,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(d).reduce((a,p)=>(a[p.type]=p.value,a),{});
      return format==='yyyy-MM-dd'?`${f.year}-${f.month}-${f.day}`:`${f.hour}:${f.minute}`;
    }},
    Logger:{log:()=>{}},
    UrlFetchApp:{fetch:()=>{enviados++;return {getResponseCode:()=>tipo==='sucesso'?200:404,getContentText:()=>JSON.stringify({error:{details:tipo==='invalido'?[{errorCode:'UNREGISTERED'}]:[]}})};}},
    paraValorFirestore_:v=>v,fsDocParaObjeto_:v=>v,
    fsFetch_:(url,opts={})=> {
      if(opts.method==='delete'){apagados++;return {};}
      if(opts.method==='patch'){marcas.set(url,opts.payload.fields);return {};}
      if(url.endsWith(':runQuery')) {
        const coll = opts.payload.structuredQuery.from[0].collectionId;
        if(coll==='pushTokens')return [{document:{__id:'device1',name:'projects/test/databases/(default)/documents/usuarios/pessoa@example.com/pushTokens/device1',token:'fcm-test',fuso:'America/Sao_Paulo'}}];
        return (coll==='rotinas'?[rotina]:[manual,atrasada]).map(document=>({document}));
      }
      leituras++;
      if(fontes.has(url)) return fontes.get(url);
      if(marcas.has(url)) return marcas.get(url);
      throw new Error('Firestore 404: ausente');
    }
  };
  vm.createContext(context);vm.runInContext(script,context);
  return {context,rotina,manual,atrasada,run:()=>context.enviarLembretesAppRotina(),step:ms=>now+=ms,stats:()=>({enviados,leituras,apagados}),marcas,cache,props};
}
{
 const s=servidor();s.run();assert.equal(s.stats().enviados,3);assert.equal(s.marcas.size,3);
 s.step(60000);s.run();assert.equal(s.stats().enviados,3,'segunda rodada não repete os avisos entregues');
 assert.equal(s.context.pushConfereOcorrencia_(s.rotina,'rotina','2026-10-29','10:00'),false,'dia da semana');
 assert.equal(s.context.pushConfereOcorrencia_({...s.manual,estado:'concluida'},'manual','2026-10-28','10:00'),false,'concluída não avisa');
 assert.equal(s.context.pushConfereOcorrencia_({...s.manual,hora:'11:00'},'manual','2026-10-28','10:00'),false,'horário editado não avisa');
 assert.equal(s.context.pushConfereOcorrencia_({...s.manual,origem:'rotina'},'manual','2026-10-28','10:00'),false,'atividade de rotina não duplica aviso');
 assert.equal(s.context.pushFuso_('fuso-invalido'),'America/Sao_Paulo');
}
{
 const s=servidor();const snapshot={rotinas:[{...s.rotina}],tarefas:[{...s.manual},{...s.atrasada}]};
 s.cache.set('rot-push-dados-'+s.context.pushHash_('pessoa@example.com'),JSON.stringify(snapshot));
 s.rotina.ativa=false;s.manual.estado='concluida';s.atrasada.hora='11:00';s.run();assert.equal(s.stats().enviados,0,'fonte fresca impede aviso de snapshot antigo');
}
{
 const s=servidor('invalido');s.run();assert.equal(s.stats().apagados,1,'remove apenas inscrição UNREGISTERED');assert.equal(s.marcas.size,0);
 const f=servidor('falha');assert.throws(()=>f.run(),/lembrete/);assert.equal(f.stats().apagados,0,'404 genérico não exclui token');assert.equal(f.props.has('push_ultima_rodada'),false,'erro permite recuperar janela');
}
{
 const handlers={},visiveis=[],abertas=[];
 const contexto={URL,self:{location:{href:'https://example.com/AppRotina/service-worker.js',origin:'https://example.com'},registration:{scope:'https://example.com/',showNotification:(titulo,opcoes)=>{visiveis.push({titulo,opcoes});return Promise.resolve();}},clients:{matchAll:()=>Promise.resolve([{url:'https://example.com/SolarGreen-ERP/',focus:()=>{throw Error('não focar ERP');}}]),openWindow:url=>{abertas.push(url);return Promise.resolve();}},addEventListener:(n,f)=>handlers[n]=f},caches:{},fetch:()=>{},Response:{}};
 vm.createContext(contexto);vm.runInContext(fs.readFileSync(root+'service-worker.js','utf8'),contexto);
 assert.equal(contexto.destinoDaNotificacao('https://outside.example/'),'https://example.com/AppRotina/index.html');
 assert.equal(contexto.destinoDaNotificacao('../SolarGreen-ERP/'),'https://example.com/AppRotina/index.html');
 assert.equal(contexto.destinoDaNotificacao('index.html#hoje'),'https://example.com/AppRotina/index.html#hoje');
 let promessa;handlers.push({data:{json:()=>({data:{titulo:'Aviso',corpo:'Teste',url:'../SolarGreen-ERP/'}})},waitUntil:p=>promessa=p});
 assert.equal(visiveis.length,1,'push sempre mostra notificação');
 handlers.notificationclick({notification:{close:()=>{},data:visiveis[0].opcoes.data},waitUntil:p=>promessa=p});
 Promise.resolve(promessa).then(()=>assert.equal(abertas[0],'https://example.com/AppRotina/index.html'));
}
(async()=> {
 const js=fs.readFileSync(root+'push.js','utf8').replace(/^import .*;\r?\n/gm,'').replace(/export /g,'');
 let pedidos=0,apagouToken=0,gravacoes=[],apagouDoc=0;const local=new Map();
 const user={uid:'uid1',email:'pessoa@example.com',emailVerified:true};
 const context={auth:{currentUser:user},db:{},getApp:()=>({}),getMessaging:()=>({}),getToken:async()=> 'fcm-token-nao-persistir',deleteToken:async()=>{apagouToken++;},isSupported:async()=>true,
 doc:(_, ...p)=>p.join('/'),getDocFromServer:async()=>({data:()=>({vapidKey:'A'.repeat(87)})}),setDoc:async(r,d)=>gravacoes.push({r,d}),deleteDoc:async()=>{apagouDoc++;},crypto:crypto.webcrypto,TextEncoder,
 navigator:{userAgent:'Chrome',platform:'Win32',maxTouchPoints:0,serviceWorker:{ready:Promise.resolve({})}},window:{Notification:{},PushManager:{},matchMedia:()=>({matches:false})},
 Notification:{permission:'default',requestPermission:()=>{pedidos++;context.Notification.permission='granted';return Promise.resolve('granted');}},localStorage:{getItem:k=>local.get(k),setItem:(k,v)=>local.set(k,v),removeItem:k=>local.delete(k)},Intl,Promise,Set,Array,String,Date};
 vm.createContext(context);vm.runInContext(js,context);await context.carregarPush(user);assert.equal(pedidos,0,'carregar não pede permissão');
 const ativando=context.ativarPush();assert.equal(pedidos,1,'permissão é pedida diretamente antes de await');assert.equal(await ativando,true);assert.equal(gravacoes.length,1);assert.equal(context.diagnosticoPush().ativa,true);
 assert(!JSON.stringify([...local]).includes('fcm-token'),'token não vai ao localStorage');
 assert.equal(local.get('rot_push_optin'),user.uid,'opt-in só após ativação explícita bem sucedida');
 await context.desativarPush();assert.equal(apagouDoc,1);assert(apagouToken>=2);assert.equal(context.diagnosticoPush().ativa,false);
 assert.equal(local.has('rot_push_optin'),false,'desativar remove preferência');
 await context.carregarPush(user);assert.equal(gravacoes.length,1,'reload após desativar não registra');assert.equal(context.diagnosticoPush().ativa,false);
 assert.equal(await context.ativarPush(),true,'pode reativar na mesma sessão');assert.equal(gravacoes.length,2);assert.equal(local.get('rot_push_optin'),user.uid);
 let falhaDelete=true;context.deleteDoc=async()=>{if(falhaDelete)throw Error('offline');apagouDoc++;};
 await assert.rejects(()=>context.desativarPush(),/offline/);assert.equal(context.diagnosticoPush().ativa,true,'falha não anuncia desativado');
 assert.match(context.diagnosticoPush().mensagem,/Não foi possível/);assert.equal(local.has('rot_push_optin'),false);
 falhaDelete=false;await context.desativarPush();assert.equal(apagouDoc,2,'ref preservada permite retry');assert.equal(context.diagnosticoPush().ativa,false);
 assert.equal(await context.ativarPush(),true,'reativa diretamente após desativar sem recarregar');assert.equal(gravacoes.length,3);
 console.log('OK: backend horários/dedup/revalidação/falhas, SW escopo e notificação, cliente permissão síncrona e desativação.');
})().catch(e=>{console.error(e);process.exitCode=1;});
