// SPDX-License-Identifier: AGPL-3.0-only
// PHONE SIGNER (mainnet): the owner's iPhone Secure Enclave P-256 key, Face ID-gated, as a SCOPED second owner of the wallet.
// On chain it is a KipursePhoneApprover contract (CREATE2 via the deterministic deployer) added with addOwnerAddress by the
// owner's Base Account in ONE signed batch. The approver only validates Kipurse trust / untrust / deny-signer digests for this
// wallet (caps <= maxSingle/maxDaily); it can't move funds, change limits, change owners or sign anything else.
// This server never holds the phone key; it stores the public key and verifies everything on chain.
import {clientOf,limiter} from './ratelimit.mjs';
import {langOf,X} from './i18n.mjs';import {createPublicKey,randomBytes} from 'node:crypto';import {P256} from 'ox';import fs from 'node:fs';
import {encodeAbiParameters,encodeFunctionData,getAddress,keccak256,concat,pad,toHex,parseAbi,getContractAddress} from 'viem';
import {ownAddrHtml} from './addr-display.mjs';
export const DETERMINISTIC_DEPLOYER='0x4e59b44847b379578588920cA78FbF26c0B4956C';
const ART=JSON.parse(fs.readFileSync(new URL('./phone-approver-artifact.json',import.meta.url)));
// V2 = V1 scope + KIND_PAY (one owner-initiated payDirect approval). Selected per deployment; V1 stays the default.
const ART2=JSON.parse(fs.readFileSync(new URL('./phone-approver-v2-artifact.json',import.meta.url)));
export const APPROVER_V2_ABI=ART2.abi;
// V3 = V2 minus the frozen maxSingle/maxDaily ceilings (amounts bounded only by the adapter's LIVE policy). Off unless KIPURSE_PHONE_APPROVER=v3.
const ART3=JSON.parse(fs.readFileSync(new URL('./phone-approver-v3-artifact.json',import.meta.url)));const ARTS={v1:ART,v2:ART2,v3:ART3};
/** V3 has no phone-side ceiling: recorded as uint160 max so every "<= phone ceiling" check (server + app) is a no-op. */
export const NO_CEILING=((1n<<160n)-1n).toString();export const PAY_VERSIONS=new Set(['v2','v3']);
export const WALLET_ABI=parseAbi(['function addOwnerAddress(address owner)','function removeOwnerAtIndex(uint256 index, bytes owner)','function isOwnerAddress(address account) view returns (bool)',
  'function nextOwnerIndex() view returns (uint256)','function execute(address target, uint256 value, bytes data)','function ownerAtIndex(uint256 index) view returns (bytes)','function isValidSignature(bytes32 hash, bytes signature) view returns (bytes4)']);
export const APPROVER_ABI=ART.abi;
// Upgrade gas paid from the KIPURSE WALLET's own USDC: the owner's Base Account sends the batch (pays gas up front, its own
// money) and the same atomic batch has the wallet send `fee` USDC back to that Base Account. Nobody else fronts or sponsors.
export const BASE_USDC='0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
export const ETH_USD_FEED='0xc0dedd749573f2e967a4ba53190c27ffbc2f8b31'; // Chainlink ETH/USD on Base (8 decimals)
export const UPGRADE_GAS=1_800_000n;          // measured 1,758,806 on a Base fork (deploy V2 + addOwnerAddress + USDC refund: 1,775,833)
export const L1_ALLOWANCE_WEI=1_000_000_000_000n; // Base L1 data fee allowance (0.000001 ETH)
export const FEE_MARGIN_PCT=0n;export const FEE_CAP=50_000n;export const FEE_MIN=0n; // atomic USDC: actual cost, no markup, no minimum; cap 0.05
const ERC20_ABI=parseAbi(['function balanceOf(address) view returns (uint256)','function transfer(address to, uint256 amount) returns (bool)']);
const FEED_ABI=parseAbi(['function latestRoundData() view returns (uint80, int256, uint256, uint256, uint80)']);
/** Pure: USDC (6 dp) to refund for the upgrade = (gas*price + L1 allowance) * ETH/USD at actual cost (no markup, no minimum), capped at FEE_CAP; goes to the user's own Base Account that fronts the ETH. */
export function upgradeFeeUSDC({gasPriceWei,ethUsd8}){const wei=(UPGRADE_GAS*BigInt(gasPriceWei)+L1_ALLOWANCE_WEI)*(100n+FEE_MARGIN_PCT)/100n;
  const raw=(wei*BigInt(ethUsd8)+10n**20n-1n)/10n**20n; // wei*1e-18 ETH * usd8*1e-8 * 1e6 -> ceil
  return {fee:raw<FEE_MIN?FEE_MIN:raw>FEE_CAP?FEE_CAP:raw,raw,ownerGasWei:UPGRADE_GAS*BigInt(gasPriceWei)+L1_ALLOWANCE_WEI};}
const hex32=v=>/^0x[0-9a-fA-F]{64}$/.test(String(v));
/** Valid P-256 point? (node rejects off-curve keys) */
export function p256Key(x,y){if(!hex32(x)||!hex32(y))throw Object.assign(Error('x,y must be 32-byte hex'),{code:'bad_key'});
  return createPublicKey({key:{kty:'EC',crv:'P-256',x:Buffer.from(x.slice(2),'hex').toString('base64url'),y:Buffer.from(y.slice(2),'hex').toString('base64url')},format:'jwk'});}
/** Verify a raw (r,s) P-256 signature over a 32-byte digest (no extra hashing). */
export function p256VerifyDigest({x,y},digestHex,r,s){p256Key(x,y);try{return P256.verify({payload:digestHex,publicKey:{prefix:4,x:BigInt(x),y:BigInt(y)},signature:{r:BigInt(r),s:BigInt(s)}});}catch{return false;}}
export const fingerprint=(x,y)=>keccak256(concat([x,y])).slice(2,18).toUpperCase().match(/.{4}/g).join('-');
export function approverInit({wallet,trust,x,y,maxSingle,maxDaily,version='v1'}){const A=ARTS[version];if(!A)throw Object.assign(Error('unknown approver version'),{code:'bad_version'});const args=version==='v3'?encodeAbiParameters([{type:'address'},{type:'address'},{type:'uint256'},{type:'uint256'}],[getAddress(wallet),getAddress(trust),BigInt(x),BigInt(y)]):encodeAbiParameters([{type:'address'},{type:'address'},{type:'uint256'},{type:'uint256'},{type:'uint160'},{type:'uint160'}],
  [getAddress(wallet),getAddress(trust),BigInt(x),BigInt(y),BigInt(maxSingle),BigInt(maxDaily)]);const initcode=concat([A.bytecode,args]);const salt=keccak256(concat([toHex('kipurse-phone-approver-'+version),x,y]));
  const address=getContractAddress({from:DETERMINISTIC_DEPLOYER,opcode:'CREATE2',salt,bytecode:initcode});return {initcode,salt,address,deployData:concat([salt,initcode])};}
const TRUST_T={type:'tuple',components:[{name:'merchant',type:'bytes32'},{name:'name',type:'string'},{name:'payees',type:'address[]'},{name:'signers',type:'address[]'},{name:'single',type:'uint160'},{name:'daily',type:'uint160'},{name:'expiry',type:'uint64'}]};
/** SignatureWrapper(ownerIndex, abi.encode(uint8 kind=1, abi.encode(TrustParams,nonce,deadline), r, s)) for trustBySig. m = OwnerTrust typed-data message. */
export function phoneTrustWrapper(ownerIndex,m,r,s){const body=encodeAbiParameters([TRUST_T,{type:'bytes32'},{type:'uint256'}],
  [{merchant:m.merchant,name:m.name,payees:m.payees.map(getAddress),signers:m.signers.map(getAddress),single:BigInt(m.single),daily:BigInt(m.daily),expiry:BigInt(m.expiry)},m.nonce,BigInt(m.deadline)]);
  const data=encodeAbiParameters([{type:'uint8'},{type:'bytes'},{type:'uint256'},{type:'uint256'}],[1,body,BigInt(r),BigInt(s)]);
  return encodeAbiParameters([{type:'tuple',components:[{name:'ownerIndex',type:'uint256'},{name:'signatureData',type:'bytes'}]}],[{ownerIndex:BigInt(ownerIndex),signatureData:data}]);}

export function createPhoneEnrollment({S,save,pub,wallet,trust,owner,chainId,base,caps,script,approverVersion='v1',token=BASE_USDC,feed=ETH_USD_FEED,sponsor=null,feeTo=null}){
  // t906 (owner): the fee comes from the KIPURSE WALLET; the Base Account only signs. sponsor = {available():bool, register(id,{owner,wallet,calls,reimburse})->paymasterUrl|null}.
  const statusLimit=limiter({max:60,windowMs:60e3});   // t629: public status read, 60/min per network; key x/y and owner index are no longer exposed
  S.phone??={pending:{},active:null};S.phone.pending??={};const P=()=>S.phone;   // tenants created by new-user onboarding start with only {active}
  const W=getAddress(wallet),OWNER=getAddress(owner);
  const gc=()=>{const n=Date.now();for(const [k,v] of Object.entries(P().pending))if(v.exp<n)delete P().pending[k];};
  const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const usd=v=>(Number(BigInt(v))/1e6).toString();
  const J=x=>JSON.stringify(x,(k,v)=>typeof v==='bigint'?v.toString():v).replace(/</g,'\\u003c');
  async function findIndex(addr){const n=Number(await pub.readContract({address:W,abi:WALLET_ABI,functionName:'nextOwnerIndex'}));const want=pad(getAddress(addr)).toLowerCase();
    for(let i=n-1;i>=0;i--){const b=await pub.readContract({address:W,abi:WALLET_ABI,functionName:'ownerAtIndex',args:[BigInt(i)]});if(String(b).toLowerCase()===want)return i;}return -1;}
  async function quoteNow(){const [gp,rd]=await Promise.all([pub.getGasPrice(),pub.readContract({address:feed,abi:FEED_ABI,functionName:'latestRoundData'})]);
    const px=BigInt(rd[1]);if(px<=0n||Date.now()/1e3-Number(rd[3])>86400)throw Object.assign(Error('ETH price unavailable'),{code:'no_price'});return upgradeFeeUSDC({gasPriceWei:gp,ethUsd8:px});}
  /** What the app shows before signing (the SAME fee the batch refunds): wallet USDC vs fee, and can the Base Account front the gas. */
  async function quote(id){const e=P().pending[id];if(!e)throw Object.assign(Error('unknown or expired enrollment'),{code:'unknown'});
    const [bal,eth,gp,obal]=await Promise.all([pub.readContract({address:token,abi:ERC20_ABI,functionName:'balanceOf',args:[W]}),pub.getBalance({address:OWNER}),pub.getGasPrice(),pub.readContract({address:token,abi:ERC20_ABI,functionName:'balanceOf',args:[OWNER]}).catch(()=>0n)]);
    const fee=BigInt(e.fee??0);const ownerGasWei=UPGRADE_GAS*gp+L1_ALLOWANCE_WEI;
    return {fee:fee.toString(),feeUSDC:usd(fee),cap:FEE_CAP.toString(),wallet:W,walletUSDC:bal.toString(),enough:bal>=fee,ownerUSDC:obal.toString(),ownerCanPayUSDC:obal>=fee*3n/2n,usdcReady:e.paymaster?bal>=fee:bal>=fee&&obal>=fee*3n/2n,walletPays:!!e.paymaster,owner:OWNER,ownerEthWei:eth.toString(),ownerGasWei:ownerGasWei.toString(),ownerCanPayEth:eth>=ownerGasWei};}
  async function enroll({x,y}){gc();p256Key(x,y);if(Object.keys(P().pending).length>=5)throw Object.assign(Error('too many pending enrollments'),{code:'busy'});
    const c=caps();const a=approverInit({wallet:W,trust,x,y,maxSingle:c.single,maxDaily:c.daily,version:approverVersion});const q=await quoteNow();const id=randomBytes(12).toString('hex');let remove=await deadOwners(a.address);
    // t843: a new phone (or app copy) replaces the active approver in ONE owner signature: add new, then remove exactly the old one
    const old=P().active;const oldIdx=old&&getAddress(old.approver)!==getAddress(a.address)?await findIndex(old.approver):-1;const replaces=oldIdx>=0?getAddress(old.approver):null;
    if(replaces)remove=[{approver:replaces,index:oldIdx}];
    // version upgrade to V3 only (same-version rebinds keep the 2-step retiring flow): remove the current approver in the SAME batch (it keeps its index: the new owner is appended at the end)
    {const cur=P().active;if(cur&&approverVersion==='v3'&&cur.version!=='v3'&&getAddress(cur.approver)!==getAddress(a.address)&&!remove.some(r=>getAddress(r.approver)===getAddress(cur.approver))){const i=await findIndex(cur.approver);if(i>=0)remove.push({approver:getAddress(cur.approver),index:i});}}
    P().pending[id]={x,y,remove,replaces,maxSingle:String(c.single),maxDaily:String(c.daily),approver:a.address,version:approverVersion,fee:q.fee.toString(),exp:Date.now()+30*60e3};
    // t906: wallet-pays if the sponsor is on (same caps): fee goes to the fixed fee address, gas fronted by the sponsor -> Base Account needs no USDC/ETH
    if(sponsor&&feeTo&&q.fee>0n){try{if(sponsor.available()){const e=P().pending[id];e.feeTo=getAddress(feeTo);const pm=await sponsor.register(id,{owner:OWNER,wallet:W,calls:calls(e),reimburse:q.fee});if(pm)e.paymaster=pm;else delete e.feeTo;}}catch{delete P().pending[id].feeTo;delete P().pending[id].paymaster;}}
    save();
    return {id,url:`${base()}/phone/enroll?id=${id}`,fingerprint:fingerprint(x,y),approver:a.address,fee:q.fee.toString(),feeUSDC:usd(q.fee),removes:remove.map(r=>r.approver),replaces,
      /* t621 #1: the app decodes + checks these exact calls itself before the page may send them */ calls:calls(P().pending[id]),owner:OWNER,wallet:W,chainId,version:approverVersion,feeTo:P().pending[id].feeTo??null,walletPays:!!P().pending[id].paymaster};}
  function calls(e){const a=approverInit({wallet:W,trust,x:e.x,y:e.y,maxSingle:e.maxSingle,maxDaily:e.maxDaily,version:e.version??'v1'});
    return [{to:DETERMINISTIC_DEPLOYER,value:'0x0',data:a.deployData},{to:W,value:'0x0',data:encodeFunctionData({abi:WALLET_ABI,functionName:'addOwnerAddress',args:[a.address]})}]
      .concat((e.remove??[]).map(removeCall)).concat(BigInt(e.fee??0)>0n?[{to:W,value:'0x0',data:encodeFunctionData({abi:WALLET_ABI,functionName:'execute',args:[getAddress(token),0n,encodeFunctionData({abi:ERC20_ABI,functionName:'transfer',args:[e.feeTo?getAddress(e.feeTo):OWNER,BigInt(e.fee)]})]})}]:[]);}
  async function confirm(id){const e=P().pending[id];if(!e)throw Object.assign(Error('unknown or expired enrollment'),{code:'unknown'});
    const code=await pub.getCode({address:e.approver});if(!code||code==='0x')return {ok:false,detail:'not on chain yet'};
    const [x,y,w]=await Promise.all(['x','y','wallet'].map(f=>pub.readContract({address:e.approver,abi:APPROVER_ABI,functionName:f})));
    if(BigInt(x)!==BigInt(e.x)||BigInt(y)!==BigInt(e.y)||getAddress(w)!==W)throw Object.assign(Error('approver mismatch'),{code:'mismatch'});
    if(!await pub.readContract({address:W,abi:WALLET_ABI,functionName:'isOwnerAddress',args:[e.approver]}))return {ok:false,detail:'not an owner yet'};
    const index=await findIndex(e.approver);const old=P().active;
    // migration: the replaced approver stays an on-chain owner until the owner removes it (retiringCalls / retiringConfirm)
    if(old&&getAddress(old.approver)!==getAddress(e.approver)&&await pub.readContract({address:W,abi:WALLET_ABI,functionName:'isOwnerAddress',args:[old.approver]}))P().retiring=old;
    const v3=e.version==='v3';P().active={approver:e.approver,index,x:e.x,y:e.y,maxSingle:v3?NO_CEILING:e.maxSingle,maxDaily:v3?NO_CEILING:e.maxDaily,version:e.version??'v1',fingerprint:fingerprint(e.x,e.y),at:new Date().toISOString()};delete P().pending[id];save();if(P().dead)await pruneDead();return {ok:true,...P().active,deadLeft:P().dead??[]};}
  async function revokeCalls(){const a=P().active;if(!a)throw Object.assign(Error('no phone signer'),{code:'none'});const index=await findIndex(a.approver);if(index<0)return null;
    return [{to:W,value:'0x0',data:encodeFunctionData({abi:WALLET_ABI,functionName:'removeOwnerAtIndex',args:[BigInt(index),pad(getAddress(a.approver))]})}];}
  async function revokeConfirm(){const a=P().active;if(!a)return {ok:true};if(await pub.readContract({address:W,abi:WALLET_ABI,functionName:'isOwnerAddress',args:[a.approver]}))return {ok:false,detail:'still an owner'};
    P().active=null;save();return {ok:true};}
  /** Migration step 2: remove the replaced approver from the wallet (owner signs these calls in the wallet). */
  async function retiringCalls(){const a=P().retiring;if(!a)return null;const index=await findIndex(a.approver);if(index<0)return null;
    return [{to:W,value:'0x0',data:encodeFunctionData({abi:WALLET_ABI,functionName:'removeOwnerAtIndex',args:[BigInt(index),pad(getAddress(a.approver))]})}];}
  async function retiringConfirm(){const a=P().retiring;if(!a)return {ok:true};if(await pub.readContract({address:W,abi:WALLET_ABI,functionName:'isOwnerAddress',args:[a.approver]}))return {ok:false,detail:'still an owner'};
    delete P().retiring;save();return {ok:true};}
  /** Does the active approver support owner payments (V2) and is it still an owner on chain right now? */
  async function payCapable(){const a=P().active;if(!a||!PAY_VERSIONS.has(a.version))return {ok:false,code:'phone_needs_upgrade'};
    if(!await pub.readContract({address:W,abi:WALLET_ABI,functionName:'isOwnerAddress',args:[a.approver]}))return {ok:false,code:'phone_not_owner'};
    const index=await findIndex(a.approver);if(index<0)return {ok:false,code:'phone_not_owner'};return {ok:true,active:a,index};}
  /** Delete-everything: forget this wallet's enrollment records (on-chain ownership is removed by the owner separately). */
  // Keeps ONLY the approver contract addresses that are still wallet owners (no key, fingerprint, caps or times), so the next phone
  // binding can remove those dead owners in the same owner signature.
  function forget(){const d=new Set((P().dead??[]).map(a=>getAddress(a)));for(const r of [P().active,P().retiring])if(r?.approver)d.add(getAddress(r.approver));
    S.phone={pending:{},active:null,...(d.size?{dead:[...d]}:{})};save();}
  /** Dead approvers still on chain -> [{approver,index}] (index read now; removeOwnerAtIndex does not shift other indices). */
  async function deadOwners(exclude){const out=[];for(const a of P().dead??[]){if(exclude&&getAddress(a)===getAddress(exclude))continue;const i=await findIndex(a);if(i>=0)out.push({approver:getAddress(a),index:i});}return out;}
  const removeCall=r=>({to:W,value:'0x0',data:encodeFunctionData({abi:WALLET_ABI,functionName:'removeOwnerAtIndex',args:[BigInt(r.index),pad(getAddress(r.approver))]})});
  async function pruneDead(){const left=[];for(const a of P().dead??[])if(await pub.readContract({address:W,abi:WALLET_ABI,functionName:'isOwnerAddress',args:[a]}))left.push(a);
    if(left.length)P().dead=left;else delete P().dead;save();return left;}
  function page(title,inner,nonce,data,lang='zh'){return `<!doctype html><html lang=${lang}><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<style>body{margin:0;background:#F2F2F7;color:#111;font:17px/1.45 -apple-system,"PingFang SC",sans-serif}.w{max-width:480px;margin:0 auto;padding:22px 18px 40px}.c{background:#fff;border-radius:16px;padding:14px 16px;margin:12px 0}
.t{font-size:24px;font-weight:700;margin:10px 0}.fp{font:700 26px ui-monospace,monospace;letter-spacing:1px;text-align:center;padding:10px;background:#EEF;border-radius:12px}.mono{font:13px ui-monospace,monospace;word-break:break-all}
.warn{background:rgba(220,38,38,.1);color:#c81e1e;border-radius:14px;padding:12px 14px;font-weight:600}button{display:block;width:100%;border:0;border-radius:14px;padding:15px;font-size:18px;font-weight:600;margin-top:10px;background:#5B4CF0;color:#fff}.m{color:#666;font-size:14px}.fee{font-weight:600;margin:12px 0 4px}.need{background:#FFF4E5;color:#7a4a00;border-radius:14px;padding:12px 14px;margin-top:10px}details summary{font-weight:600;cursor:pointer}#go{font-size:20px;padding:17px}</style>
<div style="background:#c00;color:#fff;text-align:center;font-weight:700;padding:8px">${X(lang)('Base 主网','Base Mainnet')}</div><div class=w>${inner}</div>${data?`<script type="application/json" id=kp-data>${J(data)}</script><script nonce="${nonce}" src="/owner/limits-done.js?v=20261022b"></script><script nonce="${nonce}" src="/phone/enroll.js"></script>`:''}</html>`;}
  const scope=(t,v3,S,D)=>`<div class=c><b>${t('手机确认能做的（只有这些）','What the phone signer can do (only this)')}</b><ul><li>${v3?t('批准 / 拒绝 AI 申请的收款方，以及用 Face ID 批准 Siri 付款（金额都受你在 App 里设的钱包限额约束，改限额后立刻生效，不用重新绑定）','Approve or reject payees your AI asks for, and approve Siri payments with Face ID (amounts always stay within the wallet limits you set in the app; limit changes apply at once, no re-binding)'):t(`批准 / 拒绝 AI 申请的收款方（每笔 ≤ ${S} USDC，每天 ≤ ${D} USDC）`,`Approve or reject payees your AI asks for (≤ ${S} USDC per payment, ≤ ${D} USDC per day)`)}</li><li>${t('取消信任、拉黑商户确认人','Remove trust and block merchant signers')}</li></ul><b>${t('不能做的','What it can’t do')}</b><ul><li>${t('不能转走钱，不能提现到别的地址','Can’t move money out or withdraw to another address')}</li><li>${t('不能调高上限、不能改钱包主人','Can’t raise limits or change the wallet owner')}</li><li>${t('不能签任何别的东西（链上合约限制）','Can’t sign anything else (enforced by the on-chain contract)')}</li></ul><div class=m>${t('随时可以在这里用 Base Account 撤销。','You can revoke it here with your Base Account at any time.')}</div></div>`;
  async function handle(req,res,u,{readBody}){const p=u.pathname;if(!p.startsWith('/phone/'))return false;
    const json=(c,o)=>{res.writeHead(c,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(o,(k,v)=>typeof v==='bigint'?v.toString():v));};
    const nonce=randomBytes(12).toString('base64url');const html=(c,b)=>{res.writeHead(c,{'content-type':'text/html; charset=utf-8','cache-control':'no-store','x-frame-options':'DENY','referrer-policy':'no-referrer',
      'content-security-policy':`default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; connect-src 'self' https://*.coinbase.com https://mainnet.base.org https://mainnet-preconf.base.org; frame-src https://keys.coinbase.com; form-action 'none'; frame-ancestors 'none'`});res.end(b);};
    try{
      if(p==='/phone/enroll.js'){res.writeHead(200,{'content-type':'text/javascript; charset=utf-8','cache-control':'no-store'});res.end(script());return true;}
      if(p==='/phone/status'&&req.method==='GET'){if(!statusLimit(clientOf(req))){json(429,{error:'rate_limited'});return true;}const a=P().active;json(200,{active:a?{approver:a.approver,fingerprint:a.fingerprint,maxSingle:a.maxSingle,maxDaily:a.maxDaily,version:a.version??'v1',...(approverVersion==='v3'&&(a.version??'v1')!=='v3'?{upgradeTo:'v3'}:{})}:null,wallet:W,chainId});return true;}
      if(p==='/phone/enroll'&&req.method==='POST'){const b=await readBody(req);json(200,await enroll({x:String(b.x),y:String(b.y)}));return true;}
      if(p==='/phone/enroll/quote'&&req.method==='GET'){json(200,await quote(String(u.searchParams.get('id')??'')));return true;}
      if(p==='/phone/enroll'&&req.method==='GET'){gc();const lang=langOf(req,u),t=X(lang);const id=String(u.searchParams.get('id')??'');const e=P().pending[id];
        if(!e){html(404,page(t('找不到','Not found'),`<div class=t>${t('这个添加请求不存在或已过期','This request doesn’t exist or has expired')}</div><p>${t('请在 Kipurse App 里重新点「添加这台手机」。','Tap “Add this phone” again in the Kipurse app.')}</p>`,nonce,null,lang));return true;}
        const fee=esc(usd(e.fee??0));// t905 (owner): short card. One sentence, the code to compare, the fee, ONE big button; everything else folded.
        let q=null;try{q=await quote(id);}catch{}
        const head=`<div class=t id=kp-replace>${e.replaces?t('添加这台手机','Add this phone'):t('添加这台手机','Add this phone')}</div><p id=kp-replace-why>${t('开启后，超额、新收款方、恢复暂停时，用这台手机的 Face ID 批准。','After this, over-limit payments, new payees and resuming are approved with this phone’s Face ID.')}${e.replaces?t('旧手机的批准会同时停用。','The old phone’s approval stops at the same time.'):''}</p>`;
        const code=`<div class=m>${t('核对码（要和启付 App 里的一样）','Check code (must match the Kipurse app)')}</div><div class=fp>${esc(fingerprint(e.x,e.y))}</div>`;
        const feeLine=e.paymaster?`<p class=fee id=kp-fee-wallet>${t(`手续费 ${fee} USDC，从你的启付钱包余额扣除。Base Account 不用 USDC、不用 ETH。`,`Fee ${fee} USDC, deducted from your Kipurse wallet balance. Your Base Account needs no USDC and no ETH.`)}</p><p class=m>${t('Coinbase 确认页上的手续费会显示为划掉、“由 Your Kipurse balance 赞助”（即你的启付钱包余额）：这笔费用就是上面从启付钱包扣的钱，Kipurse 不出钱。','On the Coinbase screen the network fee shows crossed out, “sponsored by Your Kipurse balance”: that is the fee above, taken from your Kipurse wallet. Kipurse pays nothing.')}</p>`:`<p class=fee>${t(`手续费 ${fee} USDC，从启付钱包付，不用 ETH。`,`Fee ${fee} USDC, paid from your Kipurse wallet. No ETH.`)}</p>`;
        let act;
        if(q&&!q.enough)act=`<div class=need id=need><b>${t('先充值','Add money first')}</b><br>${t(`启付钱包的 USDC 不够付手续费（${fee} USDC）。回到启付 App 点「充值」，再回来。没有扣钱。`,`Your Kipurse wallet doesn’t have enough USDC for the fee (${fee} USDC). Go back to the Kipurse app, tap Deposit, then come back. Nothing was charged.`)}</div>`;
        else if(q&&!q.usdcReady)act=`<div class=need id=need><b>${t('还差一步：Base Account 里要有一点 USDC','One more thing: your Base Account needs a little USDC')}</b><br>${t(`确认时 Base Account 要先垫付约 ${fee} USDC（同一笔里马上从启付钱包退回）。现在 Base Account 里是 0 USDC，所以确认按钮先不出现，免得 Coinbase 要你付 ETH。往 Base Account 转入 0.1 USDC 后刷新本页即可。没有扣钱。`,`To confirm, your Base Account fronts about ${fee} USDC (refunded from your Kipurse wallet in the same transaction). It has 0 USDC now, so the button stays hidden to avoid Coinbase asking for ETH. Send 0.1 USDC to your Base Account, then reload this page. Nothing was charged.`)}</div>`;
        else act=`<button id=go>${t('确认','Confirm')}</button>`;
        const more=`<details class=c><summary>${t('详细信息','Details')}</summary>${e.replaces?`<div class=m>${t('要移除的旧批准','Old approval to remove')}</div><div class=mono>${esc(e.replaces)}</div>`:''}
${scope(t,e.version==='v3',e.version==='v3'?'':usd(e.maxSingle),e.version==='v3'?'':usd(e.maxDaily))}<div class=m>${t('钱包','Wallet')}</div><div class=mono>${ownAddrHtml(W,t)}</div><div class=m>${t('手机确认合约（将要创建）','Phone signer contract (to be created)')}</div><div class=mono>${ownAddrHtml(e.approver,t)}</div>${(e.remove??[]).length?`<div class=m>${t(`同一笔确认里移除旧的、已作废的手机确认人（${e.remove.length} 个）`,`The same signature removes ${e.remove.length} old, retired phone signer(s)`)}</div>${e.remove.map(r=>`<div class=mono>${ownAddrHtml(r.approver,t)}</div>`).join('')}`:''}
${e.paymaster?`<p class=m>${t(`手续费细节：同一笔交易里，启付钱包把 ${fee} USDC（最多 0.05）付给 Kipurse 运营地址 ${esc(e.feeTo)}，用来付这笔交易的手续费。Base Account 只需要确认。`,`Fee detail: in the same transaction your Kipurse wallet pays ${fee} USDC (max 0.05) to the Kipurse ops address ${esc(e.feeTo)}, which covers this transaction’s network fee. Your Base Account only signs.`)}</p>`:`<p class=m>${t(`手续费细节：Base Account 先用 USDC 垫付，同一笔交易里启付钱包退还 ${fee} USDC（最多 0.05）。Kipurse 不出钱、不代付。`,`Fee detail: your Base Account fronts it in USDC; in the same transaction your Kipurse wallet refunds ${fee} USDC (max 0.05). Kipurse pays nothing.`)}</p>`}
<p class=m>${t('只有你自己刚在启付 App 里点了「添加这台手机」才继续。这个合约是 Kipurse 新写的，未经外部审计。','Only continue if you just tapped “Add this phone” in the Kipurse app. This contract is new Kipurse code, not externally audited.')}</p></details>`;
        html(200,page(t('添加这台手机','Add this phone'),`<div class=c>${head}${code}${feeLine}${act}<p class=m id=st></p></div>${more}`,nonce,{mode:'enroll',id,owner:OWNER,chainId,calls:calls(e),...(e.paymaster?{paymaster:e.paymaster,feeTo:e.feeTo}:{})},lang));return true;}
      if(p==='/phone/enroll/confirm'&&req.method==='POST'){const b=await readBody(req);json(200,await confirm(String(b.id??'')));return true;}
      if(p==='/phone/revoke'&&req.method==='GET'){const lang=langOf(req,u),t=X(lang);const a=P().active;if(!a){html(200,page(t('撤销','Revoke'),`<div class=t>${t('现在没有手机确认人','There is no phone signer now')}</div>`,nonce,null,lang));return true;}const c=await revokeCalls();
        if(!c){P().active=null;save();html(200,page(t('撤销','Revoke'),`<div class=t>${t('手机确认人已经不在钱包里了','The phone signer is no longer in the wallet')}</div>`,nonce,null,lang));return true;}
        html(200,page(t('撤销手机确认','Revoke phone signer'),`<div class=t>${t('撤销手机确认人','Revoke phone signer')}</div><div class=fp>${esc(a.fingerprint)}</div><p>${t('撤销后，这台手机不能再批准任何东西。钱包和 Base Account 不受影响。','After revoking, this phone can’t approve anything. Your wallet and Base Account are not affected.')}</p><button id=go>${t('用 Base Account 确认撤销','Sign with Base Account to revoke')}</button><p class=m id=st></p>`,nonce,{mode:'revoke',owner:OWNER,chainId,calls:c},lang));return true;}
      if(p==='/phone/revoke/plan'&&req.method==='GET'){const a=P().active;const c=a?await revokeCalls():null;json(200,{calls:c??[],owner:OWNER,wallet:W,chainId,approver:a?.approver??null});return true;}/* t621 #1: app checks before the page */
      if(p==='/phone/revoke/confirm'&&req.method==='POST'){json(200,await revokeConfirm());return true;}
      json(404,{error:'not_found'});return true;
    }catch(e){json(400,{error:e.code??'failed',detail:String(e.message).slice(0,200)});return true;}}
  return {handle,quote,active:()=>P().active,retiring:()=>P().retiring??null,enroll,confirm,calls,revokeCalls,revokeConfirm,retiringCalls,retiringConfirm,payCapable,forget,findIndex,deadOwners,pruneDead,removeCall,dead:()=>P().dead??[],
    /** One-time setup (onboard.mjs) registers its approver here so the normal confirm() path verifies and activates it. */
    addPending:e=>{gc();const id=randomBytes(12).toString('hex');P().pending[id]={...e,fee:'0',exp:Date.now()+30*60e3};save();return id;}};}
