import path from "node:path";
import { fileURLToPath } from "node:url";
const pasta = path.dirname(fileURLToPath(import.meta.url));
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
const source=fs.readFileSync(path.resolve(pasta, process.argv[2] || "../agenda.js"),'utf8');
async function conectar({emailGoogle='teste@example.invalid',verificado=true,escopo=true,trocarDurante=false}={}){
  let config,contaGoogleConsultada=0,pedido;
  const auth={currentUser:{uid:'a',email:'teste@example.invalid'}};
  const cliente={requestAccessToken(opts){pedido=opts;cliente.callback({access_token:'google-teste',scope:escopo?'https://www.googleapis.com/auth/calendar.events openid email':'openid email',expires_in:3600});}};
  const ctx=vm.createContext({console,Intl,Date,URLSearchParams,setTimeout,clearTimeout,
    localStorage:{getItem(){return '1';},setItem(){}},
    window:{google:{accounts:{oauth2:{initTokenClient(c){config=c;return cliente;}}}}},
    async fetch(url){assert.equal(url,'https://openidconnect.googleapis.com/v1/userinfo');contaGoogleConsultada++;if(trocarDurante)auth.currentUser={uid:'b',email:'outra@example.invalid'};return {ok:true,json:async()=>({email:emailGoogle,email_verified:verificado})};}
  });
  const vals={db:{},auth,GOOGLE_CLIENT_ID:'cliente',AGENDA_SERVIDOR_URL:'',doc(){},updateDoc(){},getDocFromServer:async()=>({exists:()=>false}),setDoc(){},toast(){},parseDataLocal(){},hojeISO(){},somarDiasISO(){},isoLocal(){},horaEmMinutos(){}};
  const mod=new vm.SourceTextModule(source,{context:ctx});
  await mod.link(async p=>{
    const nomes=p.includes('firebase-init')?['db','auth','GOOGLE_CLIENT_ID','AGENDA_SERVIDOR_URL']:p.includes('firebase-firestore')?['doc','updateDoc','getDocFromServer','setDoc']:['toast','parseDataLocal','hojeISO','somarDiasISO','isoLocal','horaEmMinutos'];
    return new vm.SyntheticModule(nomes,function(){for(const nome of nomes)this.setExport(nome,vals[nome]);},{context:ctx});
  });
  await mod.evaluate();
  await mod.namespace.carregarStatusAgenda('teste@example.invalid');
  const aceito=await mod.namespace.conectarAgenda();
  assert.match(config.scope,/openid email/);
  assert.equal(pedido.login_hint,'teste@example.invalid');
  return {aceito,conectada:mod.namespace.diagnosticoAgenda().conectada,contaGoogleConsultada};
}
assert.equal((await conectar()).aceito,true);
for(const opts of [{emailGoogle:'outra@example.invalid'},{verificado:false},{escopo:false},{trocarDurante:true}]){
  const r=await conectar(opts);
  assert.equal(r.aceito,false);
  assert.equal(r.conectada,false);
}
console.log('PASS: conta Google correta, conta diferente, e-mail não confirmado, permissão recusada e troca da sessão durante validação.');
