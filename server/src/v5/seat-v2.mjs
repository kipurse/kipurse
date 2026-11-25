// SPDX-License-Identifier: AGPL-3.0-only
// t1250 (decision 119): Face ID KEY SEAT V2 (V5.5) - addresses, the six owner digests, the phone signature wrapper and the KPTR inline
// trust blob. Mirrors KipurseKeySeatV2 exactly; test/fixtures/v55-vectors.json pins every value against the deployed contracts on a fork.
// V55-01: the seat builds every digest ITSELF (hard-coded typehashes, domain "Kipurse Owner" / "5" / chainId / V5.5 adapter). The app and
// this server compute the same digests LOCALLY and never sign a digest returned by a contract view.
// KL-5: the seat accepts only canonical low-s P-256 signatures (0 < s <= n/2): every signature is normalised here (s -> n - s).
// Not imported by any running path unless KIPURSE_V55=1.
import fs from 'node:fs';
import {concat,encodeAbiParameters,encodeFunctionData,getAddress,getContractAddress,keccak256,toHex,toBytes,hashTypedData,encodePacked,parseAbi} from 'viem';
import {V55} from './suite-v55.mjs';
const ART=JSON.parse(fs.readFileSync(new URL('./key-seat-v2-artifact.json',import.meta.url)));
export const SEAT_V2_ABI=ART.abi;
export const SEAT_V2_VERSION='seat2';
export const SEAT_V2_SALT=keccak256(toHex('kipurse-key-seat-v2'));
export const SEAT_V2_INDEX=1;   // owners [0 Base Account, 1 seat V2, 2 SpendPermissionManager]
export const KIND={TRUST:1,UNTRUST:2,DENY_SIGNER:3,PAY:4,SIGNER_TRUST:5,INLINE_TRUST:6};
export const P256_N=0xFFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551n;
export const NO_EXPIRY=(1n<<64n)-1n;
export const INLINE_TRUST_TAG='0x4b505452';
const enc=a=>encodeAbiParameters([{type:'address'}],[getAddress(a)]);
/** CREATE2 (deterministic deployer) of the V2 seat for this owner: initcode = creationCode ‖ abi.encode(factory, owner, SPM, trustV55). */
export function seatV2Init({factory=V55.cbswFactory,owner,spm=V55.spm,trust=V55.trust}){
  const initcode=concat([ART.bytecode,encodeAbiParameters([{type:'address'},{type:'address'},{type:'address'},{type:'address'}],[getAddress(factory),getAddress(owner),getAddress(spm),getAddress(trust)])]);
  const address=getContractAddress({from:V55.deployer,opcode:'CREATE2',salt:SEAT_V2_SALT,bytecode:initcode});
  return {initcode,salt:SEAT_V2_SALT,address,deployData:concat([SEAT_V2_SALT,initcode])};}
export const seatV2Owners=(owner,seat,spm=V55.spm)=>[enc(owner),enc(seat),enc(spm)];
/** Coinbase Smart Wallet factory address (pure): CREATE2(factory, keccak256(abi.encode(bytes[] owners, uint256 nonce)), factory.initCodeHash()).
 *  initCodeHash is a constant of the deployed factory (pinned in the vectors file). */
export function cbswAddress({owners,nonce=0n,factory=V55.cbswFactory,initCodeHash}){
  const salt=keccak256(encodeAbiParameters([{type:'bytes[]'},{type:'uint256'}],[owners,BigInt(nonce)]));
  return getContractAddress({from:getAddress(factory),opcode:'CREATE2',salt,bytecodeHash:initCodeHash});}
/** owner -> {seat, owners, wallet}: everything the new V5.5 wallet is, before anything is sent. */
export function newWalletV55({owner,initCodeHash}){const seat=seatV2Init({owner});const owners=seatV2Owners(owner,seat.address);
  return {seat,owners,wallet:initCodeHash?cbswAddress({owners,initCodeHash}):null};}
const W=parseAbi(['function execute(address target,uint256 value,bytes data)']);
export function setKeyCallV2(wallet,seat,x,y){return {to:getAddress(wallet),value:'0x0',data:encodeFunctionData({abi:W,functionName:'execute',args:[getAddress(seat),0n,encodeFunctionData({abi:SEAT_V2_ABI,functionName:'setKey',args:[BigInt(x),BigInt(y)]})]})};}
export function clearKeyCallV2(wallet,seat){return {to:getAddress(wallet),value:'0x0',data:encodeFunctionData({abi:W,functionName:'execute',args:[getAddress(seat),0n,encodeFunctionData({abi:SEAT_V2_ABI,functionName:'clearKey'})]})};}

// ---------------- the six owner structs (EIP-712, domain "Kipurse Owner" v5, verifyingContract = V5.5 adapter) ----------------
export const OWNER_TYPES_V55={
  OwnerTrust:[{name:'account',type:'address'},{name:'merchant',type:'bytes32'},{name:'name',type:'string'},{name:'epoch',type:'uint64'},{name:'payees',type:'address[]'},{name:'signers',type:'address[]'},
    {name:'single',type:'uint160'},{name:'daily',type:'uint160'},{name:'expiry',type:'uint64'},{name:'nonce',type:'bytes32'},{name:'deadline',type:'uint256'}],
  OwnerInlineTrust:[{name:'account',type:'address'},{name:'merchant',type:'bytes32'},{name:'name',type:'string'},{name:'epoch',type:'uint64'},{name:'payees',type:'address[]'},{name:'signers',type:'address[]'},
    {name:'single',type:'uint160'},{name:'daily',type:'uint160'},{name:'expiry',type:'uint64'},{name:'nonce',type:'bytes32'},{name:'deadline',type:'uint256'}],
  OwnerUntrust:[{name:'account',type:'address'},{name:'merchant',type:'bytes32'},{name:'nonce',type:'bytes32'},{name:'deadline',type:'uint256'}],
  OwnerDenySigner:[{name:'account',type:'address'},{name:'signer',type:'address'},{name:'nonce',type:'bytes32'},{name:'deadline',type:'uint256'}],
  OwnerApproval:[{name:'account',type:'address'},{name:'purchaseKey',type:'bytes32'},{name:'payee',type:'address'},{name:'amount',type:'uint256'},{name:'deadline',type:'uint256'}],
  OwnerSignerTrust:[{name:'account',type:'address'},{name:'merchant',type:'bytes32'},{name:'name',type:'string'},{name:'epoch',type:'uint64'},{name:'signers',type:'address[]'},
    {name:'single',type:'uint160'},{name:'daily',type:'uint160'},{name:'expiry',type:'uint64'},{name:'nonce',type:'bytes32'},{name:'deadline',type:'uint256'}]};
export const PRIMARY_OF_KIND={1:'OwnerTrust',2:'OwnerUntrust',3:'OwnerDenySigner',4:'OwnerApproval',5:'OwnerSignerTrust',6:'OwnerInlineTrust'};
export const ownerDomainV55=({adapter=V55.adapter,chainId=V55.chainId}={})=>({name:'Kipurse Owner',version:'5',chainId:Number(chainId),verifyingContract:getAddress(adapter)});
export const merchantIdOf=name=>keccak256(toBytes(String(name)));
const TP={type:'tuple',components:[{name:'merchant',type:'bytes32'},{name:'name',type:'string'},{name:'payees',type:'address[]'},{name:'signers',type:'address[]'},{name:'single',type:'uint160'},{name:'daily',type:'uint160'},{name:'expiry',type:'uint64'}]};
const ST={type:'tuple',components:[{name:'merchant',type:'bytes32'},{name:'name',type:'string'},{name:'signers',type:'address[]'},{name:'single',type:'uint160'},{name:'daily',type:'uint160'},{name:'expiry',type:'uint64'}]};
const tp=t=>({merchant:t.merchant,name:t.name,payees:(t.payees??[]).map(getAddress),signers:(t.signers??[]).map(getAddress),single:BigInt(t.single),daily:BigInt(t.daily),expiry:BigInt(t.expiry)});
const st=t=>({merchant:t.merchant,name:t.name,signers:(t.signers??[]).map(getAddress),single:BigInt(t.single),daily:BigInt(t.daily),expiry:BigInt(t.expiry)});
/** The seat body for each kind (what goes inside abi.encode(kind, body, r, s)). */
export function seatBody(kind,i){switch(Number(kind)){
  case 1:case 6:return encodeAbiParameters([TP,{type:'bytes32'},{type:'uint256'}],[tp(i.trust),i.nonce,BigInt(i.deadline)]);
  case 2:return encodeAbiParameters([{type:'bytes32'},{type:'bytes32'},{type:'uint256'}],[i.merchant,i.nonce,BigInt(i.deadline)]);
  case 3:return encodeAbiParameters([{type:'address'},{type:'bytes32'},{type:'uint256'}],[getAddress(i.signer),i.nonce,BigInt(i.deadline)]);
  case 4:return encodeAbiParameters([{type:'bytes32'},{type:'address'},{type:'uint256'},{type:'uint256'}],[i.purchaseKey,getAddress(i.payee),BigInt(i.amount),BigInt(i.deadline)]);
  case 5:return encodeAbiParameters([ST,{type:'bytes32'},{type:'uint256'}],[st(i.grant),i.nonce,BigInt(i.deadline)]);
  default:throw Error('unknown seat kind '+kind);}}
/** EIP-712 typed data of a kind for `wallet` (epoch = trust.trustOf(wallet, merchant).epoch for kinds 1 / 5 / 6). */
export function ownerTypedDataV55(kind,{wallet,adapter=V55.adapter,chainId=V55.chainId,epoch=0n,...i}){const k=Number(kind);const primaryType=PRIMARY_OF_KIND[k];if(!primaryType)throw Error('unknown seat kind '+kind);
  const A=getAddress(wallet);let message;
  if(k===1||k===6){const t=tp(i.trust);message={account:A,merchant:t.merchant,name:t.name,epoch:BigInt(epoch),payees:t.payees,signers:t.signers,single:t.single,daily:t.daily,expiry:t.expiry,nonce:i.nonce,deadline:BigInt(i.deadline)};}
  else if(k===2)message={account:A,merchant:i.merchant,nonce:i.nonce,deadline:BigInt(i.deadline)};
  else if(k===3)message={account:A,signer:getAddress(i.signer),nonce:i.nonce,deadline:BigInt(i.deadline)};
  else if(k===4)message={account:A,purchaseKey:i.purchaseKey,payee:getAddress(i.payee),amount:BigInt(i.amount),deadline:BigInt(i.deadline)};
  else{const g=st(i.grant);message={account:A,merchant:g.merchant,name:g.name,epoch:BigInt(epoch),signers:g.signers,single:g.single,daily:g.daily,expiry:g.expiry,nonce:i.nonce,deadline:BigInt(i.deadline)};}
  return {domain:ownerDomainV55({adapter,chainId}),types:{[primaryType]:OWNER_TYPES_V55[primaryType]},primaryType,message};}
/** Coinbase Smart Wallet replaySafeHash(hash) = EIP-712 CoinbaseSmartWalletMessage{hash} under ("Coinbase Smart Wallet", "1", chainId, wallet). */
export const replaySafeHash=({wallet,chainId=V55.chainId,hash})=>hashTypedData({domain:{name:'Coinbase Smart Wallet',version:'1',chainId:Number(chainId),verifyingContract:getAddress(wallet)},
  types:{CoinbaseSmartWalletMessage:[{name:'hash',type:'bytes32'}]},primaryType:'CoinbaseSmartWalletMessage',message:{hash}});
/** Everything the phone needs for one approval: {kind, body, ownerDigest (EIP-712), phoneDigest (= replaySafeHash, what Face ID signs)}. */
export function seatDigest(kind,args){const td=ownerTypedDataV55(kind,args);const ownerDigest=hashTypedData(td);
  return {kind:Number(kind),primaryType:td.primaryType,typedData:td,body:seatBody(kind,args),ownerDigest,phoneDigest:replaySafeHash({wallet:args.wallet,chainId:args.chainId??V55.chainId,hash:ownerDigest})};}
/** KL-5: canonical low-s. */
export const lowS=s=>{const v=BigInt(s);if(v<=0n||v>=P256_N)throw Object.assign(Error('bad s'),{code:'bad_signature'});return v>P256_N/2n?P256_N-v:v;};
/** SignatureWrapper(ownerIndex = seat index, abi.encode(uint8 kind, bytes body, uint256 r, uint256 s)) - s normalised to low-s. */
export function seatWrapper({kind,body,r,s,ownerIndex=SEAT_V2_INDEX}){const R=BigInt(r);if(R<=0n||R>=P256_N)throw Object.assign(Error('bad r'),{code:'bad_signature'});
  const data=encodeAbiParameters([{type:'uint8'},{type:'bytes'},{type:'uint256'},{type:'uint256'}],[Number(kind),body,R,lowS(s)]);
  return encodeAbiParameters([{type:'tuple',components:[{name:'ownerIndex',type:'uint256'},{name:'signatureData',type:'bytes'}]}],[{ownerIndex:BigInt(ownerIndex),signatureData:data}]);}
/** KPTR inline payee trust ("approve & remember"), V5.5: 0x4b505452 ‖ abi.encode(TrustParams, nonce, deadline, sig), sig over OwnerInlineTrust
 *  (seat kind 6, or the Base Account owner). KR-05 rules are checked here first so the server never relays a blob the chain refuses. */
export function inlineTrustBlob({trust,nonce,deadline,sig,nowS}){const t=tp(trust);checkInlineTrust(t,{deadline,nowS});
  return concat([INLINE_TRUST_TAG,encodeAbiParameters([TP,{type:'bytes32'},{type:'uint256'},{type:'bytes'}],[t,nonce,BigInt(deadline),sig])]);}
export function checkInlineTrust(t,{deadline,nowS}){const now=BigInt(nowS??Math.floor(Date.now()/1000));const bad=c=>{throw Object.assign(Error('inline trust: '+c),{code:'inline_trust_'+c});};
  if(!t.name||t.merchant.toLowerCase()!==merchantIdOf(t.name).toLowerCase())bad('name');
  if(t.signers.length!==0||t.payees.length===0||t.payees.length>16)bad('payees');
  if(t.payees.some(p=>/^0x0{40}$/i.test(p)))bad('payee_zero');
  if(!(t.single>0n&&t.single<=t.daily))bad('caps');
  if(!(now<t.expiry&&(t.expiry===NO_EXPIRY||t.expiry<=now+365n*86400n)))bad('expiry');
  if(!(now<BigInt(deadline)))bad('deadline');return true;}
/** kind-5 owner signer grant bytes for paySignedTrusted: abi.encode(SignerTrust, nonce, deadline, sig) (same layout as V5.4). */
export const encodeGrantV55=({grant,nonce,deadline,sig})=>encodeAbiParameters([ST,{type:'bytes32'},{type:'uint256'},{type:'bytes'}],[st(grant),nonce,BigInt(deadline),sig]);
/** Owner one-time approval via the seat (kind 4): the bytes payDirect / prepareAuthorization take as ownerApproval. */
export const approvalFromSeat=({body,r,s})=>seatWrapper({kind:KIND.PAY,body,r,s});
export const packedSigners=a=>keccak256(encodePacked(['address[]'],[a.map(getAddress)]));
/** t1250: which owner struct a TRUST message is on a V5.5 wallet - the phone's rule (PhoneTrust.trustDigest): a reusable "remember" trust
 *  (deadline == expiry) is OwnerInlineTrust / seat kind 6 (KPTR), any other trust is OwnerTrust / kind 1 (trustBySig, stored). */
export const trustKindV55=m=>String(m?.deadline??'')!==''&&String(m.deadline)===String(m.expiry)?KIND.INLINE_TRUST:KIND.TRUST;
/** Wrap the phone's (r, s) over a V5.5 trust message as the seat V2 expects (kind chosen by trustKindV55, low-s normalised). */
export function trustWrapperV55(ownerIndex,m,r,s){const kind=trustKindV55(m);
  return {kind,wrapper:seatWrapper({kind,body:seatBody(kind,{trust:m,nonce:m.nonce,deadline:m.deadline}),r,s,ownerIndex})};}
/** The owner-ask "approve & remember" message on V5.5: exactly this payee, no signers, caps as shown, expiry = deadline (reusable). */
export function inlineAskTrust({wallet,payee,name,single,daily,days,epoch,nonce,nowS,adapter=V55.adapter,chainId=V55.chainId}){
  const exp=BigInt(nowS)+BigInt(days)*86400n;const trust={merchant:merchantIdOf(name),name,payees:[getAddress(payee)],signers:[],single:BigInt(single),daily:BigInt(daily),expiry:exp};
  checkInlineTrust(trust,{deadline:exp,nowS});const d=seatDigest(KIND.INLINE_TRUST,{wallet,epoch,trust,nonce,deadline:exp,adapter,chainId});
  return {trust,deadline:exp,kind:KIND.INLINE_TRUST,primaryType:'OwnerInlineTrust',typedData:d.typedData,digest:d.ownerDigest,
    message:{account:getAddress(wallet),merchant:trust.merchant,name,epoch:String(epoch),payees:trust.payees,signers:[],single:String(single),daily:String(daily),expiry:String(exp),nonce,deadline:String(exp)}};}
