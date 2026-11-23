// FORK-ONLY (t1250, V55-05): a small ERC-7562 validation-rule checker over anvil's struct-log trace (debug_traceCall with memory).
// It traces each validation frame the way the EntryPoint v0.7 runs it (from = EntryPoint, to = entity, same calldata), so it sees exactly the
// code a bundler's tracer sees during validation, including nested calls (USDC.permit -> vault.isValidSignature).
// Rules checked (ERC-7562 numbering): OP-011 banned opcodes, OP-012 GAS only before *CALL, OP-031 CREATE2 / OP-011 CREATE, OP-041 EXTCODE* on
// an address without code, OP-061 CALL with value, OP-052/054 calls into the EntryPoint, STO-010/021/031/032/033 storage access (own /
// associated / staked-entity), with keccak preimages taken from memory to decide "associated with" (slot = A, or keccak(A ‖ x) + n, n <= 128).
// NOT a full bundler: no mempool / reputation / aggregator / OOG-inside-validation / multi-op bundle rules, no EIP-7702.
import {keccak256,getAddress,encodeFunctionData,toHex} from 'viem';
const BANNED=new Set(['GASPRICE','GASLIMIT','DIFFICULTY','PREVRANDAO','TIMESTAMP','BASEFEE','BLOCKHASH','NUMBER','SELFBALANCE','BALANCE','ORIGIN','COINBASE','SELFDESTRUCT','BLOBHASH','BLOBBASEFEE','INVALID','CREATE','CREATE2']);
const CALLS=new Set(['CALL','CALLCODE','DELEGATECALL','STATICCALL']);
const lc=a=>String(a??'').toLowerCase();
const word=(stack,i)=>BigInt(stack[stack.length-1-i]);   // i = 0 is the top
const addrOf=v=>getAddress('0x'+BigInt(v).toString(16).padStart(40,'0').slice(-40));
function memBytes(memory,off,size){const hex=(memory??[]).map(w=>w.replace(/^0x/,'')).join('');const s=Number(off)*2,e=s+Number(size)*2;return '0x'+(hex.slice(s,e).padEnd(e-s,'0'));}
async function rpc(url,method,params){const r=await fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})});const j=await r.json();if(j.error)throw Error(method+': '+j.error.message);return j.result;}
/** Trace one validation frame. entity = {kind:'account'|'paymaster', address, staked}. */
export async function traceFrame({rpcUrl,entryPoint,to,data,gas=2_000_000n}){
  return rpc(rpcUrl,'debug_traceCall',[{from:entryPoint,to,data,gas:toHex(gas)},'latest',{enableMemory:true,disableStack:false,disableStorage:true,enableReturnData:true}]);}
/** Walk the struct logs: frames, banned opcodes, storage accesses, keccak preimages. */
export function analyse(trace,{root}){const L=trace.structLogs;const frames=[{code:getAddress(root),storage:getAddress(root),depth:1}];
  const ops=[],sto=[],kec=[],calls=[],ext=[];let pending=null;
  for(let i=0;i<L.length;i++){const s=L[i];
    while(frames.length&&frames[frames.length-1].depth>s.depth)frames.pop();
    if(pending){if(s.depth===pending.depth+1)frames.push({code:pending.target,storage:pending.op==='DELEGATECALL'||pending.op==='CALLCODE'?frames[frames.length-1].storage:pending.target,depth:s.depth});pending=null;}
    const f=frames[frames.length-1];const st=s.stack??[];
    if(BANNED.has(s.op))ops.push({op:s.op,code:f.code,storage:f.storage,pc:s.pc,depth:s.depth});
    if(s.op==='GAS'){const n=L[i+1];if(!n||!CALLS.has(n.op))ops.push({op:'GAS (not before *CALL)',code:f.code,pc:s.pc,depth:s.depth});}
    if(s.op==='SLOAD'||s.op==='SSTORE')sto.push({op:s.op,storage:f.storage,code:f.code,slot:toHex(word(st,0),{size:32}),depth:s.depth});
    if(s.op==='KECCAK256'){const inp=memBytes(s.memory,word(st,0),word(st,1));kec.push({input:inp,out:keccak256(inp)});}
    if(CALLS.has(s.op)){const target=addrOf(word(st,1));const wv=s.op==='CALL'||s.op==='CALLCODE';const value=wv?word(st,2):0n;
      const selector=memBytes(s.memory,word(st,wv?3:2),4n);calls.push({op:s.op,from:f.code,target,value,selector,depth:s.depth});pending={op:s.op,target,depth:s.depth};}
    if(['EXTCODESIZE','EXTCODEHASH','EXTCODECOPY'].includes(s.op))ext.push({op:s.op,target:addrOf(word(st,0)),code:f.code});}
  return {steps:L.length,failed:trace.failed,returnValue:trace.returnValue,ops,sto,kec,calls,ext};}
/** Apply the rules. sender = the UserOp sender; entity = whose validation this frame is; ep = EntryPoint. */
export async function check(a,{sender,entity,ep,getCode}){const v=[],needStake=[];const S=lc(sender),E=lc(entity.address);
  const assoc=addr=>{const p='0x'+lc(addr).replace(/^0x/,'').padStart(64,'0');return a.kec.filter(k=>lc(k.input).startsWith(p)&&k.input.length>=2+64).map(k=>BigInt(k.out));};
  const aS=assoc(sender),aE=assoc(entity.address);
  const isAssoc=(slot,addr,set)=>{const x=BigInt(slot);if(x===BigInt(addr))return true;return set.some(k=>x>=k&&x-k<=128n);};
  for(const o of a.ops)v.push({rule:o.op.startsWith('GAS')?'OP-012':o.op.startsWith('CREATE')?'OP-031/OP-011':'OP-011',detail:o.op+' in '+o.code+' pc '+o.pc});
  for(const c of a.calls){if(c.value>0n&&lc(c.target)!==lc(ep))v.push({rule:'OP-061',detail:'CALL with value from '+c.from});
    if(lc(c.target)===lc(ep)&&lc(c.from)!==lc(ep))v.push({rule:'OP-052/054',detail:'call into the EntryPoint from '+c.from});}
  for(const x of a.ext){const code=await getCode(x.target);if((!code||code==='0x')&&lc(x.target)!==S)v.push({rule:'OP-041',detail:x.op+' on '+x.target+' (no code) from '+x.code});}
  const seen=new Map();
  for(const s of a.sto){const k=s.op+'|'+lc(s.storage)+'|'+s.slot;if(seen.has(k))continue;seen.set(k,1);const W=s.op==='SSTORE';
    let cls;
    if(lc(s.storage)===S)cls='STO-010 sender storage';
    else if(isAssoc(s.slot,sender,aS))cls='STO-021 associated with sender';
    else if(lc(s.storage)===E)cls='STO-031 entity own storage';
    else if(isAssoc(s.slot,entity.address,aE))cls='STO-032 associated with entity';
    else cls=W?'FORBIDDEN write to non-associated storage':'STO-033 read-only non-entity storage';
    const r={...s,cls};
    if(cls.startsWith('FORBIDDEN'))v.push({rule:'STO-0xx',detail:s.op+' '+s.storage+' slot '+s.slot});
    else if(/STO-03[123]/.test(cls)){if(entity.staked)needStake.push(r);else v.push({rule:cls.slice(0,7),detail:'unstaked '+entity.kind+': '+s.op+' '+s.storage+' slot '+s.slot});}}
  return {violations:v,stakedOnly:needStake,storageAccesses:seen.size,steps:a.steps,failed:a.failed};}
