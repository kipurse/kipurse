// SPDX-License-Identifier: AGPL-3.0-only
// Kipurse V5 micropayment float (M3, 2026-10-17). Sub-$1 x402 payments without one of our txs each:
//  fund (1 tx/day, <= owner float cap, gas reimbursed incl. the reconcile share) -> session-key EIP-3009 vouchers FROM the float
//  vault, settled by each merchant's facilitator -> reconcile after expiry (1 tx: 0.1% fee on the actual spend, rounded up;
//  unspent float + fee reserve back to the owner). No scheduler: fund / reconcile are code with a manual or CLI trigger.
// The session key is generated here, kept in a 0600 file next to the ledger, never logged or returned by any tool.
// Worst case if it leaks: the float balance (<= the owner's daily float cap), stranger per-payment cap per voucher.
import fs from 'node:fs';
import {encodeAbiParameters,parseAbiParameters,getAddress} from 'viem';
import {generatePrivateKey,privateKeyToAccount} from 'viem/accounts';
import {feeFor} from './abi.mjs';

const VOUCHER_T=parseAbiParameters('address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce,bytes sig');
export const FLOAT_DEFAULTS={thresholdAtomic:1_000_000n,sessionHours:24,reconcileGas:120000n,fundGas:400000n};

export function createFloat({cfg,rd,write,p,B,ledger,quote,estimate,fee,chainNow,txLock,keyFile}){
  const F={...FLOAT_DEFAULTS,...(cfg.float??{})};
  ledger.db.exec(`CREATE TABLE IF NOT EXISTS float_vouchers(nonce TEXT PRIMARY KEY, session TEXT NOT NULL, purchase_key TEXT, payee TEXT NOT NULL, amount INTEGER NOT NULL, valid_before INTEGER NOT NULL, state TEXT NOT NULL, at INTEGER NOT NULL)`);
  ledger.db.exec(`CREATE TABLE IF NOT EXISTS float_sessions(session TEXT PRIMARY KEY, float_vault TEXT, funded INTEGER, fee_reserve INTEGER, network_fee INTEGER, fund_tx TEXT, funded_at INTEGER,
    spent INTEGER, fee INTEGER, reconcile_tx TEXT, reconciled_at INTEGER)`);
  const load=()=>{try{return JSON.parse(fs.readFileSync(keyFile,'utf8'));}catch{return null;}};
  const save=o=>{fs.writeFileSync(keyFile,JSON.stringify(o),{mode:0o600});fs.chmodSync(keyFile,0o600);};
  const pub=s=>s?{session:s.address,floatVault:s.floatVault,expiry:s.expiry,funded:s.funded}:null;
  const committed=addr=>BigInt(ledger.db.prepare(`SELECT COALESCE(SUM(amount),0) AS a FROM float_vouchers WHERE session=? AND state!='void'`).get(addr.toLowerCase()).a);
  async function onchain(){const f=await rd('floats',[p.account]);return {open:f[4],funded:f[1],feeReserve:f[2],expiry:Number(f[3])};}

  /** Fund today's float and open a session (executor tx). amount defaults to the owner's float cap. */
  async function fund({amount,hours=F.sessionHours}={}){
    const cap=BigInt(await rd('floatCap',[p.account]));if(cap===0n)return {state:'rejected',reason:'float_disabled_by_owner'};
    const amt=BigInt(amount??cap);if(amt>cap)return {state:'rejected',reason:'over_owner_float_cap',cap:cap.toString()};
    const now=await chainNow();let st=await onchain();
    if(st.open&&now<st.expiry)return {state:'rejected',reason:'float_session_open',expiry:st.expiry};
    if(st.open){const r=await reconcile();if(r.state!=='reconciled')return r;st=await onchain();}
    const exp=Math.min(now+Math.round(hours*3600),Number(p.end)-1);
    const pk=generatePrivateKey();const acct=privateKeyToAccount(pk);const fv=getAddress(await rd('floatAddress',[p.account]));
    const args0=[p,acct.address,amt,BigInt(exp),B('maxNetworkFee'),now+240];
    const g=await estimate('fundFloat',args0);
    let q;try{q=await quote({mode:'float'},(g??F.fundGas)+BigInt(F.reconcileGas),'fundFloat',args0);}catch(e){return {state:'rejected',reason:e.code??'network_fee_unquotable'};}
    if(q.quote>B('maxNetworkFee'))return {state:'retry_later',reason:'gas_spike',retryAfterSec:60};
    const release=txLock.try(p.account);if(!release)return {state:'retry_later',reason:'tx_in_flight',retryAfterSec:5};
    let reserved=null;
    try{
      let ev=null;try{ev=cfg.everydayGet?.()??null;}catch{return {state:'rejected',reason:'EVERYDAY_CHECK_FAILED',nothingPaid:true};}
      if(ev&&ev.authorized===false)return {state:'rejected',reason:'AI_LIMITS_UNCONFIRMED',nothingPaid:true};
      if(ev&&ev.authorized===true&&ev.term!=null){reserved='rsv-'+acct.address.toLowerCase();const gate=ledger.reserveFloat(reserved,amt,BigInt(ev.term));if(!gate.ok)return {state:'rejected',reason:gate.error==='reserve_failed'?'EVERYDAY_CHECK_FAILED':'EVERYDAY_TERM_LIMIT',nothingPaid:true};}
      save({key:pk,address:acct.address,floatVault:fv,expiry:exp,funded:amt.toString(),pending:true}); // persisted BEFORE send: never lose a funded session key
      const tx=await write('fundFloat',[p,acct.address,amt,BigInt(exp),q.total,now+240],{label:'fundFloat'});
      q.applied?.(tx.hash);
      save({key:pk,address:acct.address,floatVault:fv,expiry:exp,funded:amt.toString(),txHash:tx.hash});
      const fe=feeFor(amt,await fee());
      ledger.db.prepare(`INSERT OR REPLACE INTO float_sessions(session,float_vault,funded,fee_reserve,network_fee,fund_tx,funded_at) VALUES(?,?,?,?,?,?,?)`).run(acct.address.toLowerCase(),fv,Number(amt),Number(fe),Number(q.total),tx.hash,Date.now());
      return {state:'funded',txHash:tx.hash,floatVault:fv,session:acct.address,amount:amt.toString(),feeReserve:fe.toString(),networkFee:q.total.toString(),expiry:exp,
        note:'sub-threshold x402 payments now settle from the float with no tx of ours; reconcile after expiry'};
    }finally{if(reserved)ledger.clearFloatReserve(reserved);release();}
  }

  /** Voucher for one x402 exact requirement (n from the detector), or null when the float cannot take it. */
  async function voucher(n,id,{nowS}){
    if(n.mode!=='eip3009'||BigInt(n.amount)>=BigInt(F.thresholdAtomic)||BigInt(n.amount)>B('openSingle'))return null;
    const s=load();if(!s||s.pending)return null;
    if(nowS>=s.expiry-90)return null;
    if(committed(s.address)+BigInt(n.amount)>BigInt(s.funded))return {state:'rejected',reason:'float_exhausted_today'};
    if(await rd('floatBlocked',[p.account,n.payee]))return {state:'rejected',reason:'payee_blocked_or_wallet_paused'};
    const nonce=id.purchaseKey;const from=getAddress(s.floatVault);
    const used=await rd('authorizationState',[from,nonce],cfg.token).catch(()=>false);if(used)return {state:'already_paid_on_chain',purchaseKey:id.ledgerKey};
    const va=BigInt(nowS-60),vb=BigInt(Math.min(nowS+Math.min(Number(n.maxTimeoutSeconds??60),300)+60,s.expiry-1));
    const digest=await rd('authorizationDigest',[from,n.payee,BigInt(n.amount),va,vb,nonce]);
    const acct=privateKeyToAccount(s.key);const ecdsa=await acct.sign({hash:digest});
    const signature=encodeAbiParameters(VOUCHER_T,[getAddress(n.payee),BigInt(n.amount),va,vb,nonce,ecdsa]);
    try{ledger.db.prepare(`INSERT INTO float_vouchers VALUES(?,?,?,?,?,?,?,?)`).run(nonce,s.address.toLowerCase(),id.ledgerKey,n.payee.toLowerCase(),Number(n.amount),Number(vb),'signed',Date.now());}
    catch{return {state:'already_signed',purchaseKey:id.ledgerKey};}
    const auth={from,to:getAddress(n.payee),value:String(n.amount),validAfter:va.toString(),validBefore:vb.toString(),nonce};
    return {state:'voucher',purchaseKey:id.ledgerKey,auth,signature,digest,fee:feeFor(n.amount,await fee()).toString(),networkFee:'0',
      note:'paid from the daily float: no tx of ours; protocol fee charged once at reconcile on the day total (rounded up)'};
  }
  const voidVoucher=nonce=>ledger.db.prepare(`UPDATE float_vouchers SET state='void' WHERE nonce=? AND state='signed'`).run(nonce);
  const markVoucher=(nonce,state)=>ledger.db.prepare(`UPDATE float_vouchers SET state=? WHERE nonce=?`).run(state,nonce);

  /** After expiry (anyone) or with owner=true for an early owner-side close: one tx, fee on the actual spend. */
  async function reconcile(){
    const st=await onchain();if(!st.open)return {state:'nothing_open'};
    const now=await chainNow();if(now<st.expiry)return {state:'waiting',expiry:st.expiry,detail:'only the owner wallet can close a float early (exit plan)'};
    const release=txLock.try(p.account);if(!release)return {state:'retry_later',reason:'tx_in_flight',retryAfterSec:5};
    try{const fv=await rd('floatAddress',[p.account]);const left=BigInt(await rd('balanceOf',[fv],cfg.token).catch(()=>0n));
      const spent=st.funded>left?st.funded-left:0n;let fe=feeFor(spent,await fee());if(fe>st.feeReserve)fe=st.feeReserve;
      const tx=await write('reconcileFloat',[p.account],{label:'reconcileFloat'});const s=load();
      ledger.db.prepare(`UPDATE float_sessions SET spent=?,fee=?,reconcile_tx=?,reconciled_at=? WHERE float_vault=? AND reconcile_tx IS NULL`).run(Number(spent),Number(fe),tx.hash,Date.now(),getAddress(fv));
      if(s){ledger.db.prepare(`UPDATE float_vouchers SET state='closed' WHERE session=?`).run(s.address.toLowerCase());try{fs.unlinkSync(keyFile);}catch{}}
      return {state:'reconciled',txHash:tx.hash,funded:st.funded.toString(),feeReserve:st.feeReserve.toString(),spent:spent.toString(),fee:fe.toString()};}
    finally{release();}
  }
  async function status(){const st=await onchain();const s=load();const fv=getAddress(await rd('floatAddress',[p.account]));
    const bal=await rd('balanceOf',[fv],cfg.token).catch(()=>0n);
    return {cap:(await rd('floatCap',[p.account])).toString(),open:st.open,funded:st.funded.toString(),expiry:st.expiry,floatVault:fv,balance:bal.toString(),
      session:pub(s),committed:s?committed(s.address).toString():'0',thresholdAtomic:String(F.thresholdAtomic)};}
  return {fund,voucher,voidVoucher,markVoucher,reconcile,status};
}
export const encodeVoucher=(v)=>encodeAbiParameters(VOUCHER_T,v);
