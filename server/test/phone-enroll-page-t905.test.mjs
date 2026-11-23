// t905: the phone enrollment page is a short card: one sentence, the code, the fee, ONE button (or a clear "what to do" card); rest folded.
import test from 'node:test';import assert from 'node:assert/strict';import {writeFileSync,mkdirSync} from 'node:fs';
import {createPhoneEnrollment} from '../src/v5/phone-signer.mjs';
const W='0x5e4c116dd45edc2dbed826be8b97a72499d03fc8',O='0x1da2d5293bd418ab06d16890f17711302c7e74f6',X='0x'+'11'.repeat(32),Y='0x'+'22'.repeat(32);
function render(walletUSDC,ownerUSDC,lang='zh'){
  const pub={readContract:async({functionName,args})=>functionName==='balanceOf'?(String(args[0]).toLowerCase()===W.toLowerCase()?walletUSDC:ownerUSDC):functionName==='nextOwnerIndex'?0n:false,
    getBalance:async()=>576524856980335n,getGasPrice:async()=>5000000n};
  const S={phone:{pending:{abc:{x:X,y:Y,approver:'0x9c5c000000000000000000000000000000000402',fee:'26731',exp:Date.now()+6e5,version:'v3',replaces:'0x9d46169cDc73021D2242AD45Aa0Be2eB210Bad8b',remove:[]}},active:null}};
  const E=createPhoneEnrollment({S,save:()=>{},pub,wallet:W,trust:'0x65D2000000000000000000000000000000000eC84'.slice(0,42),owner:O,chainId:8453,base:'https://pay.kipurse.com',caps:{},script:()=>'',approverVersion:'v3'});
  let body='';const res={writeHead(){},end(b){body=b;}};
  return E.handle({method:'GET',headers:{'accept-language':lang}},res,new URL('https://pay.kipurse.com/phone/enroll?id=abc&lang='+lang),{readBody:async()=>({})}).then(()=>body);}
test('ready: one big 确认 button, details folded, short',async()=>{const h=await render(14304957n,1000000n);
  assert.match(h,/<button id=go>确认<\/button>/);assert.doesNotMatch(h,/id=need/);assert.match(h,/<details class=c><summary>详细信息/);
  const top=h.split('<details')[0];assert.doesNotMatch(top,/未经外部审计|手机确认能做的|0x1111aB12/);assert.match(top,/手续费 0.026731 USDC/);
  mkdirSync('/tmp/t905',{recursive:true});writeFileSync('/tmp/t905/ready-zh.html',h);writeFileSync('/tmp/t905/ready-en.html',await render(14304957n,1000000n,'en'));});
test('Base Account has 0 USDC: no hidden dead end, clear what-to-do card',async()=>{const h=await render(14304957n,0n);
  assert.doesNotMatch(h,/id=go/);assert.match(h,/id=need/);assert.match(h,/Base Account 里是 0 USDC/);writeFileSync('/tmp/t905/base-empty-zh.html',h);});
test('Kipurse wallet too low: 先充值',async()=>{const h=await render(1000n,1000000n);assert.match(h,/先充值/);assert.doesNotMatch(h,/id=go/);});
