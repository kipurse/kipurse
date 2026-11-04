// SPDX-License-Identifier: AGPL-3.0-only
// OWNER SIGNING PAGE (mainnet-capable). The owner signs in HIS OWN Base Account in the browser; this server never holds an owner key.
//  (a) cap change: the operator's planner builds the ONE wallet batch at signing time; the owner sends it from his Base Account;
//      the server only accepts it once the new permission is valid ON CHAIN, then hands it to onPermission (engine swap).
//  (b) agent trust requests (same flow for every agent): approve -> nested wallet message typed data -> owner signs -> relay trustBySig
//      (the engine's writer: in userop mode the owner's vault pays the gas in USDC).
// Access: one-time login code (0600 file) -> HttpOnly SameSite=Strict cookie; every POST needs the session CSRF header + same Origin.
import http from 'node:http';import fs from 'node:fs';import {randomBytes,timingSafeEqual} from 'node:crypto';import {getAddress} from 'viem';
const J=x=>JSON.stringify(x,(k,v)=>typeof v==='bigint'?v.toString():v);
const same=(a,b)=>{const x=Buffer.from(String(a??'')),y=Buffer.from(String(b??''));return x.length===y.length&&timingSafeEqual(x,y);};
export function createOwnerSignSurface({owner,wallet,chainId,trustRequests,planCapChange,confirmCapChange,status,staticDir,loginFile,port=8671,host='127.0.0.1',publicOrigin}){
  if(!trustRequests?.api||!trustRequests?.cap)throw Error('OWNER_SIGN: trust-request owner capability required');
  const OWNER=getAddress(owner),WALLET=getAddress(wallet);let login=null;const sessions=new Map();let pendingPlan=null;
  const origins=new Set([`http://localhost:${port}`,`http://127.0.0.1:${port}`,...(publicOrigin?[publicOrigin]:[])]);
  const newLogin=()=>{login=randomBytes(24).toString('hex');const u=`${publicOrigin??`http://localhost:${port}`}/login?code=${login}`;if(loginFile)fs.writeFileSync(loginFile,u+'\n',{mode:0o600});return u;};newLogin();
  const sess=req=>{const m=/(?:^|;\s*)kp_os=([0-9a-f]{48})/.exec(String(req.headers.cookie??''));return m&&sessions.get(m[1]);};
  const api={
    async state(){const tr=trustRequests.api.list(trustRequests.cap);return {chainId,owner:OWNER,wallet:WALLET,status:await status?.().catch(e=>({error:e.message})),trustRequests:tr};},
    async capPrepare(){const p=await planCapChange();pendingPlan=p;return {human:p.human,policy:p.policy,labels:p.calls.map(c=>c.label),
      send:{method:'wallet_sendCalls',params:[{version:'2.0.0',chainId:'0x'+Number(chainId).toString(16),from:OWNER,atomicRequired:true,calls:[{to:WALLET,value:'0x0',data:p.walletExecuteBatch.data}]}]}};},
    async capConfirm(){if(!pendingPlan)throw Error('prepare first');const r=await confirmCapChange(pendingPlan);if(!r?.valid)return {ok:false,detail:'the new permission is not valid on chain yet; wait for the transaction, then tap again'};pendingPlan=null;return {ok:true,...r};},
    async trustApprove({id}){return trustRequests.api.approve(trustRequests.cap,String(id));},
    async trustSign({id,signature}){return trustRequests.api.submitSignature(trustRequests.cap,String(id),String(signature));},
    async trustReject({id}){return trustRequests.api.reject(trustRequests.cap,String(id));},
  };
  const hdr={'cache-control':'no-store','x-frame-options':'DENY','referrer-policy':'no-referrer','x-content-type-options':'nosniff'};
  const server=http.createServer(async(req,res)=>{const send=(c,type,b,h={})=>{res.writeHead(c,{'content-type':type,...hdr,...h});res.end(b);};const js=(c,o)=>send(c,'application/json',J(o));
    try{const u=new URL(req.url,'http://x');
      if(req.method==='GET'&&u.pathname==='/login'){if(!login||!same(u.searchParams.get('code'),login))return send(403,'text/plain; charset=utf-8','login code invalid or used');login=null;
        const id=randomBytes(24).toString('hex');sessions.set(id,{csrf:randomBytes(16).toString('hex')});return send(303,'text/plain','',{'set-cookie':`kp_os=${id}; HttpOnly; SameSite=Strict; Path=/`,location:'/'});}
      const s=sess(req);if(!s)return send(401,'text/plain; charset=utf-8','Owner only: open the one-time login link.');
      if(req.method==='GET'&&(u.pathname==='/'||u.pathname==='/app.js')){const f=u.pathname==='/'?'index.html':'app.js';
        return send(200,f.endsWith('.js')?'text/javascript':'text/html; charset=utf-8',fs.readFileSync(staticDir+'/'+f),f==='index.html'?{'content-security-policy':"default-src 'self'; connect-src 'self' https://*.coinbase.com https://mainnet.base.org https://mainnet-preconf.base.org; frame-src https://keys.coinbase.com; img-src 'self' data: https:; style-src 'self' 'unsafe-inline'"}:{});}
      if(req.method==='GET'&&u.pathname==='/api/csrf')return js(200,{csrf:s.csrf});
      // read-only state may be fetched with GET (the page's api('state') call does); writes stay POST + CSRF + Origin.
      if(req.method==='GET'&&u.pathname==='/api/state')return js(200,await api.state());
      if(req.method==='POST'&&u.pathname.startsWith('/api/')){const o=req.headers.origin;if(o&&!origins.has(o))return js(403,{error:'bad_origin'});if(!same(req.headers['x-kp-csrf'],s.csrf))return js(403,{error:'bad_csrf'});
        const fn=u.pathname.slice(5);if(!Object.hasOwn(api,fn))return js(404,{error:'not_found'});let b='';for await(const c of req){b+=c;if(b.length>65536)return js(413,{error:'too_large'});}
        try{return js(200,await api[fn](b?JSON.parse(b):{}));}catch(e){return js(400,{error:e.code??'failed',detail:e.message});}}
      if(u.pathname.startsWith('/api/'))return js(404,{error:'not_found'});
      return send(404,'text/plain','not found');}catch(e){try{send(500,'text/plain','error');}catch{}}});
  return {server,newLogin,listen:()=>new Promise(r=>server.listen(port,host,()=>r(server))),close:()=>server.close()};}
