// t1210 (decision 95, owner t1214/t1216): an AI repeating a still-pending identical request gets the SAME card back (dedupe unchanged, no new
// request, nothing paid) and the owner's phone is pushed again, at most once per 5 minutes. kipurse_remind_owner also works for buy / allowance
// requests, only for the AI that made them. Nothing here can approve or pay.
import test from 'node:test';import assert from 'node:assert/strict';import {mkdtempSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {getAddress} from 'viem';import {DatabaseSync} from 'node:sqlite';
import {engineFor} from './helpers/v5-fixture.mjs';import {BEGINNER_DEFAULTS,createMandates} from '../src/v5/mandates.mjs';import {createBuy} from '../src/v5/buy.mjs';
let seq=0x9100;const fresh=()=>{seq++;return getAddress('0x'+seq.toString(16).padStart(6,'0')+'b'.repeat(28)+seq.toString(16).padStart(6,'0'));};
let k=0;const idem=()=>'idem-t1210-'+(k++).toString().padStart(5,'0');
const count=db=>db.prepare(`SELECT count(*) AS n FROM mandate_proposal`).get().n;

test('mandates: repeat of a pending AI request -> same request, exactly one re-push; quick second repeat -> no push; after 5 min -> one more',()=>{
  const db=new DatabaseSync(':memory:');let t=1.8e12;const pushes=[];const M=createMandates({db,now:()=>t,onProposal:v=>pushes.push(v)});
  const payee=fresh().toLowerCase();const req=()=>M.propose({items:[{purpose:'daily',single:'5',oneOff:{payee,host:null,remember:true}}],by:'agent:claude',reason:'buy',dedupe:['buy',payee,'5000000','daily'].join('|')});
  const p1=req();assert.equal(pushes.length,1,'first push');assert.equal(count(db),1);
  t+=1000;const p2=req();assert.equal(p2.id,p1.id);assert.equal(p2.idempotent,true);assert.equal(p2.repushed,true);assert.equal(pushes.length,2,'exactly one re-push');assert.equal(pushes[1].id,p1.id);assert.equal(pushes[1].repush,true);assert.equal(count(db),1,'no new request');
  t+=1000;const p3=req();assert.equal(p3.id,p1.id);assert.equal(p3.repushed,false);assert.equal(pushes.length,2,'quick second repeat: no push');
  t+=300e3;assert.equal(req().repushed,true);assert.equal(pushes.length,3);assert.equal(count(db),1);
  const own=M.propose({items:[{purpose:'daily',single:'5',oneOff:{payee,host:null,remember:true}}],by:'owner',dedupe:['buy',payee,'5000000','daily'].join('|')});assert.equal(own.id,p1.id);assert.equal(own.repushed,undefined,'owner drafts never push');assert.equal(pushes.length,3);
  /* t1264: an expired request is never pushed again and never handed back by dedupe: it is closed and a NEW request (one push) is made */
  t+=86400e3;const p4=req();assert.notEqual(p4.id,p1.id,'expired request is never reused');assert.equal(p4.idempotent,undefined);assert.equal(M.getProposal(p1.id).state,'expired');
  assert.equal(pushes.length,4,'only the new request is pushed');assert.equal(pushes[3].id,p4.id);assert.equal(count(db),2);});

test('mandates.remind: same AI only, 5-min gate, never for a decided request',()=>{
  const db=new DatabaseSync(':memory:');let t=1.8e12;const pushes=[];const M=createMandates({db,now:()=>t,onProposal:v=>pushes.push(v)});
  const payee=fresh().toLowerCase();const p=M.propose({items:[{purpose:'daily',single:'5',oneOff:{payee,host:null,remember:true}}],by:'agent:claude',dedupe:'d1'});assert.equal(pushes.length,1);
  assert.equal(M.remind(p.id,'agent:grok').error,'not_found','another AI cannot use it');assert.equal(pushes.length,1);
  assert.equal(M.remind('apr_nope','agent:claude').error,'not_found');
  const r1=M.remind(p.id,'agent:claude');assert.equal(r1.ok,true);assert.equal(r1.proposal.id,p.id);assert.equal(pushes.length,2);
  const r2=M.remind(p.id,'agent:claude');assert.equal(r2.error,'too_soon');assert.ok(r2.retryAfterSec>0&&r2.retryAfterSec<=300);assert.equal(pushes.length,2);
  t+=301e3;assert.equal(M.remind(p.id,'agent:claude').ok,true);assert.equal(pushes.length,3);
  M.reject(p.id);t+=301e3;const r3=M.remind(p.id,'agent:claude');assert.equal(r3.error,'not_pending');assert.equal(pushes.length,3);
  assert.equal(M.getProposal(p.id).state==='pending',false,'remind never approves');});

const mk=()=>{const props=[];const e=engineFor({onMandateProposal:v=>props.push(v),ownerRulesDir:mkdtempSync(join(tmpdir(),'t1210-'))},{bal:5000000000n,delayMs:1},{openSingle:'10050000',openDaily:'900000000',single:'100050000',daily:'900000000',term:'900000000'});
  e.engine.mandates.propose({items:BEGINNER_DEFAULTS.filter(d=>d.on),by:'owner'});for(const p of e.engine.mandates.proposals())e.engine.mandates.approve(p.id,()=>true);
  return {...e,props,buy:createBuy(e.engine,{sleep:async()=>{},waitMs:0})};};

test('kipurse_buy repeat (new key) of a pending buy request -> same approvalId, one re-push, nothing paid; kipurse_remind_owner works for it, same AI only',async()=>{
  const e=mk();const to=fresh();const w0=e.s.writes.length;
  const r1=await e.buy.buy({purpose:'daily',item:'domain check',merchant:'shop.example',to,amount:'1',idempotencyKey:idem()},'claude');
  assert.equal(r1.state,'awaiting_owner_approval');assert.equal(r1.reason,'NEW_PAYEE_NEEDS_OWNER');const n1=e.props.length;assert.equal(e.props.at(-1).ask,undefined,'buy / allowance type (not the t1170 card)');
  const r2=await e.buy.buy({purpose:'daily',item:'domain check',merchant:'shop.example',to,amount:'1',idempotencyKey:idem()},'claude');
  assert.equal(r2.approvalId,r1.approvalId,'same request');assert.equal(e.props.length,n1+1,'exactly one re-push');assert.equal(e.props.at(-1).id,r1.approvalId);
  const r3=await e.buy.buy({purpose:'daily',item:'domain check',merchant:'shop.example',to,amount:'1',idempotencyKey:idem()},'claude');assert.equal(r3.approvalId,r1.approvalId);assert.equal(e.props.length,n1+1,'quick repeat: no push');
  assert.equal(e.engine.mandates.proposals().filter(p=>p.id===r1.approvalId).length,1);
  const other=e.buy.remindOwner({approvalId:r1.approvalId},'grok');assert.equal(other.error,'not_found');assert.equal(other.nothingPaid,true);assert.equal(e.props.length,n1+1,'other AI refused');
  const soon=e.buy.remindOwner({approvalId:r1.approvalId},'claude');assert.equal(soon.error,'too_soon');assert.equal(e.props.length,n1+1);
  assert.equal(e.s.writes.length,w0,'nothing on chain');assert.notEqual(r2.state,'paid');assert.notEqual(r3.state,'paid');});

test('kipurse_remind_owner on a buy request: pushes once, then too_soon; reply is human text, nothing paid',async()=>{
  const e=mk();const to=fresh();const r1=await e.buy.buy({purpose:'daily',item:'x',merchant:'Shop',to,amount:'1',idempotencyKey:idem()},'claude');const n1=e.props.length;
  const rm=e.buy.remindOwner({approvalId:r1.approvalId,lang:'en'},'claude');assert.equal(rm.reminded,true);assert.equal(rm.state,'awaiting_owner_approval');assert.equal(rm.nothingPaid,true);assert.match(rm.say_to_user,/again/);
  assert.equal(e.props.length,n1+1);assert.equal(e.props.at(-1).id,r1.approvalId);
  assert.equal(e.buy.remindOwner({approvalId:r1.approvalId},'claude').error,'too_soon');assert.equal(e.props.length,n1+1);});
