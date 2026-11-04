import test from 'node:test';import assert from 'node:assert';import {withSignCors,SIGN_ORIGIN} from '../src/v5/cors.mjs';
const run=(o,m='GET')=>{const h={};let st=null,ended=false,called=false;const res={setHeader:(k,v)=>h[k]=v,writeHead:(s,x)=>{st=s;Object.assign(h,x);},end:()=>ended=true};
  withSignCors(()=>{called=true;})({headers:o?{origin:o}:{},method:m},res);return {h,st,called};};
test('CORS only for the kipurse-sign Pages project',()=>{
  assert.ok(SIGN_ORIGIN.test('https://kipurse-sign.example.workers.dev'));assert.ok(SIGN_ORIGIN.test('https://1a2b3c4d-kipurse-sign.example.workers.dev'));
  for(const bad of ['https://kipurse-sign.evil.workers.dev','https://kipurse-sign.example.workers.dev.evil.com','http://kipurse-sign.example.workers.dev','https://x.kipurse-sign.example.workers.dev','https://kipurse-signx.example.workers.dev'])assert.ok(!SIGN_ORIGIN.test(bad),bad);
  let r=run('https://1a2b3c4d-kipurse-sign.example.workers.dev');assert.equal(r.h['access-control-allow-origin'],'https://1a2b3c4d-kipurse-sign.example.workers.dev');assert.ok(r.called);assert.equal(r.h['access-control-allow-credentials'],undefined);
  r=run('https://evil.example');assert.equal(r.h['access-control-allow-origin'],undefined);assert.ok(r.called);
  r=run('https://kipurse-sign.example.workers.dev','OPTIONS');assert.equal(r.st,204);assert.ok(!r.called);
  r=run('https://evil.example','OPTIONS');assert.ok(r.called,'foreign preflight goes to the normal handler');});
