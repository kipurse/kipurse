// t624u: Kipurse does no KYC of its own. It relies on Coinbase's prior KYC through the public on-chain
// "Coinbase Verified Account" attestation (EAS on Base). Read-only, free; no identity data is stored or sent anywhere.
import {getAddress,isAddress} from 'viem';
export const CBV={schema:'0xf8b05c79f090979bf4a80270aba232dff11a10d9ca55c4f88de95317970f0de9',attester:'0x357458739F90461b99789350868CD7CF330Dd7EE',
  indexer:'0x2c7eE1E5f416dfF40054c27A62f7B357C4E8619C',eas:'0x4200000000000000000000000000000000000021',verifyUrl:'https://www.coinbase.com/onchain-verify'};
const IDX=[{name:'getAttestationUid',type:'function',stateMutability:'view',inputs:[{type:'address'},{type:'bytes32'}],outputs:[{type:'bytes32'}]}];
const EAS=[{name:'getAttestation',type:'function',stateMutability:'view',inputs:[{type:'bytes32'}],outputs:[{type:'tuple',components:[
  {name:'uid',type:'bytes32'},{name:'schema',type:'bytes32'},{name:'time',type:'uint64'},{name:'expirationTime',type:'uint64'},{name:'revocationTime',type:'uint64'},
  {name:'refUID',type:'bytes32'},{name:'recipient',type:'address'},{name:'attester',type:'address'},{name:'revocable',type:'bool'},{name:'data',type:'bytes'}]}]}];
const Z='0x'+'0'.repeat(64);
/** -> {verified:boolean, reason, uid?}. Throws only on RPC failure (callers fail closed). */
export async function checkVerified(pub,address,{now=()=>Math.floor(Date.now()/1e3)}={}){
  if(!isAddress(String(address)))return {verified:false,reason:'bad_address'};const a=getAddress(address);
  const uid=await pub.readContract({address:CBV.indexer,abi:IDX,functionName:'getAttestationUid',args:[a,CBV.schema]});
  if(!uid||uid===Z)return {verified:false,reason:'none'};
  const t=await pub.readContract({address:CBV.eas,abi:EAS,functionName:'getAttestation',args:[uid]});
  if(t.schema.toLowerCase()!==CBV.schema)return {verified:false,reason:'wrong_schema'};
  if(getAddress(t.attester)!==getAddress(CBV.attester))return {verified:false,reason:'wrong_attester'};
  if(getAddress(t.recipient)!==a)return {verified:false,reason:'wrong_recipient'};
  if(BigInt(t.revocationTime)!==0n)return {verified:false,reason:'revoked'};
  if(BigInt(t.expirationTime)!==0n&&BigInt(t.expirationTime)<=BigInt(now()))return {verified:false,reason:'expired'};
  // data = abi bool verifiedAccount (always true)
  if(!/^0x0{63}1$/i.test(t.data))return {verified:false,reason:'bad_data'};
  return {verified:true,reason:'ok',uid};}
export const CBV_GUIDE={zh:'开通前需要一次 Coinbase 身份验证（启付自己不收集任何身份信息）。\n1. 打开 Coinbase App 或 coinbase.com，用已完成身份验证的账户登录。\n2. 打开「链上验证」（Onchain verification），选「Verified Account」。\n3. 连接你登录启付用的那个 Base 账户，确认（免费）。\n4. 回到启付，点「我已验证，重新检查」。',
  en:'Before opening, you need a one-time Coinbase verification (Kipurse itself collects no identity data).\n1. Open the Coinbase app or coinbase.com and sign in to your verified account.\n2. Open Onchain verification and choose Verified Account.\n3. Connect the same Base Account you use with Kipurse and confirm (free).\n4. Come back to Kipurse and tap "I verified, check again".'};
/** Same check over several RPCs: first definite answer wins; retries each RPC; if every RPC fails -> throws (callers fail closed).
 *  Logs carry no address or other personal data, only the outcome. */
export async function checkVerifiedMulti(pubs,address,{tries=2,log=()=>{},now}={}){let last;
  for(const pub of pubs)for(let i=0;i<tries;i++){try{const r=await checkVerified(pub,address,{now});log({cbv:r.reason});return r;}catch(e){last=e;}}
  log({cbv:'rpc_unavailable'});throw Object.assign(Error('verification check unavailable'),{code:'verify_unavailable',cause:last});}
