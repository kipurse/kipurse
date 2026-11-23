// SPDX-License-Identifier: AGPL-3.0-only
import test from 'node:test';import assert from 'node:assert/strict';import {createPublicLimits} from '../src/v5/limits-public.mjs';
const call=async(M,method,path,body)=>{let code,out;const res={writeHead:c=>{code=c;},end:b=>{out=b;}};await M.handle({method,headers:{}},res,new URL('http://x'+path),{readBody:async()=>body??{},ip:'1'});return {code,j:(()=>{try{return JSON.parse(out);}catch{return out;}})()};};
test('limits: the page signs exactly the plan the phone verified (plan id), never a new one',async()=>{
  let n=0;const M=createPublicLimits({fee:async()=>({usdc:1n,payerUSDC:9n,canPayUSDC:true}),plan:async c=>({owner:'0x2000000000000000000000000000000000000002',chainId:8453,human:{},labels:['x'],calls:[{to:'0x1',data:'0x'+(++n)}],raw:{}}),confirm:async()=>({valid:false}),current:async()=>null,script:()=>'',base:()=>'http://x'});
  const a=await call(M,'POST','/owner/limits/prepare',{single:'1000000',daily:'5000000',term:'20000000',days:30});assert.equal(a.code,200);
  const b=await call(M,'POST','/owner/limits/prepare',{plan:a.j.id});assert.equal(b.code,200);assert.deepEqual(b.j.calls,a.j.calls);assert.equal(n,1,'no new plan built');
  assert.equal((await call(M,'POST','/owner/limits/prepare',{plan:'f'.repeat(32)})).code,404);
  const pg=await call(M,'GET','/owner/limits?single=1&daily=5&term=20&days=30&plan='+a.j.id);assert.equal(pg.code,200);assert.ok(String(pg.j).includes(a.j.id));
  const pg2=await call(M,'GET','/owner/limits?single=1&daily=5&term=20&days=30&plan=<script>');assert.ok(!String(pg2.j).includes('<script>'));});
