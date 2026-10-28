import path from "node:path";
import { fileURLToPath } from "node:url";
const pasta = path.dirname(fileURLToPath(import.meta.url));
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
const source=fs.readFileSync(path.resolve(pasta, process.argv[2] || "../agenda.js"),'utf8');
const url='https://script.google.com/macros/s/endpoint-teste/exec';
async function ambiente({servidorURL=url,popupBloqueado=false,trocaConta=false}={}){
  const eventos=[],forms=[],storage=[],toasts=[];
  const auth={currentUser:{uid:'a',email:'teste@example.invalid',emailVerified:true,async getIdToken(){eventos.push('token');if(trocaConta)auth.currentUser={uid:'b',email:'outra@example.invalid'};return 'token-teste';}}};
  const ctx=vm.createContext({console,Intl,Date,URLSearchParams,setTimeout,clearTimeout,
    localStorage:{getItem(){return '1';},setItem(...args){storage.push(args);}},
    window:{open(target){eventos.push('popup:'+target);return popupBloqueado?null:{closed:false,close(){eventos.push('fechar');}};}},
    document:{body:{appendChild(){}},createElement(tag){return {tag,filhos:[],appendChild(campo){this.filhos.push(campo);},submit(){eventos.push('post');forms.push(this);},remove(){this.removido=true;}};}}
  });
  const valores={db:{},auth,GOOGLE_CLIENT_ID:'cliente',AGENDA_SERVIDOR_URL:servidorURL,doc(){},updateDoc(){},getDocFromServer(){},setDoc(){},toast(...args){toasts.push(args);},parseDataLocal(){},hojeISO(){},somarDiasISO(){},isoLocal(){},horaEmMinutos(){}};
  const mod=new vm.SourceTextModule(source,{context:ctx});
  await mod.link(async p=>{
    const nomes=p.includes('firebase-init')?['db','auth',...(p.includes('firebase-init')?['GOOGLE_CLIENT_ID','AGENDA_SERVIDOR_URL']:[])]:p.includes('firebase-firestore')?['doc','updateDoc','getDocFromServer','setDoc']:['toast','parseDataLocal','hojeISO','somarDiasISO','isoLocal','horaEmMinutos'];
    return new vm.SyntheticModule(nomes,function(){for(const nome of nomes)this.setExport(nome,valores[nome]);},{context:ctx});
  });
  await mod.evaluate();
  return {api:mod.namespace,eventos,forms,storage,toasts};
}
{
  const a=await ambiente();
  assert.equal(await a.api.conectarAgendaPermanente(),true);
  assert.deepEqual(a.eventos,['popup:about:blank','token','post']);
  assert.equal(a.forms[0].action,url);
  assert.equal(a.forms[0].method,'POST');
  assert.equal(a.forms[0].target,'rot-agenda-conectar');
  assert.deepEqual(a.forms[0].filhos.map(x=>[x.name,x.value]),[['action','conectar'],['idToken','token-teste']]);
  assert.equal(a.forms[0].removido,true);
  assert.equal(a.storage.length,0);
}
for(const servidorURL of ['', 'https://script.google.com.evil.invalid/macros/s/id/exec','https://script.google.com/macros/s/id/exec?x=1']){
  const a=await ambiente({servidorURL});
  assert.equal(await a.api.conectarAgendaPermanente(),false);
  assert.equal(a.eventos.length,0);
}
{
  const a=await ambiente({popupBloqueado:true});
  assert.equal(await a.api.conectarAgendaPermanente(),false);
  assert.deepEqual(a.eventos,['popup:about:blank']);
  assert.equal(a.forms.length,0);
  assert.match(a.toasts[0][0],/Safari/);
}
{
  const a=await ambiente({trocaConta:true});
  assert.equal(await a.api.conectarAgendaPermanente(),false);
  assert.equal(a.forms.length,0);
  assert.ok(a.eventos.includes('fechar'));
}
console.log('PASS: POST, popup antes do token, URL estrita, token não persistido, popup bloqueado e troca de conta.');
