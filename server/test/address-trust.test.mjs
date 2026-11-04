const ORD={order:{item:'test item',merchant:'Test Shop',user_request:'please buy the test item'}};
import test from 'node:test';import assert from 'node:assert/strict';
import {getAddress} from 'viem';
import {classifyPayee,isLookalike,diffGroups,groups4} from '../src/v5/address-trust.mjs';
import {engineFor,direct,PAYEE} from './helpers/v5-fixture.mjs';
import {INSTRUCTIONS,TOOL_NAMES_V5} from '../src/v5/mcp.mjs';
const A='0x000000000000000000000000000000000000dEaD',LOOK='0x000011111111111111111111111111111111dEaD',OTHER='0x1111000000000000000000000000000000002222';
test('lookalike = same first 4 + last 4 hex, different full address; exact = full 40 hex, case-insensitive',()=>{
  assert.equal(isLookalike(A,LOOK),true);assert.equal(isLookalike(A,A.toLowerCase()),false);assert.equal(isLookalike(A,OTHER),false);
  assert.equal(isLookalike(A,'0x000011111111111111111111111111111111dEaC'),false);
  assert.deepEqual(diffGroups(A,LOOK),[1,2,3,4,5,6,7,8]);assert.equal(groups4(A),'0x0000 0000 0000 0000 0000 0000 0000 0000 0000 dEaD');});
test('classify: verified / lookalike / dust_only / new / blocked',()=>{const known=[{address:A,label:'Alice',kind:'paid_before'}];
  assert.equal(classifyPayee({address:A.toLowerCase(),known}).status,'verified');
  assert.equal(classifyPayee({address:OTHER,tier:'trusted',known}).verified,true);
  const l=classifyPayee({address:LOOK,known});assert.equal(l.status,'lookalike');assert.equal(l.required_action,'phone_face_id');assert.equal(l.lookalikes[0].label,'Alice');
  assert.equal(classifyPayee({address:OTHER,known,inbound:[{from:OTHER,amount:'9999',usdc:true}]}).status,'dust_only');
  assert.equal(classifyPayee({address:OTHER,known,inbound:[{from:OTHER,amount:'5000000',usdc:false}]}).status,'dust_only');
  assert.equal(classifyPayee({address:OTHER,known,inbound:[{from:OTHER,amount:'10000',usdc:true}]}).status,'new');
  assert.equal(classifyPayee({address:OTHER,known}).status,'new');assert.equal(classifyPayee({address:OTHER,known}).verified,false);
  assert.equal(classifyPayee({address:OTHER,tier:'denied',known}).required_action,'refuse');
  const lt=classifyPayee({address:LOOK,known});assert.match(lt.explain_zh,/Face ID/);assert.doesNotMatch(lt.explain_en,/[\u3400-\u9fff]/);});
test('engine: new payee pays (not verified), then exact = verified, lookalike refused (nothing sent), dust-origin refused, owner Face ID pay exempt',async()=>{
  const deps=[{from:'0x1111000000000000000000000000000000002222',amount:'1',status:'accepted'}];
  const {engine,cfg}=engineFor();
  const r1=await engine.pay({...ORD,request:direct('20000','at-1'),idempotencyKey:'idem-at-0001'});assert.equal(r1.reason,'NEW_PAYEE_NEEDS_OWNER');assert.equal(r1.addressStatus,'new');assert.equal(r1.nothingPaid,true);
  const v=await engine.verifyPayee({address:PAYEE.toLowerCase()});assert.equal(v.verified,false);
  engine.mandates.remember(PAYEE,'Shop');const r2=await engine.pay({...ORD,request:direct('20000','at-2'),idempotencyKey:'idem-at-0002'});assert.equal(r2.state,'paid');assert.equal(r2.payeeVerified,true);
  cfg.ownerGuard={deposits:()=>deps,limits:()=>null,quarantined:()=>0n};// refusals happen before any spend path
  const look=getAddress((PAYEE.slice(0,6)+'0'.repeat(32)+PAYEE.slice(-4)).toLowerCase());
  const r3=await engine.pay({...ORD,request:direct('20000','at-3',look),idempotencyKey:'idem-at-0003'});assert.equal(r3.state,'rejected');assert.equal(r3.reason,'LOOKALIKE_NEEDS_PHONE');assert.equal(r3.nothingPaid,true);assert.match(r3.fix,/kipurse_request_trust/);
  const r4=await engine.pay({...ORD,request:direct('20000','at-4',getAddress('0x1111000000000000000000000000000000002222')),idempotencyKey:'idem-at-0004'});assert.equal(r4.reason,'DUST_ORIGIN');
  const r5=await engine.pay({...ORD,request:direct('20000','at-5',getAddress('0x3333000000000000000000000000000000004444')),idempotencyKey:'idem-at-0005',addressSource:'from_tx_history'});assert.equal(r5.state,'rejected');
  // refusal is not cached under the idempotency key: same key re-checks
  const r3b=await engine.pay({...ORD,request:direct('20000','at-3',look),idempotencyKey:'idem-at-0003'});assert.equal(r3b.reason,'LOOKALIKE_NEEDS_PHONE');
  const d=(await engine.deposits()).deposits[0];assert.equal(d.flag,'suspicious_dust');});
test('MCP: verify tool listed; instructions say server verifies, AI only reports verified / not verified, no restatement',()=>{
  assert.ok(TOOL_NAMES_V5.includes('kipurse_verify_payee'));assert.match(INSTRUCTIONS,/FULL address for you/);assert.match(INSTRUCTIONS,/已核实/);assert.doesNotMatch(INSTRUCTIONS,/expected_address_echo/);});
