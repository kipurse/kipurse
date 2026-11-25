// t1138 (decision 70): regressions for the three bugs the end-to-end flow matrix (test/fork/t1138-matrix.e2e.mjs) found.
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import {mkdtempSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {decodeAbiParameters} from 'viem';
import {createLedger} from '../src/v5/ledger.mjs';import {createPublicTrustApproval} from '../src/v5/trust-approve-public.mjs';
const W='0x1111111111111111111111111111111111111111',V='0x2222222222222222222222222222222222222222',O='0x3333333333333333333333333333333333333333',FEE='0xf14ef5dc4723245866c22c749a0a84afceba0dd9';
function ledgerWith(transfers,{feeTo}={}){const dir=mkdtempSync(join(tmpdir(),'t1138-'));const file=join(dir,'ledger.json');
  fs.writeFileSync(file,JSON.stringify({wallet:W.toLowerCase(),owner:O.toLowerCase(),from:1,next:100,transfers}));
  return createLedger({pub:{},token:'0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',wallet:W,vault:V,paymasters:[],names:{[O.toLowerCase()]:'你的 Base Account'},owner:O,ownerPaymasters:[],...(feeTo?{feeTo}:{}),fromBlock:1,file});}
const wd=[{tx:'0xa1',block:10,t:1,li:0,from:W,to:FEE,value:'10990'},{tx:'0xa1',block:10,t:1,li:1,from:W,to:O,value:'1489010'},{tx:'0xb2',block:11,t:2,li:0,from:W,to:FEE,value:'5944'}];
test('ledger: createLedger passes feeTo, so a wallet-pays withdraw is "to your Base Account" + fee, and a limits fee is a fee row',()=>{
  const {rows}=ledgerWith(wd,{feeTo:FEE}).view({wallet:'0',vault:'0'});const w=rows.find(r=>r.tx==='0xa1'),f=rows.find(r=>r.tx==='0xb2');
  assert.equal(w.kind,'withdraw');assert.match(w.zh,/你的 Base Account/);assert.equal(w.delta,'-1500000');assert.deepEqual(w.detail,{sent:'1489010',fee:'10990'});
  assert.equal(f.kind,'walletfee');assert.deepEqual(f.detail,{fee:'5944'});
  assert.ok(!rows.some(r=>/0xf14e/.test(r.zh)),'no row says money went to the fee address');});
test('ledger: the bug it fixes (no feeTo -> money "sent to 0xf14e…")',()=>{const {rows}=ledgerWith(wd).view({wallet:'0',vault:'0'});assert.ok(rows.some(r=>/0xf14e/.test(r.zh)));});
test('everyday POST forwards the total (term) the app sends',()=>{const s=fs.readFileSync(new URL('../mainnet/mainnet-owner-launch.mjs',import.meta.url),'utf8');
  const h=s.slice(s.indexOf("u.pathname==='/everyday'&&req.method==='POST'"));assert.match(h.slice(0,1600),/EVD\.set\(\{single:b\?\.single,daily:b\?\.daily,term:b\?\.term\}\)/);});
function trustRig({index,findIndex}){const id='0b9d4c1e-1111-4222-8333-944445555666';const payee='0x4444444444444444444444444444444444444444';
  const r={id,status:'awaiting_owner',payee,single:'1000000',total:'5000000',merchantName:'m',reason:'r',requestedBy:['ai']};let wrapper=null;
  const message={merchant:'0x'+'ab'.repeat(32),name:'m',payees:[payee],signers:[],single:'1000000',daily:'5000000',expiry:'1900000000',nonce:'0x'+'cd'.repeat(32),deadline:'1900000000'};
  const TA=createPublicTrustApproval({owner:O,wallet:W,base:()=>'http://x',script:()=>'',verifyTypedData:async()=>false,verifyMessage:async()=>false,
    ownerApi:{list:()=>({pending:[r],recent:[]}),approve:async()=>({typedData:{},innerTypedData:{message,domain:{chainId:8453}},digest:'0x'+'ef'.repeat(32)}),submitSignature:async(i,w)=>{wrapper=w;return {status:'trusted',txHash:'0x99'};}},
    phone:{active:()=>({approver:'0x5555555555555555555555555555555555555555',...(index==null?{}:{index}),maxSingle:(2n**160n-1n).toString(),maxDaily:(2n**160n-1n).toString()}),...(findIndex?{findIndex}:{}),verifyWrapped:async()=>true}});
  const call=async(path,body)=>{let code,out;const res={writeHead:c=>{code=c;},end:s=>{out=JSON.parse(s);}};
    await TA.handle({method:'POST'},res,new URL('http://x'+path),{readBody:async()=>body,ip:'1'});return {code,out};};
  return {id,call,wrapper:()=>wrapper};}
test('trust phone-sign: a phone added by the opening batch (no stored index) signs with the on-chain owner index',async()=>{
  const g=trustRig({findIndex:async()=>3});assert.equal((await g.call('/approve/trust/phone-prepare',{id:g.id})).code,200);
  const s=await g.call('/approve/trust/phone-sign',{id:g.id,r:'0x'+'01'.repeat(32),s:'0x'+'02'.repeat(32)});assert.equal(s.code,200,JSON.stringify(s.out));assert.equal(s.out.status,'trusted');
  const [w]=decodeAbiParameters([{type:'tuple',components:[{name:'ownerIndex',type:'uint256'},{name:'signatureData',type:'bytes'}]}],g.wrapper());assert.equal(w.ownerIndex,3n);});
test('trust phone-sign: stored index still used; no index and no lookup -> clear phone_not_owner (never a fake bad_signature)',async()=>{
  const a=trustRig({index:2});await a.call('/approve/trust/phone-prepare',{id:a.id});assert.equal((await a.call('/approve/trust/phone-sign',{id:a.id,r:'0x'+'01'.repeat(32),s:'0x'+'02'.repeat(32)})).code,200);
  const b=trustRig({});await b.call('/approve/trust/phone-prepare',{id:b.id});const s=await b.call('/approve/trust/phone-sign',{id:b.id,r:'0x'+'01'.repeat(32),s:'0x'+'02'.repeat(32)});assert.equal(s.code,409);assert.equal(s.out.error,'phone_not_owner');});
