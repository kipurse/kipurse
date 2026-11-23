import test from 'node:test';import assert from 'node:assert/strict';
import {createNewWalletOnboarding} from '../src/v5/onboard-new.mjs';
const own='0x1111111111111111111111111111111111111111';
const rec={x:'0x'+'1'.repeat(64),y:'0x'+'2'.repeat(64),expect:own,choice:{single:'1000000',daily:'5000000',term:'20000000',days:90},state:'start'};
const html=async(sponsor,o=rec,reg={byOwner:()=>[]})=>{
  const N=createNewWalletOnboarding({enabled:true,kv:{get:()=>o,put(){}},reg,base:()=>'https://x',script:()=>'',sponsor,
    quote:async()=>({feeUSDC:'0.0444',gas:'2300000',signatures:1})});
  let b='';await N.handle({method:'GET',headers:{'accept-language':'zh-CN'}},{writeHead(){},end(x){b=String(x);}},new URL('https://x/onboard/new?id=a'),{readBody:async()=>({})});return b;};
const FEE=/开通手续费约 0\.0444 USDC（按实时报价）/;
const BAD=/免费|垫付|赞助|先支付|代付/;
test('onboard/new page: sponsor mock with onboardOn shows data-sponsored=1 but same user-pays fee copy',async()=>{
  const b=await html({enabled:true,onboardOn:true,available:a=>a===own});
  assert.match(b,FEE);assert.doesNotMatch(b,BAD);assert.match(b,/data-sponsored=1/);});
test('onboard/new page: sponsorship off -> user-paid copy',async()=>{const b=await html(null);assert.match(b,FEE);assert.doesNotMatch(b,BAD);assert.match(b,/data-sponsored=0/);});
test('onboard/new page: owner already used sponsorship -> user-paid copy',async()=>{const b=await html({enabled:true,available:()=>false});assert.match(b,FEE);assert.match(b,/data-sponsored=0/);});
test('onboard/new page: owner already has a wallet -> user-paid copy',async()=>{const b=await html({enabled:true,onboardOn:true,available:()=>true},rec,{byOwner:()=>[{wallet:'0x'+'3'.repeat(40)}]});assert.match(b,FEE);assert.match(b,/data-sponsored=0/);});
test('onboard/new page: no signed-in owner -> user-paid copy',async()=>{const b=await html({enabled:true,onboardOn:true,available:()=>true},{...rec,expect:null});assert.match(b,FEE);assert.match(b,/data-sponsored=0/);});
