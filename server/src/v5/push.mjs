// SPDX-License-Identifier: AGPL-3.0-only
// APNs push (token-based, .p8). OFF unless KIPURSE_APNS_KEY_FILE + KIPURSE_APNS_KEY_ID + KIPURSE_APNS_TEAM_ID are set (owner creates the key in
// Apple Developer and puts the file on the server himself). The key is read only inside this process to sign the JWT; never logged or returned.
// Payloads carry no secrets and no full addresses: name + amount + an id the app resolves after Face ID. In-app cards stay the fallback.
import {readFileSync} from 'node:fs';import {createPrivateKey,sign} from 'node:crypto';import http2 from 'node:http2';
const b64u=b=>Buffer.from(b).toString('base64url');
export function apnsConfigFromEnv(env=process.env){const keyFile=env.APNS_KEY_PATH??env.KIPURSE_APNS_KEY_FILE,keyId=env.APNS_KEY_ID??env.KIPURSE_APNS_KEY_ID,teamId=env.APNS_TEAM_ID??env.KIPURSE_APNS_TEAM_ID;
  if(!keyFile||!keyId||!teamId)return null;return {keyFile,keyId,teamId,topic:env.APNS_TOPIC??env.KIPURSE_APNS_TOPIC??'org.example.kipurse.app'};}
/** tokens: {list():string[], add(t), remove(t)} per wallet. */
export function createPush({config,log=()=>{},connect=http2.connect,now=()=>Date.now()}={}){
  let jwt=null,jwtAt=0,key=null;
  const enabled=!!config;
  function token(){if(jwt&&now()-jwtAt<40*60e3)return jwt;key??=createPrivateKey(readFileSync(config.keyFile));
    const h=b64u(JSON.stringify({alg:'ES256',kid:config.keyId})),p=b64u(JSON.stringify({iss:config.teamId,iat:Math.floor(now()/1000)}));
    const s=sign('sha256',Buffer.from(h+'.'+p),{key,dsaEncoding:'ieee-p1363'});jwt=h+'.'+p+'.'+b64u(s);jwtAt=now();return jwt;}
  async function sendOne(dev,payload,{priority=10,collapseId,sandbox=false}={}){return new Promise(res=>{let c;try{c=connect(sandbox?'https://api.sandbox.push.apple.com':'https://api.push.apple.com');}catch(e){return res({ok:false,error:'connect'});}
    c.on('error',()=>res({ok:false,error:'connect'}));
    const r=c.request({':method':'POST',':path':'/3/device/'+dev,authorization:'bearer '+token(),'apns-topic':config.topic,'apns-push-type':'alert','apns-priority':String(priority),...(collapseId?{'apns-collapse-id':collapseId}:{})});
    let st=0,body='';r.on('response',h=>{st=h[':status'];});r.on('data',d=>{body+=d;});r.on('end',()=>{try{c.close();}catch{}res({ok:st===200,status:st,reason:st===200?null:(()=>{try{return JSON.parse(body).reason;}catch{return null;}})()});});
    r.on('error',()=>{try{c.close();}catch{}res({ok:false,error:'stream'});});r.end(JSON.stringify(payload));});}
  /** event -> APNs payload (zh/en by device lang). kinds: payee_confirm, hold, anomaly, summary */
  function payloadFor(ev,lang='zh'){const zh=lang!=='en';const t=(a,b)=>zh?a:b;let alert,cat,extra={};
    if(ev.kind==='payee_confirm'){const sh=ev.payee?String(ev.payee).slice(0,6)+'…'+String(ev.payee).slice(-4):'';const nm=ev.name?String(ev.name).replace(/[\u0000-\u001f]/g,' ').slice(0,30):null;/* anti-phishing: server wording; the AI's name is quoted + marked unverified */
      alert={title:t('⚠️ 新收款方，AI 可能被骗','⚠️ New payee, the AI could be tricked'),body:t(`付 ${ev.amount} USDC 给未核实的新地址 ${sh}`+(nm?`（AI 称“${nm}”，未核实）`:'')+'。确认是你本人要付的人，再用 Face ID 批准。',`${ev.amount} USDC to an unverified new address ${sh}`+(nm?` (the AI calls it "${nm}", not verified)`:'')+'. Approve with Face ID only if you yourself want to pay them.')};cat='KP_PAYEE_CONFIRM';extra={trustRequestId:ev.id};}
    else if(ev.kind==='hold'){alert={title:t('大额付款 10 分钟后执行','Large payment in 10 minutes'),body:t(`${ev.amount} USDC 给 ${ev.name}。不想付就点“取消付款”。`,`${ev.amount} USDC to ${ev.name}. Tap Cancel payment to stop it.`)};cat='KP_HOLD';extra={holdId:ev.id};}
    else if(ev.kind==='anomaly'){alert={title:t('AI 付款已自动暂停','AI payments paused'),body:t('发现异常，已为你暂停。打开 App 用 Face ID 恢复。','Something looked unusual, so payments were paused. Open the app to resume with Face ID.')};cat='KP_ANOMALY';extra={anomaly:ev.reason};}
    else if(ev.kind==='owner_ask'){alert={title:ev.dup?t('疑似重复购买，还要再付一次吗？','Possible duplicate purchase - pay again?'):t('认识这个收款方吗？（AI 可能被骗）','Do you know this payee? (the AI could be tricked)'),body:t(ev.zh||'打开 Kipurse 查看完整地址，再选「认识并信任」或「只付这一次」并用 Face ID 确认。',ev.en||'Open Kipurse to see the full address, then choose Trust or Pay just this once and confirm with Face ID.')};cat='KP_ASK';extra={approvalId:ev.id};}/* t1170u §6#82 */
    /* t1241 §6#111: layered merchant trust - every auto-payment, and a merchant paused for auto-pay (it did not confirm a payment) */
    else if(ev.kind==='auto_paid'){const dm=String(ev.domain??'').replace(/[^a-z0-9.-]/gi,'').slice(0,60);const amt=String(ev.amount??'').replace(/[^0-9.]/g,'').slice(0,20);alert={title:t('已自动付款','Paid automatically'),body:t(`已自动付 ${amt} USDC 给 ${dm}（你信任的商家，在额度内）。`,`Paid ${amt} USDC to ${dm} automatically (a merchant you trust, within your limits).`)};cat='KP_AUTOPAID';extra={domain:dm};}
    else if(ev.kind==='merchant_paused'){const dm=String(ev.domain??'').replace(/[^a-z0-9.-]/gi,'').slice(0,60);alert={title:t('已暂停自动付给 '+dm,'Auto-pay to '+dm+' paused'),body:t(`${dm} 没有确认收到付款，已暂停给它自动付款。下一单会先问你；打开 Kipurse 查看。`,`${dm} did not confirm a payment, so automatic payments to it are paused. Its next order will ask you first; open Kipurse to check.`)};cat='KP_MERCHANT_PAUSED';extra={domain:dm};}
    else if(ev.kind==='mandate'){alert={title:t('AI 请求付款 / 额度（AI 可能被骗）','AI payment request (the AI could be tricked)'),body:t(ev.zh??'打开 Kipurse 查看并用 Face ID 同意。',ev.en??'Open Kipurse to review and approve with Face ID.')};cat='KP_MANDATE';extra={approvalId:ev.id};}
    else {alert={title:t('今日花费','Today\'s spending'),body:ev.text??''};cat='KP_SUMMARY';}
    return {aps:{alert,sound:'default',category:cat,'interruption-level':ev.kind==='summary'?'passive':'time-sensitive'},kp:{kind:ev.kind,...extra}};}
  /** Xcode/TestFlight-dev builds get sandbox tokens, App Store builds production ones: try the remembered env, else production then sandbox. */
  // t1208u §6#94: one log line per APNs attempt (kind, production|sandbox, HTTP status, APNs reason word) - the device token is never logged.
  const word=v=>typeof v==='string'&&/^[A-Za-z]{1,40}$/.test(v)?v:(v==null?null:'other');
  const logAttempt=(kind,env,r)=>{try{log('push_attempt',{kind,env,sent:r?.ok?1:0,apnsStatus:Number.isInteger(r?.status)?r.status:null,apnsReason:word(r?.reason??r?.error??null)});}catch{}};
  async function sendAuto(d,payload,opt,kind){const order=d.env==='sandbox'?[true,false]:[false,true];let last;
    for(const sb of order){const r=await sendOne(d.token,payload,{...opt,sandbox:sb}).catch(()=>({ok:false,error:'send'}));logAttempt(kind,sb?'sandbox':'production',r);last=r;if(r.ok)return {...r,env:sb?'sandbox':'production'};if(r.reason!=='BadDeviceToken')return r;}return last;}
  /** A token APNs says can never work for this app (bad/unregistered, or issued for another app id) is dropped. */
  const DEAD=r=>r?.status===410||['BadDeviceToken','Unregistered','DeviceTokenNotForTopic'].includes(r?.reason);
  async function notify(tokens,ev){if(!enabled)return {sent:0,disabled:true};let sent=0,failed=0,removed=0;const list=tokens.list();
    for(const d of list){const r=await sendAuto(d,payloadFor(ev,d.lang),{collapseId:(ev.kind+':'+(ev.id??'')).slice(0,60)},ev.kind);
      if(r?.ok){sent++;if(r.env!==d.env)tokens.setEnv?.(d.token,r.env);}else{failed++;if(DEAD(r)){tokens.remove(d.token);removed++;}}}
    try{log('push',{kind:ev.kind,sent,failed,removed,count:list.length});}catch{}return {sent,failed,removed};}
  /** Auth self-check without a real device: a fake token must answer BadDeviceToken (auth OK), not 403 InvalidProviderToken. Returns status/reason only. */
  async function selfTest(){if(!enabled)return {enabled:false};const out={};for(const sb of [false,true]){const r=await sendOne('0'.repeat(64),{aps:{alert:'test'}},{sandbox:sb}).catch(e=>({ok:false,error:String(e?.code??'error')}));out[sb?'sandbox':'production']={status:r.status??null,reason:r.reason??r.error??null};}return out;}
  return {enabled,notify,payloadFor,selfTest};}
