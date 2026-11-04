// t934: pin the sponsor caps to the owner's numbers (20 ops/day, $2/day, $0.25/op) and their boundaries.
import test from 'node:test';import assert from 'node:assert/strict';
import {createOnboardSponsor,sponsorConfig,callsHash} from '../src/v5/onboard-sponsor.mjs';
import {createMemoryKV} from '../src/v5/store.mjs';
import {encodeFunctionData,parseAbi} from 'viem';
const EXEC=parseAbi(['function executeBatch((address target,uint256 value,bytes data)[] calls)']);
const OWNER='0x1111111111111111111111111111111111111111',W='0x2222222222222222222222222222222222222222',F='0xBA5ED110eFDBa3D005bfC882d75358ACBbB85842',EP='0x0000000071727De22E5E9d8BAf0edAc6f37da032';
const calls=[{to:F,value:'0x0',data:'0x1234'},{to:W,value:'0x0',data:'0xabcd'}];
const cd=cs=>encodeFunctionData({abi:EXEC,functionName:'executeBatch',args:[cs.map(c=>({target:c.to,value:BigInt(c.value),data:c.data}))]});
const op=(o={})=>({sender:OWNER,callData:cd(calls),callGasLimit:'0x1e8480',verificationGasLimit:'0x30d40',preVerificationGas:'0xc350',maxFeePerGas:'0x5b8d80',...o});
const NOW=Date.parse('2026-11-03T12:00:00Z');const DAY='sponsor:day:2026-11-03';
function mk(day){const kv=createMemoryKV();if(day)kv.put(DAY,day);const cfg=sponsorConfig({KIPURSE_ONBOARD_PAYMASTER_URL:'https://pm.example/x'});
  const rec={state:'prepared',kind:'new',owner:OWNER,expect:OWNER,wallet:W,callsHash:callsHash(calls),allowed:[F,W]};
  const s=createOnboardSponsor({cfg,kv,reg:{byOwner:()=>[]},ethUsd8:async()=>300000000000n,lookup:id=>id==='a'?rec:undefined,now:()=>NOW,
    fetchImpl:async()=>({json:async()=>({result:{paymaster:'0x9',paymasterData:'0x'}})})});return {s,kv,cfg};}
test('t934 caps: defaults are exactly 20/day, $2/day, $0.25/op',()=>{const c=sponsorConfig({});assert.equal(c.maxPerDay,20);assert.equal(c.maxUsdPerDay,2);assert.equal(c.maxUsdPerOp,0.25);
  for(const bad of ['-1','abc',''])assert.equal(sponsorConfig({KIPURSE_SPONSOR_MAX_PER_DAY:bad}).maxPerDay,bad===''?0:20,'invalid env falls back, never negative');});
test('t934 caps: 19 used -> still open; 20 used -> closed (count cap)',()=>{assert.equal(mk({n:19,usd:0}).s.available(OWNER),true);assert.equal(mk({n:20,usd:0}).s.available(OWNER),false);});
test('t934 caps: $2 used today -> closed (USD cap)',()=>{assert.equal(mk({n:0,usd:1.99}).s.available(OWNER),true);assert.equal(mk({n:0,usd:2}).s.available(OWNER),false);});
test('t934 caps: one op over $0.25 is refused',async()=>{const {s}=mk();assert.equal(await s.gate('a','pm_getPaymasterData',[op({maxFeePerGas:'0x3b9aca00'}),EP,'0x2105']),'op_cap');});
test('t934 caps: day cap reached -> gate refuses even an exact prepared batch',async()=>{const {s}=mk({n:20,usd:0});const r=await s.gate('a','pm_getPaymasterData',[op(),EP,'0x2105']);assert.notEqual(r,null);assert.notEqual(r,true);});
