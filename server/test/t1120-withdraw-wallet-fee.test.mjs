// SPDX-License-Identifier: AGPL-3.0-only
// t1119u/t1120u (§6#62): everyday withdraw takes the network fee from the WALLET in the same confirmation. The owner is never asked to
// fund the Base Account first. Reproduces the 2026-11-12 screenshot: 1 USDC partial, Base Account holds 0 USDC.
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';
import {createOwnerWithdraw,checkWalletPaysCalls,checkWithdrawCalls,withdrawCallsWalletPays,WITHDRAW_MAX_WALLET_FEE,WITHDRAW_WALLET_ABI,WITHDRAW_ERC20_ABI} from '../src/v5/owner-withdraw.mjs';
import {decodeFunctionData} from 'viem';
const W='0x1000000000000000000000000000000000000004',O='0x2000000000000000000000000000000000000002',X='0x6666666666666666666666666666666666666666',T='0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',F='0xc0dedd749573f2e967a4ba53190c27ffbc2f8b31';
const FEE='0xf14EF5Dc4723245866c22C749A0A84AFCebA0Dd9';   // the current official server fee address (mainnet-owner-launch default)
const mk=({bal={[W]:12_340_000n,[O]:0n},walletPays}={})=>{const st={bal};const reg=[];
  const wp=walletPays===undefined?{available:()=>true,register:async(id,a)=>{reg.push({id,...a});return 'https://pay.example/onboard/new/paymaster?id=wd-'+id;}}:walletPays;
  const pub={readContract:async({functionName,args})=>functionName==='isOwnerAddress'?true:functionName==='balanceOf'?(st.bal[args[0]]??0n):[0n,300000000000n,0n,0n,0n],getCode:async()=>'0x',estimateGas:async()=>60000n,getGasPrice:async()=>10_000_000n};
  return {st,reg,M:createOwnerWithdraw({pub,wallet:W,owner:O,token:T,feed:F,script:()=>'',...(wp?{feeTo:FEE,walletPays:wp}:{})})};};
const call=async(M,method,path,body,lang='zh-CN')=>{let code,out;await M.handle({method,headers:{'accept-language':lang}},{writeHead:c=>{code=c;},end:b=>{out=String(b??'');}},new URL('http://x'+path),{readBody:async()=>body??{},ip:'1'});return {code,out,j:(()=>{try{return JSON.parse(out);}catch{return null;}})()};};
const transfers=calls=>calls.map(c=>{const o=decodeFunctionData({abi:WITHDRAW_WALLET_ABI,data:c.data});try{const t=decodeFunctionData({abi:WITHDRAW_ERC20_ABI,data:o.args[2]});return {to:t.args[0],n:t.args[1]};}catch{return null;}}).filter(Boolean);

test('t1120u screenshot case: app 1 USDC partial (owner shape), page asks wallet WITHOUT amount -> same 1 USDC, fee from the wallet',async()=>{
  const {M,reg}=mk();const app=(await call(M,'POST','/owner/withdraw/prepare',{amount:'1000000'})).j;
  assert.equal(app.feeFrom,'owner','the App still gets the plain plan it commits to (#vh)');assert.equal(app.amount,'1000000');
  const q=(await call(M,'POST','/owner/withdraw/quote',{amount:'1000000'})).j;assert.equal(q.ownerCanPayUSDC,false);assert.equal(q.feePaidBy,'wallet');assert.equal(q.walletPays.feeTo,FEE);
  const w=await call(M,'POST','/owner/withdraw/prepare',{feeFrom:'wallet'});assert.equal(w.code,200);
  assert.equal(w.j.feeFrom,'wallet');assert.equal(w.j.amount,'1000000','never everything over a partial');assert.equal(w.j.feeTo,FEE);assert.equal(w.j.owner,O);
  assert.equal(checkWalletPaysCalls(w.j.calls,{wallet:W,owner:O,token:T,feeTo:FEE}),null);const tr=transfers(w.j.calls);
  assert.equal(tr[0].to,FEE);assert.ok(tr[0].n>0n&&tr[0].n<=WITHDRAW_MAX_WALLET_FEE);assert.equal(tr[1].to,O);assert.equal(tr[0].n+tr[1].n,1_000_000n);
  assert.equal(w.j.receive,(1_000_000n-tr[0].n).toString());assert.equal(reg.length,1);assert.equal(reg[0].reimburse,BigInt(w.j.gasFee));});

test('t1120u plan id pins the amount; explicit amount wins; unknown plan is refused (never a full-balance plan)',async()=>{
  const {M}=mk();const app=(await call(M,'POST','/owner/withdraw/prepare',{amount:'2500000'})).j;
  const byId=(await call(M,'POST','/owner/withdraw/prepare',{feeFrom:'wallet',plan:app.id})).j;assert.equal(byId.feeFrom,'wallet');assert.equal(byId.amount,'2500000');
  const both=(await call(M,'POST','/owner/withdraw/prepare',{feeFrom:'wallet',plan:app.id,amount:'2500000'})).j;assert.equal(both.amount,'2500000');
  const unk=await call(M,'POST','/owner/withdraw/prepare',{feeFrom:'wallet',plan:'0'.repeat(32)});assert.equal(unk.code,400);assert.equal(unk.j.error,'unknown_plan');
  // a junk plan field is ignored by the route (not a 32-hex id) -> falls back to the latest app amount, still not "everything"
  const junk=(await call(M,'POST','/owner/withdraw/prepare',{feeFrom:'wallet',plan:{x:1},to:X})).j;assert.equal(junk.amount,'2500000');assert.equal(junk.owner,O);});

test('t1120u no silent owner-pays fallback: sponsor refuses or wallet-pays is off -> clear error, nothing prepared',async()=>{
  for(const wp of [{available:()=>true,register:async()=>null},{available:()=>true,register:async()=>{throw Error('down');}},{available:()=>false,register:async()=>'https://pm'},null]){
    const {M}=mk({walletPays:wp});const app=(await call(M,'POST','/owner/withdraw/prepare',{amount:'1000000'})).j;
    const r=await call(M,'POST','/owner/withdraw/prepare',{feeFrom:'wallet',plan:app.id});assert.equal(r.code,400);assert.equal(r.j.error,'wallet_fee_unavailable');
    assert.doesNotMatch(r.out,/0\.05|先准备|add a little/);assert.equal(r.j.calls,undefined);}});

test('t1120u the App path itself is unchanged (no feeFrom -> plain plan, exact amount, owner only)',async()=>{
  const {M,reg}=mk();const a=(await call(M,'POST','/owner/withdraw/prepare',{amount:'1000000',feeFrom:'owner'})).j;assert.equal(a.feeFrom,'owner');
  assert.equal(checkWithdrawCalls(a.calls,{wallet:W,owner:O,token:T}),null);assert.deepEqual(transfers(a.calls),[{to:O,n:1_000_000n}]);assert.equal(reg.length,0);});

test('t1120u after a confirmed withdraw the remembered amount is dropped (next page = fresh quote)',async()=>{
  const {M,st}=mk();const app=(await call(M,'POST','/owner/withdraw/prepare',{amount:'1000000'})).j;
  const w=(await call(M,'POST','/owner/withdraw/prepare',{feeFrom:'wallet',plan:app.id})).j;const fee=BigInt(w.fee);
  st.bal[W]=11_340_000n;st.bal[O]=1_000_000n-fee;assert.equal((await call(M,'POST','/owner/withdraw/confirm',{id:w.id})).j.ok,true);
  const next=(await call(M,'POST','/owner/withdraw/prepare',{feeFrom:'wallet'})).j;assert.equal(next.amount,'11340000');});

test('t1120u page HTML: wallet-pays rows for the plan amount; never the Base-funding card, even when the Base Account has 0',async()=>{
  const {M}=mk();const app=(await call(M,'POST','/owner/withdraw/prepare',{amount:'1000000'})).j;
  for(const lang of ['zh-CN','en-US']){const h=(await call(M,'GET','/owner/withdraw?plan='+app.id,null,lang)).out;
    assert.match(h,/>1 USDC</);assert.match(h,lang==='zh-CN'?/你会收到/:/You receive/);assert.match(h,lang==='zh-CN'?/从钱包里扣/:/taken from the wallet/);
    assert.doesNotMatch(h,/id=kpw-fee/);assert.doesNotMatch(h,/0\.05/);assert.doesNotMatch(h,/kc warn/);}
  const {M:off}=mk({walletPays:null});const h=(await call(off,'GET','/owner/withdraw')).out;
  assert.doesNotMatch(h,/id=kpw-fee/);assert.doesNotMatch(h,/0\.05/);assert.doesNotMatch(h,/你自己付/);assert.match(h,/id=kpw-nowp/);});

// ---- sign page (owner-sign/static/withdraw.js == /workspace/t1120/sign/withdraw.v4.js) ----
const PAGE=fs.readFileSync('owner-sign/static/withdraw.js','utf8');const APPCODE=PAGE.slice(PAGE.lastIndexOf('G0=!1,dg=!1'));
const LAUNCH=fs.readFileSync('mainnet/mainnet-owner-launch.mjs','utf8');
test('t1120u sign page: baked fee address = the server default fee address (else canWP is false and the page falls back)',()=>{
  const baked=PAGE.match(/var KPFEETO='(0x[0-9a-fA-F]{40})';/)[1].toLowerCase();assert.equal(baked,FEE.toLowerCase());
  // t1270: the launcher default lives in OPERATOR_DEFAULTS (private build); an open-source build has none and reads operatorConstants.feeTo from its config
  assert.equal([...LAUNCH.matchAll(/\?v:OP\.feeTo\)\(process\.env\.KIPURSE_WITHDRAW_FEE_TO/g)].length,3);
  const defs=[...LAUNCH.matchAll(/OPERATOR_DEFAULTS=Object\.freeze\(\{feeTo:'(0x[0-9a-fA-F]{40})'/g)].map(m=>m[1].toLowerCase());for(const d of defs)assert.equal(d,baked);
  assert.ok(!PAGE.includes('0xfc0E68572cDba016c1c90A45E1792f3fE0EE345B'),'stale /v9 fee address gone');});
test('t1120u sign page: quote/prepare carry the plan amount; wallet-pays only; no Base-funding card; no owner-pays fallback',()=>{
  assert.match(APPCODE,/Qa\(ei\("plan"\),\{id:e\}\)/);assert.match(APPCODE,/Qa\(ei\("quote"\),kpPA\?\{amount:kpPA\}:void 0\)/);
  assert.match(APPCODE,/Qa\(ei\("prepare"\),Object\.assign\(\{feeFrom:"wallet"\},kpPA\?\{amount:kpPA\}:\{\},t\?\{plan:t\}:\{\}\)\)/);
  assert.match(APPCODE,/String\(i\.amount\)===kpPA/,'wallet plan must be for the App-checked amount');assert.match(APPCODE,/String\(i\.feeTo\)\.toLowerCase\(\)===Kf/);
  assert.doesNotMatch(APPCODE,/Qa\(ei\("prepare"\)\)/,'no bare prepare (= full balance, owner pays)');assert.doesNotMatch(APPCODE,/Qa\(ei\("quote"\)\)/,'no bare quote (= full balance)');
  assert.doesNotMatch(APPCODE,/0\.05/);assert.doesNotMatch(APPCODE,/\\u5148\\u51C6\\u5907\\u4E00\\u70B9\\u624B\\u7EED\\u8D39/,'先准备一点手续费 gone');assert.doesNotMatch(APPCODE,/O3=e=>[^,]*Vc\("warn"/);
  assert.match(APPCODE,/C3=e=>!Hk\(e\)/);assert.match(APPCODE,/if\(!r\)\{fg\(\),O3\(Wf\),yn\(""\);return\}/);});
test('t1120u sign page guard accepts the server-built wallet-pays batch for the 1 USDC partial (signer + baked fee address only)',async()=>{
  const g=PAGE.slice(0,PAGE.indexOf('var KPEN='));const G=new Function('location','document','crypto',g+';return {kpVH,kpVHWP};')({hash:'#vh='+'a'.repeat(64),pathname:'/'},{documentElement:{lang:'zh'}},globalThis.crypto);
  const send=(calls,from=O)=>({method:'wallet_sendCalls',params:[{version:'2.0.0',chainId:'0x2105',from,atomicRequired:true,calls,capabilities:{paymasterService:{url:'https://x/p'}}}]});
  const {M}=mk();const app=(await call(M,'POST','/owner/withdraw/prepare',{amount:'1000000'})).j;const w=(await call(M,'POST','/owner/withdraw/prepare',{feeFrom:'wallet',plan:app.id})).j;
  assert.ok(await G.kpVH(send(w.calls)),'#vh was for the 1-call owner plan; the wallet-pays batch passes kpVHWP');
  await assert.rejects(G.kpVH(send(w.calls,X)),'signer must receive the rest');
  await assert.rejects(G.kpVH(send(withdrawCallsWalletPays({wallet:W,owner:O,token:T,amount:1_000_000n,fee:11_336n,feeTo:'0xfc0E68572cDba016c1c90A45E1792f3fE0EE345B'}))),'old /v9 address is no longer accepted');});
test('t1120u /workspace sign asset equals the server static script byte for byte (when present)',()=>{const p='/workspace/t1120/sign/withdraw.v4.js';if(!fs.existsSync(p))return;assert.ok(fs.readFileSync(p).equals(fs.readFileSync('owner-sign/static/withdraw.js')));});
