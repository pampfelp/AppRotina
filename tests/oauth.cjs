const path = require("node:path");
const fs=require("node:fs"),vm=require("node:vm"),assert=require("node:assert/strict"),crypto=require("node:crypto");
const source=fs.readFileSync(path.join(__dirname,"..","apps-script","Code.gs"),"utf8")+"\n"+fs.readFileSync(path.join(__dirname,"..","apps-script","OAuth.gs"),"utf8");
function load(options={}) {
 const props={GOOGLE_CLIENT_ID:"test-client.apps.googleusercontent.com",GOOGLE_CLIENT_SECRET:"fake-client-secret",OAUTH_REDIRECT_URI:"https://script.google.com/macros/s/test-deployment/exec"};
 const cache=new Map(),requests=[],states=[],syncs=[];let ctx,owner;
 const propertyStore={getProperties:()=>({...props}),getProperty:k=>props[k]||null,setProperty:(k,v)=>{props[k]=v;},deleteProperty:k=>{delete props[k];}};
 const cacheStore={get:k=>cache.get(k)||null,put:(k,v,ttl)=>cache.set(k,v),remove:k=>cache.delete(k)};
 const response=(status,data)=>({getResponseCode:()=>status,getContentText:()=>data===null?"":JSON.stringify(data)});
 ctx={Logger:{log(){}},PropertiesService:{getScriptProperties:()=>propertyStore},CacheService:{getScriptCache:()=>cacheStore},Utilities:{getUuid:()=>crypto.randomUUID(),computeDigest:(algorithm,text)=>Array.from(crypto.createHash("sha256").update(text).digest()),DigestAlgorithm:{SHA_256:"sha256"},Charset:{UTF_8:"utf8"},sleep:n=>assert.equal(n,30000)},ScriptApp:{getOAuthToken:()=>"owner-access-test",getProjectTriggers:()=>options.noTrigger?[]:[{getHandlerFunction:()=>"sincronizarAgendaAppRotina"}]},LockService:{getScriptLock:()=>({tryLock:()=>true,releaseLock(){}})},HtmlService:{createHtmlOutput:html=>({html,setTitle(){return this;}})},UrlFetchApp:{fetch(url,opt){requests.push({url,...opt});
  if(url.includes("accounts:lookup")) { const body=JSON.parse(opt.payload);if(body.idToken==="wife-firebase")return response(200,{users:[{localId:"wife-id",email:"wife@example.invalid",emailVerified:!options.unverified}]});if(body.idToken==="owner-firebase")return response(200,{users:[{localId:"owner-id",email:owner,emailVerified:true}]});return response(400,{error:{message:"RAW_TOKEN_MUST_NOT_LEAK"}}); }
  if(url==="https://oauth2.googleapis.com/token") { const form=new URLSearchParams(opt.payload);if(form.get("refresh_token")==="bad-refresh")return response(400,{error:"invalid_grant",error_description:"RAW_TOKEN_MUST_NOT_LEAK"});if(form.get("grant_type")==="refresh_token")return response(200,{access_token:"access-"+form.get("refresh_token")});return response(200,{access_token:"wife-access-test",refresh_token:"wife-refresh-test"}); }
  if(url.includes("/userinfo"))return response(200,{email:options.wrongGoogle?"different@example.invalid":"wife@example.invalid",email_verified:true});
  if(url==="https://oauth2.googleapis.com/revoke")return response(200,null);
  if(url.endsWith("/calendars/primary"))return response(200,{id:owner});
  if(url.includes("/calendar/v3/"))return response(200,{items:[]});
  if(url.includes("/firestore.")||url.includes("firestore.googleapis.com"))return response(200,{});
  throw new Error("Unexpected endpoint");
 }}};
 vm.createContext(ctx);vm.runInContext(source,ctx);owner=vm.runInContext("EMAIL_DONO",ctx);
 const originalFsConfig=ctx.fsConfigPatch_;
 ctx.fsConfigPatch_=value=>states.push({email:vm.runInContext("emailAgendaAtual",ctx),value});
 ctx.sincronizarRodada_=()=>{syncs.push({email:vm.runInContext("emailAgendaAtual",ctx),token:vm.runInContext("tokenCalendarAtual",ctx)});return 1;};
 const hash=text=>crypto.createHash("sha256").update(text).digest("hex");
 const key=email=>"agenda_oauth_"+hash(email);
 return {ctx,props,cache,requests,states,syncs,owner,key,originalFsConfig};
}
function start(h,token="wife-firebase") {
 const out=h.ctx.doPost({parameter:{action:"conectar",idToken:token,email:"spoofed@example.invalid"}});
 const match=out.html.match(/href="([^"]+)"/);assert(match,"expected authorization link");
 const url=new URL(match[1].replaceAll("&amp;","&"));
 assert.equal(url.origin,"https://accounts.google.com");assert.equal(url.searchParams.get("access_type"),"offline");
 assert(!out.html.includes(token));assert(!out.html.includes("fake-client-secret"));
 return {out,url,state:url.searchParams.get("state")};
}
{
 const h=load(),s=start(h);assert.equal(s.url.searchParams.get("login_hint"),"wife@example.invalid");
 const before=h.requests.length;const blocked=h.ctx.doPost({parameter:{action:"conectar",idToken:"wife-firebase"}});assert(blocked.html.includes("30 segundos"));
 const out=h.ctx.doGet({parameter:{code:"fake-code",state:s.state}});assert(out.html.includes("conectado"));
 assert(h.props[h.key("wife@example.invalid")]);assert.equal(JSON.parse(h.props[h.key("wife@example.invalid")]).refreshToken,"wife-refresh-test");
 assert(h.states.every(x=>x.email==="wife@example.invalid"));assert.equal(h.syncs[0].email,"wife@example.invalid");assert.equal(h.syncs[0].token,"wife-access-test");
 assert(!out.html.includes("wife-access-test"));assert(!out.html.includes("wife-refresh-test"));assert(!out.html.includes("fake-code"));
 const tokenCalls=h.requests.filter(x=>x.url==="https://oauth2.googleapis.com/token").length;
 const replay=h.ctx.doGet({parameter:{code:"fake-code",state:s.state}});assert(replay.html.includes("já foi utilizada"));
 assert.equal(h.requests.filter(x=>x.url==="https://oauth2.googleapis.com/token").length,tokenCalls);
 h.ctx.comContaAgenda_("wife@example.invalid","wife-access-test",true,()=>h.originalFsConfig({servidorAtivo:true}));
 const write=h.requests.at(-1);assert.equal(write.headers.Authorization,"Bearer owner-access-test");assert(write.url.includes("wife%40example.invalid"));
}
{
 const h=load({wrongGoogle:true}),s=start(h),out=h.ctx.doGet({parameter:{code:"fake-code",state:s.state}});
 assert(out.html.includes("diferente"));assert(!h.props[h.key("wife@example.invalid")]);assert.equal(h.states.length,0);assert.equal(h.syncs.length,0);
}
{
 const h=load();const invalid=h.ctx.doPost({parameter:{action:"conectar",idToken:"wrong"}});assert(!invalid.html.includes("RAW_TOKEN_MUST_NOT_LEAK"));assert.equal(h.cache.size,0);
 const unverified=load({unverified:true});const out=unverified.ctx.doPost({parameter:{action:"conectar",idToken:"wife-firebase"}});assert(out.html.includes("confirmado"));assert.equal(unverified.cache.size,0);
}
{
 const h=load({noTrigger:true}),s=start(h),out=h.ctx.doGet({parameter:{code:"fake-code",state:s.state}});
 assert(out.html.includes("instalar o gatilho"));assert.equal(h.states.at(-1).value.servidorAtivo,false);assert.equal(h.syncs.length,0);
}
{
 const h=load();h.props[h.key("wife@example.invalid")]=JSON.stringify({email:"wife@example.invalid",refreshToken:"bad-refresh"});h.props[h.key("friend@example.invalid")]=JSON.stringify({email:"friend@example.invalid",refreshToken:"friend-refresh"});
 assert.throws(()=>h.ctx.sincronizarAgendaAppRotina(),/1 conta/);
 assert(h.syncs.some(x=>x.email===h.owner&&x.token==="owner-access-test"));assert(h.syncs.some(x=>x.email==="friend@example.invalid"&&x.token==="access-friend-refresh"));assert(!h.syncs.some(x=>x.email==="wife@example.invalid"));
 assert(!JSON.stringify(h.states).includes("RAW_TOKEN_MUST_NOT_LEAK"));assert(h.states.some(x=>x.email==="wife@example.invalid"&&x.value.ultimoErro));
}
{
 const h=load();h.props[h.key(h.owner)]=JSON.stringify({email:h.owner,refreshToken:"bad-refresh"});
 assert.throws(()=>h.ctx.sincronizarAgendaAppRotina(),/1 conta/);assert.equal(h.syncs.length,0);assert(!h.requests.some(x=>x.headers&&x.headers.Authorization==="Bearer owner-access-test"));
}
{
 const h=load();h.props[h.key("wife@example.invalid")]=JSON.stringify({email:"wife@example.invalid",refreshToken:"wife-refresh-test"});
 const out=h.ctx.doPost({parameter:{action:"desconectar",idToken:"wife-firebase",email:h.owner}});
 assert(out.html.includes("desconectado"));assert(!h.props[h.key("wife@example.invalid")]);assert(h.requests.some(x=>x.url.endsWith("/revoke")));assert.equal(h.states.at(-1).email,"wife@example.invalid");assert.equal(h.states.at(-1).value.servidorAtivo,false);assert(!h.requests.some(x=>x.method==="delete"));
 const ownerOut=h.ctx.doPost({parameter:{action:"desconectar",idToken:"owner-firebase"}});assert(ownerOut.html.includes("desconectado"));assert.equal(h.props.agenda_owner_desativado,"1");
 h.requests.length=0;assert.equal(h.ctx.sincronizarAgendaAppRotina(),0);assert.equal(h.requests.length,0);
}
{
 const h=load();const out=h.ctx.paginaAgenda_("<script>","A & B <img>","https://accounts.google.com/?a=\"&b=<");assert(out.html.includes("&lt;script&gt;"));assert(out.html.includes("A &amp; B &lt;img&gt;"));assert(!out.html.includes("<img>"));
}
console.log("PASS: Firebase session/email gate; OAuth state replay/rate limit; Google account mismatch; per-user refresh and failure isolation; owner token never used for other calendars; no-trigger status; authenticated disconnect/revocation and owner disable; Firestore always owner IAM; HTML escaping and no token leakage.");
