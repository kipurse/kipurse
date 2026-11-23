// t1252 (handbook §6#121): V5.5 x402 reservations are closed by the VAULT itself (UserOp, USDC gas via Circle), never by an ETH keeper by default.
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';
const rd=p=>fs.readFileSync(new URL('../'+p,import.meta.url),'utf8');
test('launch: no keeper file -> markSettledInline + permitAtCap (vault pays in USDC); the ETH keeper only if an operator sets one',()=>{
  const s=rd('mainnet/mainnet-owner-launch.mjs');
  assert.match(s,/if\(!kf\)\{out\.markSettledInline=true;out\.permitAtCap=true;OBS\.log\('v55_settle_mode',\{mode:'vault_usdc'\}\);\}/);
  assert.match(s,/else if\(kf&&fs\.existsSync\(kf\)/);
  assert.doesNotMatch(s,/v55_keeper_missing/);});
test('engine: x402 success -> markSettledOne through the vault writer; every op of a permitAtCap wallet asks for a cap-sized permit',()=>{
  const s=rd('src/v5/engine.mjs');
  assert.match(s,/if\(second\.ok&&cfg\.markSettledInline===true\)pendingClose\.push\(markSettledOne\(r\.digest,r\.auth\)/);
  assert.match(s,/uow\.write\(fn,args,\{\.\.\.o,\.\.\.\(cfg\.permitAtCap===true\?\{permitAtCap:true\}:\{\}\)/);
  assert.match(s,/const tx=await write\('markSettled',\[\[digest\]\]/);});
test('userop: cap-sized permit only when the vault has maxGasPerOp of FREE USDC (balance - reservedTotal); never above the owner cap',()=>{
  const s=rd('src/v5/userop.mjs');
  assert.match(s,/atCap=BigInt\(b\)>=BigInt\(rt\)\+BigInt\(maxGasPerOp\)/);
  assert.match(s,/build\(calls,\{raw,permitAtCap:atCap\}\)/);
  assert.match(s,/o\.permitAmount=permitAtCap\?cap:sizePermit\(/);
  assert.match(s,/const cap=BigInt\(maxGasPerOp\)/);});
// t1270: the V5.5 fork e2e (t1250-v55-suite-fork) drives the operator's real wallet and is not part of the open-source export.
