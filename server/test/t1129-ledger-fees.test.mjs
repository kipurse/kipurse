// t1129: [zh] must show every real wallet movement: withdraw principal + fee, and wallet-paid network fees (limits / Face ID enable).
import test from 'node:test';import assert from 'node:assert/strict';import {classify,withBalances} from '../src/v5/ledger.mjs';
const W='0x515010c2e41F98CdDd76B819EE69DC832c0939B6',O='0x4242b022A8296cB18B0E0b1Cb9879C518170A718',F='0xf14ef5dc4723245866c22c749a0a84afceba0dd9',V='0x0000000000000000000000000000000000000001',S='0x00000000000000000000000000000000000000aa';
const tr=[{tx:'0xa',block:1,t:1,li:0,from:S,to:W,value:12340000n},{tx:'0xb',block:2,t:2,li:0,from:W,to:F,value:11300n},{tx:'0xb',block:2,t:2,li:1,from:W,to:O,value:988700n},{tx:'0xc',block:3,t:3,li:0,from:W,to:F,value:6100n}];
test('withdraw + limits fee rows reconcile to the on-chain balance',()=>{const {rows,opening}=withBalances(classify(tr,{wallet:W,vault:V,owner:O,feeTo:F,names:{[O.toLowerCase()]:'你的 Base Account'}}),{wallet:'11333900',vault:'0'});
  assert.equal(opening.wallet,'0');assert.deepEqual(rows.map(r=>r.kind),['deposit','withdraw','walletfee']);
  assert.deepEqual(rows[1].detail,{sent:'988700',fee:'11300'});assert.equal(rows[1].delta,'-1000000');assert.match(rows[1].zh,/你的 Base Account 0\.9887，手续费 0\.0113/);
  assert.equal(rows[2].delta,'-6100');assert.deepEqual(rows[2].detail,{fee:'6100'});assert.equal(rows[2].balance,'11333900');});
test('without feeTo the old shape is kept',()=>{const rows=classify(tr,{wallet:W,vault:V});assert.deepEqual(rows.map(r=>r.kind),['deposit','withdraw','withdraw']);assert.equal(rows[1].detail,undefined);});
