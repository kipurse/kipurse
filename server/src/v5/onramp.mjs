// COINBASE ONRAMP (buy USDC with Apple Pay / debit card) into the owner's OWN Kipurse wallet on Base.
// Off unless KIPURSE_ONRAMP_ENABLED=1 AND the key file KIPURSE_ONRAMP_KEY_FILE exists (CDP Secret API key JSON: {id|name, privateKey}).
// The key is read only to sign a request JWT; never logged, returned or kept.
// Destination is ALWAYS the wallet the phone session belongs to; the client cannot pass an address. Only USDC on base.
// HONESTY (owner 2026-10-27 t565u): a purchase is only "arrived" after it is verified (Coinbase send tx to THIS wallet, or the
// wallet's USDC balance went up). A buyer signed in to Coinbase may end with the coins in the Coinbase account: we say so.
import {readFileSync,existsSync} from 'node:fs';import {randomBytes} from 'node:crypto';
export const ONRAMP_HOST='api.developer.coinbase.com',ONRAMP_PATH='/onramp/v1/token',PAY_URL='https://pay.coinbase.com/buy/select-asset';
const ADDR=/^0x[0-9a-fA-F]{40}$/,REF=/^kp-[0-9a-f]{24}$/;const lc=s=>String(s??'').toLowerCase();
export const mask=a=>ADDR.test(String(a??''))?a.slice(0,6)+'…'+a.slice(-4):'?';
export function onrampStatus(env=process.env){const f=env.KIPURSE_ONRAMP_KEY_FILE;const on=env.KIPURSE_ONRAMP_ENABLED==='1';
  return {enabled:on&&!!f&&existsSync(f),flag:on,keyFile:!!f&&existsSync(f)};}
export function buyUrl(token,{amount,redirectUrl,ref,experience}={}){const q=new URLSearchParams({sessionToken:token,defaultNetwork:'base',defaultAsset:'USDC',fiatCurrency:'USD'});
  if(experience==='send'||experience==='buy')q.set('defaultExperience',experience);// t864: 'send' = transfer from the user's own Coinbase balance
  if(ref&&REF.test(ref))q.set('partnerUserRef',ref);
  const a=Number(amount);if(Number.isFinite(a)&&a>0&&a<=10000)q.set('presetFiatAmount',String(Math.round(a*100)/100));
  if(redirectUrl&&/^kipurse:\/\/deposit-done(\?|$)/.test(redirectUrl))q.set('redirectUrl',redirectUrl+(ref?(redirectUrl.includes('?')?'&':'?')+'onramp='+ref:''));return PAY_URL+'?'+q.toString();}
const CB_BUY='https://www.coinbase.com/buy/usdc';
const fallback=(why)=>({ok:false,configured:false,error:why,fallbackUrl:CB_BUY});
const val=x=>typeof x==='object'&&x?String(x.value??''):String(x??'');
/** Map Coinbase's transaction list + our balance check to one honest state. Pure; exported for tests. */
export function classify({wallet,txs=[],balBefore,balNow,ageMs=0}){
  const t=txs[0];const W=lc(wallet);
  if(t){const st=String(t.status??'');const to=lc(t.wallet_address??t.to_address);const amt=val(t.purchase_amount)||null;
    if(to&&to!==W)return {state:'wrong_destination',amount:amt,to:mask(t.wallet_address??t.to_address)};
    if(st.endsWith('FAILED'))return {state:'failed',amount:amt};
    if(st.endsWith('SUCCESS')&&t.tx_hash)return {state:'arrived',amount:amt,txHash:String(t.tx_hash),verified:'coinbase_send'};
    return {state:'arriving',amount:amt};}
  if(balBefore!=null&&balNow!=null&&BigInt(balNow)>BigInt(balBefore))return {state:'arrived',amount:(Number(BigInt(balNow)-BigInt(balBefore))/1e6).toString(),verified:'wallet_balance'};
  // No Onramp record: still checking out, OR the buy finished inside the Coinbase account without a send to the wallet.
  return {state:'not_found',ageSec:Math.round(ageMs/1000),maybeInCoinbaseAccount:ageMs>=10*60e3};}
export function createOnramp({env=process.env,fetchFn=globalThis.fetch,jwt,kv,balanceOf,log=()=>{},now=()=>Date.now()}={}){
  const sign=jwt??(async(o)=>(await import('@coinbase/cdp-sdk/auth')).generateJwt(o));
  const key=()=>{const j=JSON.parse(readFileSync(env.KIPURSE_ONRAMP_KEY_FILE,'utf8'));const k={apiKeyId:String(j.id??j.name??''),apiKeySecret:String(j.privateKey??'')};if(!k.apiKeyId||!k.apiKeySecret)throw new Error('key');return k;};
  const cb=async(method,path,body)=>{let k=key();let token;try{token=await sign({...k,requestMethod:method,requestHost:ONRAMP_HOST,requestPath:path.split('?')[0],expiresIn:120});}finally{k=null;}
    const r=await fetchFn('https://'+ONRAMP_HOST+path,{method,headers:{authorization:'Bearer '+token,'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});return [r,await r.json().catch(()=>({}))];};
  const K=(w,ref)=>`onramp:${lc(w)}:${ref}`;const bal=async w=>{try{return balanceOf?String(await balanceOf(w)):null;}catch{return null;}};
  return {status:()=>onrampStatus(env),
    async session(wallet,{amount,redirectUrl,clientIp,experience}={}){
      const st=onrampStatus(env);if(!st.enabled)return [200,fallback('onramp_not_configured')];
      if(!ADDR.test(String(wallet??'')))return [400,{ok:false,error:'no_wallet'}];
      const body={addresses:[{address:wallet,blockchains:['base']}],assets:['USDC']};if(clientIp&&/^[0-9a-fA-F:.]{3,45}$/.test(clientIp))body.clientIp=clientIp;
      let r,j;try{[r,j]=await cb('POST',ONRAMP_PATH,body);}catch(e){log('onramp_session',{wallet:mask(wallet),ok:false,error:String(e?.message)==='key'?'key':'unreachable'});return [502,{ok:false,error:'onramp_unreachable',fallbackUrl:CB_BUY}];}
      if(!r.ok||typeof j?.token!=='string'||!j.token){log('onramp_session',{wallet:mask(wallet),ok:false,status:r.status});return [502,{ok:false,error:'onramp_rejected',status:r.status,fallbackUrl:CB_BUY}];}
      const ref='kp-'+randomBytes(12).toString('hex');kv?.put(K(wallet,ref),{created:now(),balBefore:await bal(wallet)},7*86400e3);
      log('onramp_session',{wallet:mask(wallet),ref,ok:true});
      return [200,{ok:true,configured:true,url:buyUrl(j.token,{amount,redirectUrl,ref,experience}),ref,wallet,asset:'USDC',network:'base',expiresInSec:300}];},
    async check(wallet,ref){
      if(!REF.test(String(ref??'')))return [400,{ok:false,error:'bad_ref'}];const rec=kv?.get(K(wallet,ref));if(!rec)return [404,{ok:false,error:'unknown_ref'}];
      if(!onrampStatus(env).enabled)return [200,{ok:true,ref,...classify({wallet,balBefore:rec.balBefore,balNow:await bal(wallet),ageMs:now()-rec.created})}];
      let txs=[];try{const [r,j]=await cb('GET',`/onramp/v1/buy/user/${ref}/transactions?page_size=5`);if(r.ok)txs=Array.isArray(j?.transactions)?j.transactions:[];}catch{}
      const out=classify({wallet,txs,balBefore:rec.balBefore,balNow:await bal(wallet),ageMs:now()-rec.created});
      log('onramp_status',{wallet:mask(wallet),ref,state:out.state});return [200,{ok:true,ref,...out}];}};}

// ---------------------------------------------------------------------------------------------------------------------------
// APPLE PAY DIRECT (Headless Onramp, v2 Onramp Order API). PRIMARY path (owner 2026-10-27 t566u): guest checkout, no Coinbase
// sign-in, Coinbase buys AND sends straight to destinationAddress = this wallet; never lands in a Coinbase account.
// KIPURSE_ONRAMP_HEADLESS = off (default) | sandbox (partnerUserRef "sandbox-…", fake Apple Pay sheet, never charged) | live.
// Coinbase rules: US users only, real (non-VoIP) US cell phone + email verified by OTP (Coinbase Verification API, valid 60 days),
// user accepts Coinbase Guest Checkout terms. Live use needs Coinbase to approve the app ("apply for access").
export const CDP_HOST='api.cdp.coinbase.com';
const E164=/^\+1[2-9][0-9]{9}$/,EMAIL=/^[^\s@]{1,64}@[^\s@]{1,190}\.[a-z]{2,}$/i,OTP=/^[0-9]{4,8}$/;
export const maskPhone=p=>String(p??'').replace(/^(\+1)\d{6}(\d{4})$/,'$1******$2'),maskEmail=e=>String(e??'').replace(/^(.).*(@.*)$/,'$1***$2');
export function orderState(o){const st=String(o?.status??'');const amt=o?.purchaseAmount!=null?String(o.purchaseAmount):null;
  if(o?.destinationAddress&&o.__wallet&&lc(o.destinationAddress)!==lc(o.__wallet))return {state:'wrong_destination',amount:amt};
  if(st.endsWith('COMPLETED'))return o?.txHash?{state:'arrived',amount:amt,txHash:String(o.txHash),verified:'coinbase_send'}:{state:'arriving',amount:amt};
  if(st.endsWith('FAILED'))return {state:'failed',amount:amt};
  if(st.endsWith('PROCESSING'))return {state:'arriving',amount:amt};
  return {state:'awaiting_payment',amount:amt};}
export function createApplePay({env=process.env,fetchFn=globalThis.fetch,jwt,kv,log=()=>{},now=()=>Date.now()}={}){
  const sign=jwt??(async(o)=>(await import('@coinbase/cdp-sdk/auth')).generateJwt(o));
  const mode=()=>{const m=env.KIPURSE_ONRAMP_HEADLESS;return onrampStatus(env).enabled&&(m==='live'||m==='sandbox')?m:'off';};
  const call=async(method,path,body)=>{const j=JSON.parse(readFileSync(env.KIPURSE_ONRAMP_KEY_FILE,'utf8'));let k={apiKeyId:String(j.id??j.name??''),apiKeySecret:String(j.privateKey??'')};let t;
    try{t=await sign({...k,requestMethod:method,requestHost:CDP_HOST,requestPath:path,expiresIn:120});}finally{k=null;}
    const r=await fetchFn('https://'+CDP_HOST+path,{method,headers:{authorization:'Bearer '+t,'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});return [r.status,await r.json().catch(()=>({}))];};
  const VK=w=>`onrampv:${lc(w)}`,OK=(w,ref)=>`onrampo:${lc(w)}:${ref}`;const vget=w=>kv?.get(VK(w))??{};const vput=(w,v)=>kv?.put(VK(w),v,61*86400e3);
  const verified=(v,ch)=>v[ch]&&v[ch].exp>now();
  const cbErr=(st,j)=>({ok:false,error:'coinbase_'+String(j?.errorType??st),message:String(j?.errorMessage??'').slice(0,200)});
  return {mode,
    info(wallet){const v=vget(wallet);return {ok:true,mode:mode(),phoneVerified:!!verified(v,'sms'),emailVerified:!!verified(v,'email'),phone:verified(v,'sms')?maskPhone(v.sms.dest):null,email:verified(v,'email')?maskEmail(v.email.dest):null,
      terms:['https://www.coinbase.com/legal/guest-checkout/us','https://www.coinbase.com/legal/user_agreement','https://www.coinbase.com/legal/privacy']};},
    async verifyStart(wallet,{channel,destination}={}){if(mode()==='off')return [200,{ok:false,error:'applepay_not_enabled'}];
      if(!['sms','email'].includes(channel))return [400,{ok:false,error:'bad_channel'}];const d=String(destination??'').trim();
      if(channel==='sms'?!E164.test(d):!EMAIL.test(d))return [400,{ok:false,error:channel==='sms'?'bad_phone':'bad_email'}];
      if(mode()==='sandbox'){const v=vget(wallet);v['p_'+channel]={id:'sandbox',dest:d};vput(wallet,v);return [200,{ok:true,sandbox:true}];}
      const [st,j]=await call('POST','/platform/v2/onramp/verifications',{channel,destination:d});log('onramp_verify_start',{wallet:mask(wallet),channel,status:st});
      if(st>=300||!j?.verificationId)return [st>=500?502:400,cbErr(st,j)];const v=vget(wallet);v['p_'+channel]={id:String(j.verificationId),dest:d};vput(wallet,v);return [200,{ok:true,otpExpiresAt:j.otpExpiresAt??null}];},
    async verifySubmit(wallet,{channel,code}={}){if(mode()==='off')return [200,{ok:false,error:'applepay_not_enabled'}];
      if(!['sms','email'].includes(channel)||!OTP.test(String(code??'')))return [400,{ok:false,error:'bad_code'}];const v=vget(wallet);const p=v['p_'+channel];if(!p)return [400,{ok:false,error:'start_first'}];
      if(mode()==='sandbox'){v[channel]={id:null,dest:p.dest,at:new Date(now()).toISOString(),exp:now()+60*86400e3};delete v['p_'+channel];vput(wallet,v);return [200,{ok:true,sandbox:true}];}
      const [st,j]=await call('POST',`/platform/v2/onramp/verifications/${encodeURIComponent(p.id)}/submit`,{otpCode:String(code)});log('onramp_verify_submit',{wallet:mask(wallet),channel,status:st});
      if(st>=300)return [400,cbErr(st,j)];const exp=Date.parse(j?.verificationExpiresAt??'')||now()+60*86400e3;v[channel]={id:String(j.verificationId??p.id),dest:p.dest,at:new Date(now()).toISOString(),exp};delete v['p_'+channel];vput(wallet,v);return [200,{ok:true}];},
    async order(wallet,{amount,agreedAt,clientIp}={}){const m=mode();if(m==='off')return [200,{ok:false,error:'applepay_not_enabled'}];
      if(!ADDR.test(String(wallet??'')))return [400,{ok:false,error:'no_wallet'}];
      const a=Number(amount);if(!Number.isFinite(a)||a<5||a>500)return [400,{ok:false,error:'bad_amount',min:5,max:500}];
      const ag=Date.parse(agreedAt??'');if(!ag||ag>now()+60e3||now()-ag>3600e3)return [400,{ok:false,error:'terms_not_accepted'}];
      const v=vget(wallet);if(!verified(v,'sms')||!verified(v,'email'))return [400,{ok:false,error:'verify_first',phoneVerified:!!verified(v,'sms'),emailVerified:!!verified(v,'email')}];
      const ref=(m==='sandbox'?'sandbox-':'')+'kp-'+randomBytes(12).toString('hex');
      const body={partnerUserRef:ref,destinationAddress:wallet,destinationNetwork:'base',purchaseCurrency:'USDC',paymentCurrency:'USD',paymentAmount:a.toFixed(2),paymentMethod:'GUEST_CHECKOUT_APPLE_PAY',
        email:v.email.dest,phoneNumber:v.sms.dest,phoneNumberVerifiedAt:v.sms.at,agreementAcceptedAt:new Date(ag).toISOString(),...(v.sms.id?{smsVerificationId:v.sms.id}:{}),...(v.email.id?{emailVerificationId:v.email.id}:{}),
        ...(clientIp&&/^[0-9a-fA-F:.]{3,45}$/.test(clientIp)?{clientIp}:{})};
      const [st,j]=await call('POST','/platform/v2/onramp/orders',body);const o=j?.order??{};
      log('onramp_applepay_order',{wallet:mask(wallet),ref,status:st,mode:m,orderStatus:o.status??null});
      if(st>=300||!o.orderId||!j?.paymentLink?.url)return [st>=500?502:400,cbErr(st,j)];
      if(lc(o.destinationAddress)!==lc(wallet))return [502,{ok:false,error:'wrong_destination'}];   // never show a pay button for another address
      let url;try{const u=new URL(j.paymentLink.url);if(u.protocol!=='https:'||!/(^|\.)coinbase\.com$/.test(u.hostname))throw 0;if(m==='sandbox')u.searchParams.set('useApplePaySandbox','true');url=u.toString();}catch{return [502,{ok:false,error:'bad_payment_link'}];}
      kv?.put(OK(wallet,ref),{orderId:String(o.orderId),created:now()},7*86400e3);
      return [200,{ok:true,ref,url,sandbox:m==='sandbox',amount:o.purchaseAmount??null,paymentTotal:o.paymentTotal??null,fees:o.fees??null,destination:mask(wallet)}];},
    async status(wallet,ref){if(!/^(sandbox-)?kp-[0-9a-f]{24}$/.test(String(ref??'')))return [400,{ok:false,error:'bad_ref'}];const rec=kv?.get(OK(wallet,ref));if(!rec)return [404,{ok:false,error:'unknown_ref'}];
      if(mode()==='off')return [200,{ok:true,ref,state:'unknown'}];
      const [st,j]=await call('GET',`/platform/v2/onramp/orders/${encodeURIComponent(rec.orderId)}`);if(st>=300)return [200,{ok:true,ref,state:'unknown'}];
      const out=orderState({...(j?.order??j??{}),__wallet:wallet});log('onramp_applepay_status',{wallet:mask(wallet),ref,state:out.state});return [200,{ok:true,ref,...out}];}};}

/** t864: per-wallet limiter for phone Onramp sessions (read-grant phones may open them; destination is always the tenant wallet). */
export function sessionLimiter({max=10,windowMs=10*60e3,now=()=>Date.now()}={}){const m=new Map();
  return (w)=>{const k=String(w??'').toLowerCase(),t=now(),a=(m.get(k)??[]).filter(x=>t-x<windowMs);if(a.length>=max){m.set(k,a);return false;}a.push(t);m.set(k,a);if(m.size>1000)m.clear();return true;};}
