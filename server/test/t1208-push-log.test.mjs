// t1208 / decision 94: every APNs attempt is logged (kind, production|sandbox, HTTP status, APNs reason, sent) through the
// observability allow-list; device tokens never appear in any log line; tokens APNs says can never work for this app are dropped.
import test from 'node:test';import assert from 'node:assert/strict';import {EventEmitter} from 'node:events';
import {generateKeyPairSync} from 'node:crypto';import {mkdtempSync,writeFileSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {createPush} from '../src/v5/push.mjs';import {createObs} from '../src/v5/obs.mjs';
const keyFile=join(mkdtempSync(join(tmpdir(),'apns-')),'k.p8');writeFileSync(keyFile,generateKeyPairSync('ec',{namedCurve:'P-256'}).privateKey.export({type:'pkcs8',format:'pem'}));
const TA='a'.repeat(64),TB='b'.repeat(64),TC='c'.repeat(64);
// fake APNs: answer by (host, token)
const ANS={[`prod:${TA}`]:[400,'BadDeviceToken'],[`sandbox:${TA}`]:[200,null],[`prod:${TB}`]:[400,'DeviceTokenNotForTopic'],[`prod:${TC}`]:[500,'InternalServerError']};
const connect=url=>{const c=new EventEmitter();c.close=()=>{};const env=url.includes('sandbox')?'sandbox':'prod';
  c.request=h=>{const s=new EventEmitter();s.end=()=>{const tok=h[':path'].split('/').pop();const [st,reason]=ANS[`${env}:${tok}`]??[400,'BadDeviceToken'];
    setImmediate(()=>{s.emit('response',{':status':st});if(reason)s.emit('data',JSON.stringify({reason}));s.emit('end');});};return s;};return c;};
test('decision 94 push: per-attempt log with env/status/reason, no device token anywhere; dead tokens dropped, live ones kept',async()=>{
  const lines=[];const obs=createObs({out:s=>lines.push(s)});
  const p=createPush({config:{keyFile,keyId:'KID1234567',teamId:'TEAM123456',topic:'com.example.app'},log:(n,d)=>obs.log(n,d),connect});
  let list=[{token:TA,lang:'zh'},{token:TB,lang:'zh'},{token:TC,lang:'en',env:'production'}];const envs={};
  const tokens={list:()=>list,remove:t=>{list=list.filter(x=>x.token!==t);},setEnv:(t,e)=>{envs[t]=e;}};
  const r=await p.notify(tokens,{kind:'mandate',id:'m1',zh:'AI 请求付款',en:'AI asks'});
  assert.deepEqual(r,{sent:1,failed:2,removed:1});
  assert.equal(envs[TA],'sandbox');assert.deepEqual(list.map(x=>x.token),[TA,TC]);   // TB (other app id) dropped, TC (server error) kept
  const J=lines.map(l=>JSON.parse(l));const att=J.filter(x=>x.event==='push_attempt');
  assert.deepEqual(att.map(a=>[a.kind,a.env,a.apnsStatus,a.apnsReason,a.sent]),[['mandate','production',400,'BadDeviceToken',0],['mandate','sandbox',200,null,1],['mandate','production',400,'DeviceTokenNotForTopic',0],['mandate','production',500,'InternalServerError',0]]);
  const sum=J.find(x=>x.event==='push');assert.deepEqual([sum.kind,sum.sent,sum.failed,sum.removed,sum.count],['mandate',1,2,1,3]);
  const all=lines.join('\n');for(const t of [TA,TB,TC])assert.ok(!all.includes(t),'token in log');assert.ok(!/[0-9a-f]{64}/.test(all));});
test('decision 94 obs allow-list: push fields kept, anything else (e.g. token) still dropped',()=>{const lines=[];const obs=createObs({out:s=>lines.push(s)});
  obs.log('push_attempt',{kind:'owner_ask',env:'sandbox',apnsStatus:200,apnsReason:null,sent:1,token:TA,deviceToken:TA});obs.log('push_register',{enabled:true,token:TA});
  const a=JSON.parse(lines[0]),b=JSON.parse(lines[1]);assert.equal(a.env,'sandbox');assert.equal(a.apnsStatus,200);assert.equal(a.sent,1);assert.equal(a.token,undefined);assert.equal(a.deviceToken,undefined);
  assert.equal(b.enabled,true);assert.equal(b.token,undefined);assert.ok(!lines.join('').includes(TA));});
test('decision 94 an APNs reason that is not a plain word is not logged verbatim',async()=>{const lines=[];const obs=createObs({out:s=>lines.push(s)});
  const c2=url=>{const c=connect(url);const rq=c.request;c.request=h=>{const s=rq(h);s.end=()=>setImmediate(()=>{s.emit('response',{':status':400});s.emit('data',JSON.stringify({reason:'weird '+TA}));s.emit('end');});return s;};return c;};
  const p=createPush({config:{keyFile,keyId:'K',teamId:'T',topic:'x'},log:(n,d)=>obs.log(n,d),connect:c2});
  await p.notify({list:()=>[{token:TC,env:'production'}],remove:()=>{},setEnv:()=>{}},{kind:'hold',id:'h',name:'n',amount:'1'});
  assert.ok(lines.some(l=>JSON.parse(l).apnsReason==='other'));assert.ok(!lines.join('').includes(TA)&&!lines.join('').includes(TC));});
