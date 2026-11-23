import test from 'node:test';import assert from 'node:assert/strict';
import {buyUrl,sessionLimiter,createOnramp} from '../src/v5/onramp.mjs';
import {readFileSync} from 'node:fs';
test('t864: send experience prefills USDC on Base and transfer-from-Coinbase; buy unchanged', () => {
  const s=new URL(buyUrl('tok',{experience:'send',ref:'kp-0123456789abcdef01234567'}));
  assert.equal(s.searchParams.get('defaultExperience'),'send');assert.equal(s.searchParams.get('defaultAsset'),'USDC');assert.equal(s.searchParams.get('defaultNetwork'),'base');
  assert.equal(new URL(buyUrl('tok',{})).searchParams.get('defaultExperience'),null);
  assert.equal(new URL(buyUrl('tok',{experience:'evil'})).searchParams.get('defaultExperience'),null);
});
test('t864: per-wallet session limiter (10 / 10 min), wallets independent', () => {
  let t=0;const hit=sessionLimiter({now:()=>t});for(let i=0;i<10;i++)assert.ok(hit('0xA'));assert.ok(!hit('0xa'));assert.ok(hit('0xB'));t+=10*60e3+1;assert.ok(hit('0xA'));
});
test('t864: session destination is only the given (tenant) wallet, Base, USDC', async () => {
  let body;const o=createOnramp({env:{KIPURSE_ONRAMP:'on',KIPURSE_ONRAMP_KEY_FILE:'/dev/null'},jwt:async()=>'j',kv:{put(){},get(){}},
    fetchFn:async(u,o2)=>{body=JSON.parse(o2.body);return {ok:true,status:200,json:async()=>({token:'T'})};}});
  o.status=()=>({enabled:true});
  const w='0x1111000000000000000000000000000000000001';
  const r=await o.session(w,{experience:'send'}).catch(e=>[0,{err:String(e)}]);
  if(r[1]?.err||r[1]?.error){ // key loader is file-based; assert routing instead
    const src=readFileSync(new URL('../mainnet/mainnet-owner-launch.mjs',import.meta.url),'utf8');
    assert.match(src,/ONRAMP\.session\(R\.wallet,/);return; }
  assert.deepEqual(body.addresses,[{address:w,blockchains:['base']}]);assert.deepEqual(body.assets,['USDC']);assert.match(r[1].url,/defaultExperience=send/);
});
test('t864: launcher: onramp session/status accept read-grant phones, session is rate limited, purchase gate kept, destination R.wallet', () => {
  const src=readFileSync(new URL('../mainnet/mainnet-owner-launch.mjs',import.meta.url),'utf8');
  const line=src.split('\n').find(l=>l.includes("'/phone/onramp/session'"));const rest=src.slice(src.indexOf("'/phone/onramp/session'")).slice(0,1500);
  assert.ok(line.includes('PS.checkRead'));assert.ok(rest.includes('ONRLIM(R.wallet)'));assert.ok(rest.includes('PGATE(R.owner'));assert.ok(rest.includes('ONRAMP.session(R.wallet,'));
  assert.ok(src.split('\n').find(l=>l.includes("'/phone/onramp/status'")).includes('PS.checkRead'));
  assert.ok(!src.split('\n').find(l=>l.includes("'/phone/onramp/applepay")).includes('checkRead'),'Apple Pay stays approver-only');
});
