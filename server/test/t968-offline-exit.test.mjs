// t968 offline-exit harness (no network, no keys): the rescue page logic alone must produce a correct Base Sepolia exit batch.
import test from 'node:test';import assert from 'node:assert/strict';import {decodeFunctionData} from 'viem';import {parseCard,buildRescue,checkTo,gasRoute,ABI,CHAINS} from '../kit/rescue/src/plan.mjs';
const W='0x1111111111111111111111111111111111111111',V='0x2222222222222222222222222222222222222222',O='0x3333333333333333333333333333333333333333';
const card={v:1,wallet:W,vault:V,chainId:84532};
const enc=s=>Buffer.from(JSON.stringify(s)).toString('base64url');
test('t968: card from URL fragment parses without any server',()=>{const c=parseCard('https://x/rescue#c='+enc(card));assert.equal(c.wallet,W);});
test('t968: Sepolia exit batch sweeps vault and moves wallet+vault total to owner',()=>{
  const r=buildRescue({card,owner:O,balances:{wallet:'3000000',vault:'500000'},chainId:84532});assert.equal(r.receive,'3500000');
  const outer=decodeFunctionData({abi:ABI,data:r.calls[0].data});assert.equal(outer.functionName,'executeBatch');const inner=outer.args[0];
  assert.equal(inner.at(-1).target.toLowerCase(),CHAINS[84532].usdc.toLowerCase());
  const tr=decodeFunctionData({abi:ABI,data:inner.at(-1).data});assert.deepEqual(tr.args,[O,3500000n]);});
test('t968: destination guard refuses the wallet itself',()=>{assert.equal(checkTo(W,{wallet:W}).ok,false);assert.equal(checkTo(O,{wallet:W}).ok,true);});
test('t968: no paymaster configured -> self-pay route (works with zero Kipurse infrastructure)',()=>{assert.equal(gasRoute({},84532).mode,'self');});
test('t968: empty wallet -> no calls',()=>{assert.equal(buildRescue({card,owner:O,balances:{},chainId:84532}).calls.length,0);});
