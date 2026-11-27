// t1189 (decision 89): Coinbase's (CDP) bundler could not estimate the single ~12M-gas deploy batch ("estimateCallGas should make progress each
// time it is called"). The page now asks for two confirmations in order, each pinned by its own link commitment; the old link is refused calmly.
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';
import {loadV53Plan,deployV53Calls,deployV53Fragment} from '../src/v5/deploy-v53.mjs';
const plan=loadV53Plan(new URL('../mainnet/v53-deploy-plan.json',import.meta.url).pathname);const O='0x4242b022A8296cB18B0E0b1Cb9879C518170A718';
const SRC=fs.readFileSync(new URL('../owner-sign/consent/deploy-v53.js',import.meta.url),'utf8');const B=fs.readFileSync(new URL('../owner-sign/static/deploy-v53.js',import.meta.url),'utf8');
test('link fragment: two fixed commitments for the owner (step 1, step 2); stable values',()=>{const f=deployV53Fragment(plan,O);
  assert.match(f,/^vh1=[0-9a-f]{64}&vh2=[0-9a-f]{64}$/);
  assert.equal(f,'vh1=082b273abc5067e2ae06bdd2867ca72d2b68963b598eac2dab8efc3dd6151256&vh2=5f5b7aaf97b5a4e863156ee9e3647f2f8623bd7e197eba0bfcac8d49e4c20334'/* t1346: fee leg -> company Safe (was vh1=e48edaf3…&vh2=28c631cd… with 0xf14E…) */);});
test('each step batch is small enough for the bundler: one deploy + one fee leg (no batch carries both deploys)',()=>{
  for(const k of [1,2]){const C=deployV53Calls(plan,k);assert.equal(C.length,2);assert.equal(C.filter(c=>c.to.toLowerCase()==='0x4e59b44847b379578588920ca78fbf26c0b4956c').length,1);}});
test('script: needs both link commitments, points the KPVH guard at the current step, one send per tap, no loop / auto retry',()=>{
  assert.match(SRC,/H\.get\('vh1'\),H\.get\('vh2'\)/);assert.match(SRC,/history\.replaceState\(null,'',location\.pathname\+location\.search\+'#vh='\+VH\[k\]/);
  assert.match(SRC,/!linkOk\)\{go\.style\.display='none'/);assert.match(SRC,/这是旧链接/);assert.match(SRC,/C\.length!==2/);assert.match(SRC,/D\.fees\[k-1\]/);
  assert.equal((SRC.match(/wallet_sendCalls/g)??[]).length,1);assert.doesNotMatch(SRC,/setInterval|location\.reload|\.click\(\)/);
  const go=SRC.slice(SRC.indexOf('go.onclick='));assert.ok(go.indexOf('useStep(k)')<go.indexOf('wallet_sendCalls'));assert.ok(go.indexOf('eth_requestAccounts')<go.indexOf('useStep(k)'));
  assert.ok(B.includes('KPVH-GUARD v1'));assert.match(B,/vh1/);assert.match(B,/vh2/);assert.match(B,/replaceState/);assert.doesNotMatch(SRC+B,/签名|网络费/);});
