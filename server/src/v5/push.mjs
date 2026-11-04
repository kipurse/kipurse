// SPDX-License-Identifier: AGPL-3.0-only
// APNs push (token-based, .p8). OFF unless KIPURSE_APNS_KEY_FILE + KIPURSE_APNS_KEY_ID + KIPURSE_APNS_TEAM_ID are set (owner creates the key in
// Apple Developer and puts the file on the server himself). The key is read only inside this process to sign the JWT; never logged or returned.
// Payloads carry no secrets and no full addresses: name + amount + an id the app resolves after Face ID. In-app cards stay the fallback.
import {readFileSync} from 'node:fs';import {createPrivateKey,sign} from 'node:crypto';import http2 from 'node:http2';
const b64u=b=>Buffer.from(b).toString('base64url');
export function apnsConfigFromEnv(env=process.env){const keyFile=env.APNS_KEY_PATH??env.KIPURSE_APNS_KEY_FILE,keyId=env.APNS_KEY_ID??env.KIPURSE_APNS_KEY_ID,teamId=env.APNS_TEAM_ID??env.KIPURSE_APNS_TEAM_ID;
  if(!keyFile||!keyId||!teamId)return null;return {keyFile,keyId,teamId,topic:env.APNS_TOPIC??env.KIPURSE_APNS_TOPIC??'com.blessbridge.kipurse.app'};}
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
    else if(ev.kind==='mandate'){alert={title:t('AI 请求付款 / 额度（AI 可能被骗）','AI payment request (the AI could be tricked)'),body:t(ev.zh??'打开 Kipurse 查看并用 Face ID 同意。',ev.en??'Open Kipurse to review and approve with Face ID.')};cat='KP_MANDATE';extra={approvalId:ev.id};}
    else {alert={title:t('今日花费','Today\'s spending'),body:ev.text??''};cat='KP_SUMMARY';}
    return {aps:{alert,sound:'default',category:cat,'interruption-level':ev.kind==='summary'?'passive':'time-sensitive'},kp:{kind:ev.kind,...extra}};}
  /** Xcode/TestFlight-dev builds get sandbox tokens, App Store builds production ones: try the remembered env, else production then sandbox. */
  async function sendAuto(d,payload,opt){const order=d.env==='sandbox'?[true,false]:[false,true];let last;
    for(const sb of order){const r=await sendOne(d.token,payload,{...opt,sandbox:sb}).catch(()=>({ok:false}));last=r;if(r.ok)return {...r,env:sb?'sandbox':'production'};if(r.reason!=='BadDeviceToken')return r;}return last;}
  async function notify(tokens,ev){if(!enabled)return {sent:0,disabled:true};let sent=0;
    for(const d of tokens.list()){const r=await sendAuto(d,payloadFor(ev,d.lang),{collapseId:(ev.kind+':'+(ev.id??'')).slice(0,60)});
      if(r?.ok){sent++;if(r.env!==d.env)tokens.setEnv?.(d.token,r.env);}else if(r?.status===410||r?.reason==='BadDeviceToken'||r?.reason==='Unregistered')tokens.remove(d.token);}
    try{log('push',{kind:ev.kind,sent});}catch{}return {sent};}
  /** Auth self-check without a real device: a fake token must answer BadDeviceToken (auth OK), not 403 InvalidProviderToken. Returns status/reason only. */
  async function selfTest(){if(!enabled)return {enabled:false};const out={};for(const sb of [false,true]){const r=await sendOne('0'.repeat(64),{aps:{alert:'test'}},{sandbox:sb}).catch(e=>({ok:false,error:String(e?.code??'error')}));out[sb?'sandbox':'production']={status:r.status??null,reason:r.reason??r.error??null};}return out;}
  return {enabled,notify,payloadFor,selfTest};}
