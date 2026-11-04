// SPDX-License-Identifier: AGPL-3.0-only
// OWNER-INITIATED PAYMENT (Siri / app). Non-custodial: the server can only relay a payment that the account's own enrolled phone
// key (Secure Enclave P-256, Face ID) signed. The phone signs wallet.replaySafeHash(adapter.approvalDigest(account, purchaseKey,
// payee, amount, deadline)) -> bound to wallet, payee, amount, one-time purchase key (nonce), expiry, chain id and adapter (EIP-712
// domain). On chain the wallet asks the phone approver (KipursePhoneApproverV2, KIND_PAY) and the adapter enforces the owner's
// per-payment / daily / term caps and charges the fees. Off by default (enabled:false) -> every route answers 404.
// Multi-tenant: every request is resolved to ONE tenant (wallet + its phone enrollment + its engine) from its own phone session;
// all records are keyed by wallet and deletable with forget(wallet). No deployment data lives here.
import {randomBytes} from 'node:crypto';import {encodeAbiParameters,getAddress,isAddress,parseAbi} from 'viem';import {p256VerifyDigest} from './phone-signer.mjs';
const CBSW=parseAbi(['function replaySafeHash(bytes32 hash) view returns (bytes32)']);
const J=x=>JSON.stringify(x,(k,v)=>typeof v==='bigint'?v.toString():v);const lc=a=>String(a).toLowerCase();
export const KIND_PAY=4;
const HARD=new Set(['over_single_cap','over_single_cap_incl_fees','over_daily_cap','over_daily_cap_incl_fees','over_term_cap','over_term_cap_incl_fees','insufficient_balance','wallet_paused','authorization_expired','authorization_not_started']);
/** SignatureWrapper(ownerIndex, abi.encode(uint8 4, abi.encode(purchaseKey, payee, amount, deadline), r, s)) */
export function phonePayWrapper(ownerIndex,{purchaseKey,payee,amount,deadline},r,s){
  const body=encodeAbiParameters([{type:'bytes32'},{type:'address'},{type:'uint256'},{type:'uint256'}],[purchaseKey,getAddress(payee),BigInt(amount),BigInt(deadline)]);
  const data=encodeAbiParameters([{type:'uint8'},{type:'bytes'},{type:'uint256'},{type:'uint256'}],[KIND_PAY,body,BigInt(r),BigInt(s)]);
  return encodeAbiParameters([{type:'tuple',components:[{name:'ownerIndex',type:'uint256'},{name:'signatureData',type:'bytes'}]}],[{ownerIndex:BigInt(ownerIndex),signatureData:data}]);}
/**
 * resolveTenant(req) -> null | {wallet, chainId, token, pub, phone:{active(),payCapable()}, engine:{approvalRequest,pay}, knownPayees():Promise<[{address,name}]>}
 * store: persisted object (records per wallet); save(): persist.
 */
export function createOwnerPay({enabled=false,resolveTenant,store,save=()=>{},now=()=>Date.now(),challengeTtlMs=180e3,windowSec=300}){
  store.ownerPay??={};const T=w=>(store.ownerPay[lc(w)]??={pending:{},payments:[]});const hits=new Map();
  const limited=(k,max=20)=>{const n=now(),h=hits.get(k)??[0,n];if(n-h[1]>60000){h[0]=0;h[1]=n;}h[0]++;hits.set(k,h);return h[0]>max;};
  const gc=t=>{const n=now();for(const [k,v] of Object.entries(t.pending))if(v.exp<=n)delete t.pending[k];};
  async function challenge(ten,b){
    if(!isAddress(String(b.payee??'')))return [400,{error:'bad_payee'}];const payee=getAddress(b.payee);
    if(!/^[0-9]{1,15}$/.test(String(b.amount??''))||BigInt(b.amount)<=0n)return [400,{error:'bad_amount',detail:'atomic USDC units (6 decimals)'}];const amount=BigInt(b.amount);
    if(lc(payee)===lc(ten.wallet))return [400,{error:'bad_payee'}];
    const known=(await ten.knownPayees()).some(p=>lc(p.address)===lc(payee));
    if(!known&&b.confirmNewPayee!==true)return [409,{error:'new_payee_needs_confirm',payee}];// explicit address: the app shows an extra confirmation first
    const cap=await ten.phone.payCapable();if(!cap.ok)return [409,{error:cap.code}];
    const t=T(ten.wallet);gc(t);if(Object.keys(t.pending).length>=5)return [429,{error:'slow_down'}];
    const id=randomBytes(12).toString('hex');const intentId='owner-pay:'+id;
    const request={direct:{chainId:ten.chainId,token:ten.token,payee,amount:amount.toString(),merchantOrderId:intentId}};
    // Above the phone approver's frozen per-payment ceiling: pay like any AI agent instead (no on-chain phone approval), so the
    // wallet's LIVE adapter caps (per-payment / daily / total, trusted payees, stranger caps) decide. Face ID is still required.
    // BEFORE Face ID: refuse what the wallet's live limits / balance / pause would refuse anyway (tier caps are skipped: an owner
    // approval bypasses them on chain). Clear hint, no signature prompt, nothing sent.
    {let pf=null;try{pf=await ten.engine.preflight?.(request,{agentId:'owner',intentId});}catch{pf=null;}
      const hard=(pf?.reasons??[]).filter(r=>HARD.has(r));
      if(hard.length)return [409,{error:'over_wallet_limits',reasons:hard,detail:hard.includes('insufficient_balance')?'钱包余额不够这笔（含手续费和手续费）。先充值再付。':hard.includes('wallet_paused')?'钱包已暂停，先在 App 里恢复再付。':hard.some(r=>r.startsWith('authorization_'))?'AI 授权已过期或还没生效，先在 App 里续期。':'这笔超过了你在 App 里设的钱包限额（每笔 / 每天 / 总额）。可以在 App 里调高限额再付。'}];}
    const viaCaps=amount>BigInt(cap.active.maxSingle??0);
    if(viaCaps){let pf=null;try{pf=await ten.engine.preflight?.(request,{agentId:'owner',intentId});}catch{pf=null;}
      if(!pf?.canPay)return [409,{error:'needs_trusted_payee',reasons:pf?.reasons??[],detail:'这笔超过了手机快速批准的范围，又不在钱包限额内可直接付的收款方里。请先把收款方加入信任名单，或调高钱包限额。'}];}
    const ar=await ten.engine.approvalRequest(request,{intentId,windowSec});if(!ar?.ok)return [422,{error:ar?.code??'not_payable'}];
    const digest=await ten.pub.readContract({address:ten.wallet,abi:CBSW,functionName:'replaySafeHash',args:[ar.digest]});
    t.pending[id]={request,intentId,payee,amount:amount.toString(),purchaseKey:ar.onchainPurchaseKey,deadline:String(ar.deadline),digest,fingerprint:cap.active.fingerprint,newPayee:!known,viaCaps,exp:now()+challengeTtlMs};save();
    return [200,{viaCaps,id,digest,approvalDigest:ar.digest,purchaseKey:ar.onchainPurchaseKey,payee,amount:amount.toString(),fee:String(ar.fee??'0'),maxNetworkFee:String(ar.maxNetworkFee??'0'),deadline:String(ar.deadline),chainId:ten.chainId,wallet:ten.wallet,newPayee:!known,expiresInSec:Math.floor(challengeTtlMs/1000)}];}
  async function submit(ten,b){const t=T(ten.wallet);gc(t);const id=String(b.id??'');const c=t.pending[id];
    if(!/^[0-9a-f]{24}$/.test(id)||!c)return [400,{error:'bad_challenge'}];delete t.pending[id];save();// single use, even on failure
    const cap=await ten.phone.payCapable();if(!cap.ok)return [409,{error:cap.code}];// re-checked on chain at submit time
    if(cap.active.fingerprint!==c.fingerprint)return [409,{error:'phone_changed'}];
    let ok=false;try{ok=p256VerifyDigest(cap.active,c.digest,String(b.r),String(b.s));}catch{ok=false;}
    if(!ok)return [403,{error:'not_phone_signer'}];
    const signature=phonePayWrapper(cap.index,{purchaseKey:c.purchaseKey,payee:c.payee,amount:c.amount,deadline:c.deadline},b.r,b.s);
    const out=await ten.engine.pay({agentId:'owner',intentId:c.intentId,request:c.request,...(c.viaCaps?{}:{ownerApproval:{signature,deadline:c.deadline}}),idempotencyKey:c.intentId});
    const paid=out?.ok!==false&&(out?.status==='paid'||out?.state==='paid'||!!out?.txHash);
    const row={id,at:new Date(now()).toISOString(),payee:c.payee,amount:c.amount,fee:String(out?.fee??''),networkFee:String(out?.networkFee??''),txHash:out?.txHash??null,state:paid?'paid':(out?.state??out?.status??'failed'),newPayee:c.newPayee};
    t.payments.unshift(row);t.payments.length=Math.min(t.payments.length,200);save();
    return [paid?200:502,{ok:paid,...row,detail:paid?undefined:String(out?.error??out?.code??'').slice(0,200)}];}
  /** Delete-everything for one tenant: pending challenges + owner-payment records. */
  function forget(wallet){delete store.ownerPay[lc(wallet)];save();}
  async function handle(req,res,u,{readBody,ip}){const p=u.pathname;if(!p.startsWith('/owner/pay'))return false;
    const json=(c,o)=>{res.writeHead(c,{'content-type':'application/json','cache-control':'no-store','x-content-type-options':'nosniff'});res.end(J(o));};
    if(!enabled){json(404,{error:'owner_pay_disabled'});return true;}
    if(limited(ip??'')){json(429,{error:'slow_down'});return true;}
    const ten=await resolveTenant(req);if(!ten){json(401,{error:'invalid_session'});return true;}
    try{
      if(p==='/owner/pay/challenge'&&req.method==='POST'){const [c,o]=await challenge(ten,await readBody(req));json(c,o);return true;}
      if(p==='/owner/pay/submit'&&req.method==='POST'){const [c,o]=await submit(ten,await readBody(req));json(c,o);return true;}
      if(p==='/owner/pay/history'&&req.method==='GET'){json(200,{payments:T(ten.wallet).payments});return true;}
    }catch(e){json(502,{error:'owner_pay_failed',detail:String(e?.message??e).slice(0,200)});return true;}
    json(404,{error:'not_found'});return true;}
  return {handle,forget,_challenge:challenge,_submit:submit};}
