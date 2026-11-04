// SPDX-License-Identifier: AGPL-3.0-only
// TRUST REQUESTS (universal for every agent): an agent ASKS the owner to trust a payee; only the owner can approve.
// Flow: agent request_trust -> pending "awaiting_owner" -> owner surface lists it (raw address, caps, untrusted reason)
//       -> owner approves: kit prepares the trustBySig EIP-712 typed data -> owner signs in HIS wallet -> kit relays trustBySig.
// There is NO agent-specific path: agents get only `agentApi` (request + status). Owner actions require the private owner
// capability object returned by the factory; it is never handed to MCP/HTTP agent code, and a look-alike object is refused.
// Agent text (name, reason) is untrusted and is never used to decide anything; nothing is ever auto-approved.
import {plainStore} from './at-rest.mjs';import {nestedOwnerTypedData,wrapCbswSignature} from './owner.mjs';import {randomUUID} from 'node:crypto';import {getAddress,isAddress} from 'viem';
const CHAINS={8453:'base',84532:'base-sepolia'};
const ALIASES={base:8453,'base-mainnet':8453,'8453':8453,'eip155:8453':8453,'base-sepolia':84532,'84532':84532,'eip155:84532':84532};
const uintStr=(v,f)=>{const s=String(v??'').trim();if(!/^[0-9]{1,30}$/.test(s)||BigInt(s)<=0n)throw Object.assign(Error(`TRUSTREQ: ${f} must be a positive integer (base units)`),{code:'bad_'+f});return s;};
const clean=(s,max)=>String(s??'').replace(/[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g,' ').trim().slice(0,max);
export function createTrustRequests({store=plainStore,file,chainId,now=()=>Math.floor(Date.now()/1000),pendingTtlSec=7*86400,
  prepare,submit,notify=()=>{},ownerSigner=null}){
  // ownerSigner {wallet, ownerIndex}: wallet != the signing Base Account (mainnet); the owner signs the nested wallet message, we wrap it.
  if(!file)throw Error('TRUSTREQ: file required');if(!CHAINS[chainId])throw Error('TRUSTREQ: unsupported chainId');
  if(typeof prepare!=='function'||typeof submit!=='function')throw Error('TRUSTREQ: prepare/submit (chain) required');
  let S=store.readJson(file,null)??{requests:{},seq:0};const save=()=>store.writeJson(file,S);
  const OWNER=Object.freeze({__kipurseOwnerCapability:true});// identity-checked; cannot be forged by an agent
  const needOwner=cap=>{if(cap!==OWNER)throw Object.assign(Error('TRUSTREQ: only the owner can do this (agent keys can never approve or reject trust)'),{code:'owner_only'});};
  const bump=()=>{S.seq=(S.seq??0)+1;};
  const expireOld=()=>{const t=now();let ch=false;for(const r of Object.values(S.requests))if((r.status==='awaiting_owner'||r.status==='awaiting_signature')&&r.pendingUntil<=t){r.status='expired';r.updatedAt=t;delete r.prepared;ch=true;}if(ch){bump();save();}};
  const view=r=>r&&{id:r.id,status:r.status,payee:r.payee,chain:r.chain,chainId:r.chainId,merchantName:r.merchantName,single:r.single,total:r.total,expiresInDays:r.expiresInDays,
    reason:r.reason,agentId:r.agentId,requestedBy:r.requestedBy,createdAt:r.createdAt,updatedAt:r.updatedAt,pendingUntil:r.pendingUntil,txHash:r.txHash??null,
    untrustedText:true,note:r.status==='awaiting_owner'?'waiting for the HUMAN owner to approve on the owner app/page; nothing is trusted until then':undefined};
  function request({agentId,merchantName,payee,chain,single,total,expiresInDays=90,reason}){
    expireOld();if(!agentId)throw Error('TRUSTREQ: agentId required');
    if(!isAddress(String(payee??''),{strict:false})||/^0x0{40}$/i.test(String(payee)))throw Object.assign(Error('TRUSTREQ: payee must be a 0x address'),{code:'bad_payee'});
    const cid=ALIASES[String(chain??CHAINS[chainId]).trim().toLowerCase()];if(cid!==chainId)throw Object.assign(Error(`TRUSTREQ: this wallet is on ${CHAINS[chainId]} only`),{code:'unsupported_network'});
    const name=clean(merchantName,80);if(name.length<1)throw Object.assign(Error('TRUSTREQ: merchant name required'),{code:'bad_name'});
    const why=clean(reason,500);if(why.length<3)throw Object.assign(Error('TRUSTREQ: reason (3-500 chars) required'),{code:'bad_reason'});
    const s1=uintStr(single,'single'),tot=uintStr(total??single,'total');if(BigInt(s1)>BigInt(tot))throw Object.assign(Error('TRUSTREQ: per-payment cap must be <= total cap'),{code:'single_above_total'});
    const d=Number(expiresInDays);if(!(d>0&&d<=365))throw Object.assign(Error('TRUSTREQ: expiry 1-365 days'),{code:'trust_days_1_to_365'});
    const addr=getAddress(String(payee).toLowerCase());
    // idempotent: an open request for the same payee on this chain is returned as-is (any agent; no duplicates for the owner)
    const open=Object.values(S.requests).find(r=>r.payee===addr&&r.chainId===chainId&&(r.status==='awaiting_owner'||r.status==='awaiting_signature'));
    if(open){if(!open.requestedBy.includes(String(agentId))){open.requestedBy.push(String(agentId));save();}return {...view(open),idempotent:true};}
    const t=now();const r={id:randomUUID(),status:'awaiting_owner',payee:addr,chain:CHAINS[chainId],chainId,merchantName:name,single:s1,total:tot,expiresInDays:d,reason:why,
      agentId:String(agentId),requestedBy:[String(agentId)],createdAt:t,updatedAt:t,pendingUntil:t+pendingTtlSec};
    S.requests[r.id]=r;bump();save();try{notify({type:'trust_request',id:r.id,payee:addr,merchantName:name});}catch{}return {...view(r),idempotent:false};}
  function status(id){expireOld();const r=S.requests[String(id)];if(!r)throw Object.assign(Error('TRUSTREQ: unknown id'),{code:'unknown_trust_request'});return view(r);}
  const agentApi=Object.freeze({request,status});
  const ownerApi=Object.freeze({
    // delete-everything: drop every request record (agent ids, merchant names, reasons). seq is kept so ids never repeat. On-chain trust is untouched.
    forget(cap){needOwner(cap);S={requests:{},seq:S.seq??0};save();},
    list(cap){needOwner(cap);expireOld();const all=Object.values(S.requests);return {seq:S.seq??0,pending:all.filter(r=>r.status==='awaiting_owner'||r.status==='awaiting_signature').map(view),recent:all.filter(r=>!['awaiting_owner','awaiting_signature'].includes(r.status)).slice(-20).map(view)};},
    /** step 1: owner taps Approve -> typed data for trustBySig (owner signs it in his own wallet). Never signs anything itself. */
    async approve(cap,id){needOwner(cap);expireOld();const r=S.requests[String(id)];if(!r||!['awaiting_owner','awaiting_signature'].includes(r.status))throw Object.assign(Error('TRUSTREQ: not pending'),{code:'not_pending'});
      const prep=await prepare({merchantId:r.merchantName,payees:[r.payee],single:r.single,daily:r.total,expiresInDays:r.expiresInDays});if(!prep?.ok)throw Object.assign(Error('TRUSTREQ: prepare failed: '+(prep?.code??'?')),{code:prep?.code??'prepare_failed'});
      r.prepared={trust:prep.trust,nonce:prep.nonce,deadline:String(prep.deadline),digest:prep.digest};r.status='awaiting_signature';r.updatedAt=now();bump();save();
      if(ownerSigner){r.prepared.nested=true;save();return {id:r.id,status:r.status,payee:r.payee,typedData:nestedOwnerTypedData({wallet:ownerSigner.wallet,chainId,digest:prep.digest}),innerTypedData:prep.typedData,digest:prep.digest,human:prep.human,nested:true};}
      return {id:r.id,status:r.status,payee:r.payee,typedData:prep.typedData,digest:prep.digest,human:prep.human};},
    /** step 2: owner's wallet signature -> kit relays trustBySig on chain. */
    async submitSignature(cap,id,signature,{prewrapped=false}={}){needOwner(cap);expireOld();const r=S.requests[String(id)];if(!r||r.status!=='awaiting_signature'||!r.prepared)throw Object.assign(Error('TRUSTREQ: approve first'),{code:'not_awaiting_signature'});
      if(!/^0x[0-9a-fA-F]{130,}$/.test(String(signature??'')))throw Object.assign(Error('TRUSTREQ: bad signature'),{code:'bad_signature'});
      const sig=r.prepared.nested&&!prewrapped?wrapCbswSignature(ownerSigner.ownerIndex,signature):signature;// prewrapped: a second wallet owner (phone approver) already built its SignatureWrapper
      const out=await submit({trust:r.prepared.trust,nonce:r.prepared.nonce,deadline:r.prepared.deadline,signature:sig});
      r.status='trusted';r.txHash=out?.txHash??null;r.updatedAt=now();delete r.prepared;bump();save();return view(r);},
    reject(cap,id){needOwner(cap);expireOld();const r=S.requests[String(id)];if(!r||!['awaiting_owner','awaiting_signature'].includes(r.status))throw Object.assign(Error('TRUSTREQ: not pending'),{code:'not_pending'});
      r.status='rejected';r.updatedAt=now();delete r.prepared;bump();save();return view(r);},
  });
  // delete-everything: drop every request record (agent ids, merchant names, reasons). seq is kept so ids never repeat. On-chain trust is untouched.
  return {agentApi,ownerApi,ownerCapability:OWNER};}
