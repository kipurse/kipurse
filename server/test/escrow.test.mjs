// t595 item 3 (testnet/fork only): escrow payments are gated on the MERCHANT; malformed escrow requests refused.
import test from 'node:test';import assert from 'node:assert/strict';import {getAddress} from 'viem';import {mkdtempSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {engineFor} from './helpers/v5-fixture.mjs';import {BEGINNER_DEFAULTS} from '../src/v5/mandates.mjs';import {createBuy} from '../src/v5/buy.mjs';
const ESC=getAddress('0x00e5c00000000000000000000000000000000e5c'),M=getAddress('0x00110000000000000000000000000000000000aa');
const mk=(escrow)=>{const e=engineFor({ownerRulesDir:mkdtempSync(join(tmpdir(),'es-')),...(escrow?{escrow:{address:ESC}}:{})},{bal:1000000000n},{openSingle:'500000000',openDaily:'900000000',single:'500000000',daily:'900000000',term:'900000000'});
  e.engine.mandates.propose({items:BEGINNER_DEFAULTS.map(d=>({...d}))});const ok=()=>{for(const p of e.engine.mandates.proposals())e.engine.mandates.approve(p.id,()=>true);};ok();return {...e,ok,buy:createBuy(e.engine,{sleep:async()=>{},waitMs:0})};};
test('escrow: needs a merchant; escrowFor without escrow refused; new merchant asks Face ID even though the escrow is a fixed address; SDN merchant refused',async()=>{
  const {buy,ok}=mk(true);
  assert.equal((await buy.buy({to:ESC,amount:'1',merchant:'x',item:'i',idempotencyKey:'idem-es-0001'},'g')).reason,'escrow_needs_merchant');
  assert.equal((await buy.buy({to:ESC,amount:'1',merchant:'x',item:'i',escrowFor:'0x0330070FD38Ec3bB94F58FA55D40368271E9e54A',idempotencyKey:'idem-es-0002'},'g')).reason,'SANCTIONED_ADDRESS');
  const a=await buy.buy({to:ESC,amount:'1',merchant:'Shop',item:'i',escrowFor:M,idempotencyKey:'idem-es-0003'},'g');assert.equal(a.decision,'ask_owner');assert.equal(a.nothingPaid,true);
  ok();const b=await buy.buy({to:ESC,amount:'1',merchant:'Shop',item:'i',escrowFor:M,idempotencyKey:'idem-es-0003'},'g');assert.equal(b.state,'paid',JSON.stringify(b).slice(0,300));
  const big=await buy.buy({to:ESC,amount:'6',merchant:'Shop',item:'i',escrowFor:M,idempotencyKey:'idem-es-0004'},'g');assert.notEqual(big.state,'paid');
  const {buy:b2}=mk(false);assert.equal((await b2.buy({to:M,amount:'1',merchant:'x',item:'i',escrowFor:M,idempotencyKey:'idem-es-0005'},'g')).reason,'escrowFor_without_escrow');});
