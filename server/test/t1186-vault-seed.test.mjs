// t1185 (decision 86): opening seeds the owner's own payer vault with 0.15 USDC from his Base Account (first AI payment works).
import test from 'node:test';import assert from 'node:assert/strict';
import {vaultSeedCall,vaultSeedNote,usdcCallProblem,OPENING_VAULT_SEED,USDC_BASE} from '../src/v5/usdc-gas.mjs';
import {decodeFunctionData,parseAbi} from 'viem';
const W='0x0eBd05A4a2226a59790600a54129f4b0E90fC817',V='0xe635aB8852C3CB3b2125D3Cb45018657eF73946B',X='0x2222222222222222222222222222222222222222';
test('seed = 0.15 USDC transfer to the vault, owner money',()=>{assert.equal(OPENING_VAULT_SEED,150000n);const c=vaultSeedCall(V);assert.equal(c.to,USDC_BASE);
  const d=decodeFunctionData({abi:parseAbi(['function transfer(address,uint256)']),data:c.data});assert.equal(d.args[0],V);assert.equal(d.args[1],150000n);});
test('seed bounds 0.10..0.20',()=>{assert.throws(()=>vaultSeedCall(V,99999n));assert.throws(()=>vaultSeedCall(V,200001n));vaultSeedCall(V,100000n);vaultSeedCall(V,200000n);});
test('paymaster allow-list: seed only to THIS vault, only 0.10..0.20',()=>{assert.equal(usdcCallProblem(vaultSeedCall(V),{wallet:W,vault:V}),null);
  assert.equal(usdcCallProblem(vaultSeedCall(X),{wallet:W,vault:V}),'transfer');assert.equal(usdcCallProblem(vaultSeedCall(V),{wallet:W}),'transfer');
  const big={...vaultSeedCall(V),data:vaultSeedCall(V).data.replace(/0{4}249f0$/,'0000493e0')};assert.equal(usdcCallProblem(big,{wallet:W,vault:V}),'transfer');});
test('calm wording, says it is still yours',()=>{const n=vaultSeedNote();assert.match(n.zh,/0\.15 USDC/);assert.match(n.zh,/钱还是你的/);assert.match(n.en,/still your money/);
  for(const t of [n.zh,n.en])assert.doesNotMatch(t,/错误|失败|危险|被盗|攻击|盗刷|error|fail|danger|attack|abuse|stolen/i);});
