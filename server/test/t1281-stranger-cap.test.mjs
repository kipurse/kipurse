// SPDX-License-Identifier: AGPL-3.0-only
// t1281 (owner decision decision 141 (1)): the stranger ("open") sub-limit is USER-CHOSEN: "[zh]", default = the
// normal limits. ONE formula (limits-public subCaps) for opening + limit change, the SAME on the phone (RequestVerify.subCaps):
// this test pins the server side and writes the shared vectors to the iOS repo (Tests/KipurseCoreTests/t1281-stranger-caps.json.txt),
// which the Swift test T1281StrangerCapTests replays against the phone formula (owner rule 0A#10: phone/server same formula + cross-test).
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';
import {checkLimits,subCaps,strangerChoiceError,createPublicLimits,STRANGER_CAPS_API} from '../src/v5/limits-public.mjs';
import {createNewWalletOnboarding} from '../src/v5/onboard-new.mjs';
import {createOnboarding} from '../src/v5/onboard.mjs';
import {buildMigrationPlanV5,validatePolicy} from '../src/v5/plan.mjs';
import {decodePolicyV5,permissionFromJson} from '../src/v5/abi.mjs';
import {kvKey} from '../src/v5/store.mjs';
import {en,zhOnly} from '../src/v5/i18n.mjs';

// bases: the onboarding template (prod config / RequestVerify.templatePolicy) and a live-style current policy (no registry sub-caps)
const TPL={openSingle:'100000',openDaily:'200200',verifiedSingle:'2000000',verifiedDaily:'5005000'};
const CUR={openSingle:'100000',openDaily:'200200',verifiedSingle:'0',verifiedDaily:'0'};
const V=(name,base,choice,expect)=>({name,base,choice,expect});
export const VECTORS=[
  V('default same as normal (opening)',TPL,{single:'5000000',daily:'20000000',openSingle:'5000000',openDaily:'20000000'},{openSingle:'5000000',openDaily:'20000000',verifiedSingle:'2000000',verifiedDaily:'5005000'}),
  V('default same as normal (change)',CUR,{single:'1000000000',daily:'3000000000',openSingle:'1000000000',openDaily:'3000000000'},{openSingle:'1000000000',openDaily:'3000000000',verifiedSingle:'0',verifiedDaily:'0'}),
  V('custom lower',TPL,{single:'5000000',daily:'20000000',openSingle:'1000000',openDaily:'3000000'},{openSingle:'1000000',openDaily:'3000000',verifiedSingle:'2000000',verifiedDaily:'5005000'}),
  V('custom raises above the old stranger cap (ratchet fixed)',CUR,{single:'50000000',daily:'100000000',openSingle:'20000000',openDaily:'60000000'},{openSingle:'20000000',openDaily:'60000000',verifiedSingle:'0',verifiedDaily:'0'}),
  V('stranger per payment = stranger per day',TPL,{single:'5000000',daily:'20000000',openSingle:'7',openDaily:'7'},{openSingle:'7',openDaily:'7',verifiedSingle:'2000000',verifiedDaily:'5005000'}),
  V('leading zeros normalised',TPL,{single:'5000000',daily:'20000000',openSingle:'000100',openDaily:'0200'},{openSingle:'100',openDaily:'200',verifiedSingle:'2000000',verifiedDaily:'5005000'}),
  V('legacy (older app): template min',TPL,{single:'5000000',daily:'20000000'},{openSingle:'100000',openDaily:'200200',verifiedSingle:'2000000',verifiedDaily:'5005000'}),
  V('legacy (older app): choice below template',TPL,{single:'50000',daily:'150000'},{openSingle:'50000',openDaily:'150000',verifiedSingle:'50000',verifiedDaily:'150000'}),
  V('legacy (older app): change keeps min(current, choice)',CUR,{single:'50000000',daily:'100000000'},{openSingle:'100000',openDaily:'200200',verifiedSingle:'0',verifiedDaily:'0'}),
  V('refuse: stranger per payment above per payment',TPL,{single:'5000000',daily:'20000000',openSingle:'5000001',openDaily:'20000000'},{error:'stranger_single_above_single'}),
  V('refuse: stranger per day above per day',TPL,{single:'5000000',daily:'20000000',openSingle:'1000000',openDaily:'20000001'},{error:'stranger_daily_above_daily'}),
  V('refuse: stranger per payment 0',TPL,{single:'5000000',daily:'20000000',openSingle:'0',openDaily:'1000000'},{error:'stranger_single_zero'}),
  V('refuse: stranger per day 0',TPL,{single:'5000000',daily:'20000000',openSingle:'1000000',openDaily:'0'},{error:'stranger_daily_zero'}),
  V('refuse: stranger per payment above stranger per day',TPL,{single:'5000000',daily:'20000000',openSingle:'3000000',openDaily:'2000000'},{error:'stranger_single_above_stranger_daily'}),
  V('refuse: only one stranger value',TPL,{single:'5000000',daily:'20000000',openSingle:'1000000'},{error:'stranger_incomplete'}),
  V('refuse: only the other stranger value',TPL,{single:'5000000',daily:'20000000',openDaily:'1000000'},{error:'stranger_incomplete'}),
  V('refuse: not an amount',TPL,{single:'5000000',daily:'20000000',openSingle:'1.5',openDaily:'2000000'},{error:'bad_stranger_amount'}),
  V('refuse: negative',TPL,{single:'5000000',daily:'20000000',openSingle:'-1',openDaily:'2000000'},{error:'bad_stranger_amount'}),
];
const out=r=>r.error?{error:r.error}:r;
const IOS=new URL('../../../../../../kipurse-ios/Kipurse/Tests/KipurseCoreTests/',import.meta.url);

test('t1281 formula: every vector, and the shared fixture for the phone is written',()=>{
  for(const v of VECTORS)assert.deepEqual(out(subCaps(v.choice,v.base)),v.expect,v.name);
  const text=JSON.stringify({note:'t1281 stranger sub-limit vectors, generated by gw test/t1281-stranger-cap.test.mjs from src/v5/limits-public.mjs subCaps. Atomic USDC. Do not edit by hand.',
    vectors:VECTORS.map(v=>({...v,server:out(subCaps(v.choice,v.base))}))},null,1)+'\n';
  /* t1281 review: compare, never silently rewrite the iOS fixture (KP_WRITE_FIXTURES=1 regenerates it on purpose) */
  const F=new URL('t1281-stranger-caps.json.txt',IOS);
  if(fs.existsSync(IOS)){if(process.env.KP_WRITE_FIXTURES==='1')fs.writeFileSync(F,text);else assert.equal(fs.readFileSync(F,'utf8'),text,'iOS fixture t1281-stranger-caps.json.txt is stale: rerun with KP_WRITE_FIXTURES=1');}   // the iOS repo is not next to this checkout in CI / public export
});

test('t1281 "same as normal" = the policy daily exactly (no fee headroom on owner plans), never above it',()=>{
  const r=subCaps({single:'5000000',daily:'20000000',openSingle:'5000000',openDaily:'20000000'},TPL);
  const pl=buildMigrationPlanV5({chainId:8453,wallet:'0x'+'2'.repeat(40),adapter:'0x'+'4'.repeat(40),token:'0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',executor:'0x'+'8'.repeat(40),headroom:false,
    maxFeePpm:'1000',maxNetworkFee:'50000',fee:{ppm:'1000'},stated:{single:'5000000',daily:'20000000',term:'100000000',...r},start:1_700_000_000,end:1_700_000_000+90*86400});
  assert.equal(pl.policy.openDaily,pl.policy.daily);assert.equal(pl.policy.openSingle,pl.policy.single);assert.ok(validatePolicy(pl.policy,{feePpm:1000n}));
});

test('t1281 checkLimits: optional USDC amounts, refusals in both languages, legacy untouched',()=>{
  assert.deepEqual(checkLimits({single:'1',daily:'5',term:'20'}),{single:1000000n,daily:5000000n,term:20000000n,days:undefined},'older app: nothing new');
  const c=checkLimits({single:'1',daily:'5',term:'20',openSingle:'0.1',openDaily:'0.2002'});assert.equal(c.openSingle,100000n);assert.equal(c.openDaily,200200n);
  for(const [o,code] of [[{openSingle:'2',openDaily:'5'},'stranger_single_above_single'],[{openSingle:'1',openDaily:'6'},'stranger_daily_above_daily'],[{openSingle:'0',openDaily:'1'},'stranger_single_zero'],
    [{openSingle:'1',openDaily:'0.5'},'stranger_single_above_stranger_daily'],[{openSingle:'1'},'stranger_incomplete'],[{openSingle:'abc',openDaily:'1'},'bad_stranger_amount'],[{openSingle:'0.0000001',openDaily:'1'},'bad_stranger_amount']]){
    const e=checkLimits({single:'1',daily:'5',term:'20',...o});assert.equal(e.error,code,JSON.stringify(o));
    assert.match(zhOnly(e.detail),/陌生收款方/);const E=en(e.detail);assert.ok(E&&!/[㐀-鿿]/.test(E)&&/new payees/i.test(E),E);}
  assert.equal(strangerChoiceError({single:'1',daily:'1'}),null);
});

const mapKV=()=>{const m=new Map();return {get:k=>m.get(k),put:(k,v)=>m.set(k,v),del:k=>m.delete(k)};};
const A='0x1B1BF0E5D1C6a2b74C3D9E8f07a1b2c3D4e5f606';
const X='0x6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296',Y='0x4fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5';
function mkNew({tenantStart}={}){const kv=mapKV();const W='0x2222222222222222222222222222222222222222';
  const pub={getCode:async()=>'0x',getBlock:async()=>({timestamp:1_700_000_000n}),getBlockNumber:async()=>1n,getGasPrice:async()=>6_000_000n,getBalance:async()=>0n,
    readContract:async({functionName})=>functionName==='getAddress'?W:functionName==='vaultAddress'?'0x3333333333333333333333333333333333333333':functionName==='fees'?'0x9999999999999999999999999999999999999999':functionName==='feePpm'?1000n:functionName==='latestRoundData'?[0n,2_500_00000000n,0n,BigInt(Math.floor(Date.now()/1000)),0n]:functionName==='balanceOf'?10_000_000n:functionName==='nextOwnerIndex'?0n:false};
  const policy=()=>({executor:'0x8888888888888888888888888888888888888888',guardian:'0x0000000000000000000000000000000000000000',registry:'0x26c707ccbd569624cf31f5c574d4fdf7e3f23998',maxFeePpm:'1000',maxNetworkFee:'50000',...TPL});
  const N=createNewWalletOnboarding({enabled:true,kv,pub,cfg:{adapter:'0x4444444444444444444444444444444444444444',trust:'0x5555555555555555555555555555555555555555',token:'0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',manager:'0x7777777777777777777777777777777777777777',approverVersion:'v2'},
    policy,reg:{byOwner:()=>tenantStart?[{wallet:W}]:[]},keyProof:async()=>true,tenantStart,base:()=>'https://x',script:()=>'',sponsor:null,verified:async()=>({verified:true}),noteFirstKey:()=>{},quote:async()=>({})});
  const signed=id=>decodePolicyV5(permissionFromJson(kv.get(kvKey('onbnew',null,id)).permission).extraData);return {N,kv,signed};}

test('t1281 opening prepare: explicit / default / legacy stated values are exactly the formula; refusals before anything is built',async()=>{
  for(const [o,want] of [[{openSingle:'1',openDaily:'3'},['1000000','3000000']],[{openSingle:'2',openDaily:'5'},['2000000','5000000']],[{},['100000','200200']]]){
    const {N,signed}=mkNew();const st=await N.start({x:X,y:Y,single:'2',daily:'5',term:'30',days:90,owner:A,...o});await N.prepare(st.id,A);const p=signed(st.id);
    assert.deepEqual([String(p.openSingle),String(p.openDaily)],want,JSON.stringify(o));assert.deepEqual([String(p.verifiedSingle),String(p.verifiedDaily)],['2000000','5000000']);
    assert.ok(BigInt(p.openSingle)<=BigInt(p.single)&&BigInt(p.openDaily)<=BigInt(p.daily));}
  const {N}=mkNew();
  for(const [o,code] of [[{openSingle:'3',openDaily:'5'},'stranger_single_above_single'],[{openSingle:'1',openDaily:'6'},'stranger_daily_above_daily'],[{openSingle:'0',openDaily:'5'},'stranger_single_zero'],[{openSingle:'2',openDaily:'1'},'stranger_single_above_stranger_daily']])
    await assert.rejects(N.start({x:X,y:Y,single:'2',daily:'5',term:'30',days:90,owner:A,...o}),e=>e.code===code,code);
  // the route hands the body fields through (and the quote advertises the capability)
  let res={};const call=async(url,body,method='POST')=>{let code,b;await N.handle({method,headers:{},socket:{}},{writeHead(c){code=c;},end(x){b=x?JSON.parse(x):null;}},new URL('https://x'+url),{readBody:async()=>body});return {code,b};};
  res=await call('/onboard/new/start',{x:X,y:Y,single:'2',daily:'5',term:'30',days:90,owner:A,openSingle:'3',openDaily:'5'});assert.equal(res.code,400);assert.equal(res.b.error,'stranger_single_above_single');
  res=await call('/onboard/new/quote',null,'GET');assert.equal(res.b.strangerCaps,STRANGER_CAPS_API);
});

test('t1281 re-opening an existing wallet (tenant start) carries the owner\'s stranger limits',async()=>{
  let seen=null;const {N}=mkNew({tenantStart:async(w,b)=>{seen=b;return {id:'t',calls:[]};}});
  const st=await N.start({x:X,y:Y,single:'2',daily:'5',term:'30',days:90,owner:A,openSingle:'0.5',openDaily:'2'});await N.prepare(st.id,A);
  assert.equal(seen.openSingle,'0.5');assert.equal(seen.openDaily,'2');assert.deepEqual(checkLimits(seen).openSingle,500000n);
  const {N:N2}=mkNew({tenantStart:async(w,b)=>{seen=b;return {id:'t',calls:[]};}});const s2=await N2.start({x:X,y:Y,single:'2',daily:'5',term:'30',days:90,owner:A});await N2.prepare(s2.id,A);
  assert.equal(seen.openSingle,undefined,'older app: nothing new');
  // the tenant /onboard start passes them to plan()
  let planned=null;const O=createOnboarding({verified:async()=>({verified:true}),S:{},save(){},pub:{getGasPrice:async()=>6_000_000n,getBalance:async()=>10n**18n,readContract:async({functionName})=>functionName==='latestRoundData'?[0n,2_500_00000000n,0n,BigInt(Math.floor(Date.now()/1000)),0n]:10_000_000_000n},wallet:'0x2222222222222222222222222222222222222222',owner:A,trust:'0x5555555555555555555555555555555555555555',base:()=>'https://x',
    phone:{},plan:async c=>{planned=c;throw Object.assign(Error('stop'),{code:'stop'});},enabled:true,quote:async()=>({}),keyProof:()=>true});
  await assert.rejects(O.start({x:X,y:Y,single:'2',daily:'5',term:'30',openSingle:'0.5',openDaily:'2'}));
  assert.ok(planned,'reached plan()');assert.equal(planned.openSingle,500000n);assert.equal(planned.openDaily,2000000n);
});

test('t1281 limit change: /owner/limits/prepare hands explicit values to plan(); refusal is a 400 with zh + en; fee route advertises it',async()=>{
  let got=null;const L=createPublicLimits({base:()=>'https://x',current:async()=>({single:'1',daily:'5',term:'20',end:'0'}),plan:async c=>{got=c;throw Object.assign(Error('stop'),{code:'stop'});},confirm:async()=>({valid:true}),script:()=>'',
    sponsor:async()=>null,fee:async()=>null,feeQuote:async()=>({usdc:2345n,firstFree:false})});
  const call=async(path,body,method='POST')=>{let code,o='';await L.handle({method,headers:{},url:path},{writeHead:c=>{code=c;},end:s=>{o=s;}},new URL('https://x'+path),{readBody:async()=>body,ip:'1.1.1.1'});let j=null;try{j=JSON.parse(o);}catch{}return {code,j,o};};
  await call('/owner/limits/prepare',{single:'50000000',daily:'100000000',term:'500000000',openSingle:'20000000',openDaily:'60000000'}).catch(()=>{});
  assert.equal(got.openSingle,20000000n);assert.equal(got.openDaily,60000000n);
  got=null;await call('/owner/limits/prepare',{single:'50000000',daily:'100000000',term:'500000000'}).catch(()=>{});assert.equal(got.openSingle,undefined,'older app: legacy');
  const r=await call('/owner/limits/prepare',{single:'1000000',daily:'5000000',term:'20000000',openSingle:'2000000',openDaily:'5000000'});
  assert.equal(r.code,400);assert.equal(r.j.error,'stranger_single_above_single');assert.match(r.j.detail.zh,/陌生收款方/);assert.match(r.j.detail.en,/new payees/);assert.doesNotMatch(r.j.detail.en,/[㐀-鿿]/);
  const z=await call('/owner/limits/prepare',{single:'1000000',daily:'5000000',term:'20000000',openSingle:'0',openDaily:'5000000'});assert.equal(z.j.error,'stranger_single_zero');
  const f=await call('/owner/limits/fee',null,'GET');assert.equal(f.j.strangerCaps,STRANGER_CAPS_API);
});

test('t1281 planCapChange uses the ONE formula (explicit raise is not ratcheted down); fork e2e uses the same',()=>{
  const s=fs.readFileSync(new URL('../mainnet/mainnet-owner-launch.mjs',import.meta.url),'utf8');
  assert.match(s,/stated:choice\?\{single:choice\.single\.toString\(\),daily:choice\.daily\.toString\(\),term:choice\.term\.toString\(\),\.\.\.subCapsOrThrow\(choice,cp\)/);
  assert.doesNotMatch(s,/openSingle:mn\(cp\.openSingle,choice\.single\)/);
  assert.match(fs.readFileSync(new URL('./fork/onboard-fork.e2e.mjs',import.meta.url),'utf8'),/\.\.\.subCapsOrThrow\(c,cp\)/);
  assert.match(fs.readFileSync(new URL('../src/v5/onboard-new.mjs',import.meta.url),'utf8'),/\.\.\.subCapsOrThrow\(ch,p\)/);
  // planCapChange shape: current policy has 0.1 / 0.2002 for strangers; the owner raises the main limits AND chooses 20 / 60 for strangers
  const cp={...CUR},choice=checkLimits({single:'50',daily:'100',term:'500',openSingle:'20',openDaily:'60'});const r=subCaps(choice,cp);
  assert.deepEqual([r.openSingle,r.openDaily],['20000000','60000000'],'raised to exactly the owner\'s numbers (the old min() kept 0.1 / 0.2002 forever)');
  const legacy=subCaps(checkLimits({single:'50',daily:'100',term:'500'}),cp);assert.deepEqual([legacy.openSingle,legacy.openDaily],['100000','200200'],'older app: unchanged legacy behaviour');
});
