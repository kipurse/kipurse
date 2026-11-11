// t1091: /phone/enroll log is status, error code, and duration. No key material.
import test from 'node:test';import assert from 'node:assert/strict';
import {createPhoneEnrollment} from '../src/v5/phone-signer.mjs';
import {createObs} from '../src/v5/obs.mjs';

const W='0x5e4c116dd45edc2dbed826be8b97a72499d03fc8',O='0x1da2d5293bd418ab06d16890f17711302c7e74f6';
const X='0x6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296';
const Y='0x4fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5';

function mk(lines){
  const obs=createObs({out:s=>lines.push(s)});
  const pub={readContract:async({functionName})=>functionName==='latestRoundData'?[0n,300000000000n,0n,BigInt(Math.floor(Date.now()/1e3)),0n]:functionName==='isOwnerAddress'?false:functionName==='nextOwnerIndex'?0n:0n,
    getBalance:async()=>0n,getGasPrice:async()=>6000000n,getCode:async()=>'0x'};
  const S={phone:{pending:{},active:null}};
  const E=createPhoneEnrollment({S,save:()=>{},pub,wallet:W,trust:'0x6b91dcb27cf3d69b1d9a6fddeb06ed1af2ed0bf9',owner:O,chainId:8453,base:()=>'https://pay.kipurse.com',caps:()=>({single:1n,daily:1n}),script:()=>'',log:(e,f)=>obs.log(e,f)});
  const call=async(body)=>{let code,text;await E.handle({method:'POST',headers:{}},{writeHead(c){code=c;},end(b){text=b;}},new URL('https://pay.kipurse.com/phone/enroll'),{readBody:async()=>body});return {code,text};};
  return {call};
}

test('failed enroll logs status, code, and duration only',async()=>{
  const lines=[];const {call}=mk(lines);
  const r=await call({x:'0x01',y:'0x02',secret:'do-not-log'});
  assert.equal(r.code,400);
  const o=JSON.parse(lines.at(-1));
  assert.equal(o.event,'phone_enroll');assert.equal(o.status,400);assert.equal(o.reason,'bad_key');assert.equal(typeof o.ms,'number');
  assert.ok(!('x' in o)&&!('y' in o)&&!('secret' in o));
  assert.doesNotMatch(lines.at(-1),/0x01|do-not-log|0x5e4c|0x1da2/);
});

test('a new key enroll logs ok without the public key',async()=>{
  const lines=[];const {call}=mk(lines);
  const r=await call({x:X,y:Y});
  assert.equal(r.code,200,r.text);
  const o=JSON.parse(lines.at(-1));
  assert.equal(o.event,'phone_enroll');assert.equal(o.status,200);assert.equal(o.reason,'ok');
  assert.doesNotMatch(lines.at(-1),/6b17d1f2|4fe342e2/);
});
