// REAL e2e on Base Sepolia of the owner kit: kit server + a real MCP client (Streamable HTTP, per-agent token URL).
// The owner "signs" with our TESTNET owner EOA sending exactly the calls the page would hand to Base Account (no Face ID on the box).
//   node kit/e2e-sepolia.mjs <testnet keys.json 0600, never printed>
import fs from 'node:fs';import {join} from 'node:path';import {spawn} from 'node:child_process';import {mkdtempSync} from 'node:fs';import {tmpdir} from 'node:os';
import {createPublicClient,createWalletClient,http,parseAbi} from 'viem';import {privateKeyToAccount,generatePrivateKey} from 'viem/accounts';import {baseSepolia} from 'viem/chains';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
const kf=process.argv[2];if((fs.statSync(kf).mode&0o777)!==0o600)throw Error('keys 0600');const owner=privateKeyToAccount(JSON.parse(fs.readFileSync(kf)).owner);
const U='0x036CbD53842c5426634e7929541eC2318f3dCF7e',PORT=18680,B=`http://localhost:${PORT}`;const pub=createPublicClient({chain:baseSepolia,transport:http('https://sepolia.base.org',{retryCount:3})});
const ow=createWalletClient({chain:baseSepolia,account:owner,transport:http('https://sepolia.base.org',{retryCount:3})});const ERC=parseAbi(['function balanceOf(address) view returns (uint256)','function transfer(address,uint256) returns (bool)']);
const bal=a=>pub.readContract({address:U,abi:ERC,functionName:'balanceOf',args:[a]});const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const R=[];const check=(n,ok,ev)=>{R.push({name:n,ok:!!ok,ev});console.log((ok?'PASS ':'FAIL ')+n+' '+JSON.stringify(ev??{}).slice(0,300));};
const DIR=mkdtempSync(join(tmpdir(),'kit-e2e-'));const srv=spawn(process.execPath,['kit/server.mjs','--port',String(PORT),'--dir',DIR],{stdio:['ignore','pipe','pipe'],env:{KIPURSE_DEMO:'1',...process.env}});let log='';srv.stdout.on('data',d=>log+=d);srv.stderr.on('data',d=>log+=d);
let mc;
try{for(let i=0;i<60&&!fs.existsSync(join(DIR,'owner-link.txt'));i++)await sleep(500);const link=fs.readFileSync(join(DIR,'owner-link.txt'),'utf8').trim();
  const lg=await fetch(link,{redirect:'manual'});const cookie=lg.headers.get('set-cookie').split(';')[0];check('one-time owner link -> HttpOnly session',lg.status===303&&(await fetch(link,{redirect:'manual'})).status===403);
  const csrf=(await (await fetch(B+'/api/csrf',{headers:{cookie}})).json()).csrf;
  const api=async(p,b)=>{const r=await fetch(B+'/api/'+p,{method:b?'POST':'GET',headers:{cookie,'x-kp-csrf':csrf,'content-type':'application/json'},body:b?JSON.stringify(b):undefined});const j=await r.json();if(!r.ok)throw Error(p+': '+j.error);return j;};
  check('agent without owner session cannot use the owner API',(await fetch(B+'/api/state')).status===401);
  const st0=await api('state');check('page gets 7 plain questions + disclosure + risk notice; TEST mode',st0.mode==='TEST'&&st0.questions.length===8&&/AI/.test(st0.riskZh),{});
  const prep=await api('prepare',{owner:owner.address,answers:{termDays:30,perPayment:'1',perDay:'2',termTotal:'3',unrecognizedPerPayment:'0.1',unrecognizedPerDay:'0.2',depositDailyLimit:'0.5',withdrawalAddress:owner.address,riskNoticeAcknowledged:true,technicalConsent:true}});
  const W=prep.wallet;check('prepare: counterfactual wallet + deposit QR + exactly 2 calls for ONE wallet_sendCalls',prep.calls.length===2&&/^<svg/.test(prep.deposit.qrSvg),{wallet:W});
  const t=async(label,f)=>{const h=await f();const r=await pub.waitForTransactionReceipt({hash:h,timeout:180000});if(r.status!=='success')throw Error(label+' reverted');return h;};
  await t('deposit',()=>ow.writeContract({address:U,abi:ERC,functionName:'transfer',args:[W,900000n],gas:120000n}));
  for(const [i,c] of prep.calls.entries())await t('call'+i,()=>ow.sendTransaction({to:c.to,data:c.data,gas:i?2500000n:700000n}));
  let st;for(let i=0;i<60;i++){st=await api('state');if(st.setup.active)break;await sleep(5000);}check('after the one signature the wallet becomes active (permission valid on chain)',st.setup.active,{balance:st.balance});
  for(let i=0;i<10&&!(st.deposits?.length);i++){await sleep(3000);st=await api('state');}
  check('deposit 0.9 over the 0.5/day limit: ledger shows source+tx, 0.4 quarantined',st.deposits?.length===1&&st.quarantined==='400000',{dep:st.deposits?.[0]?.status,q:st.quarantined});
  const ag=await api('newAgent',{name:'e2e agent'});check('Connect-your-AI: per-agent MCP URL + Cursor deep link + one-line commands',/\/mcp\/[A-Za-z0-9_-]{20,}$/.test(ag.url)&&ag.cursor.startsWith('cursor://')&&ag.claudeCode.includes('--transport http'),{});
  check('bad agent token refused',(await fetch(B+'/mcp/not-a-token',{method:'POST',headers:{'content-type':'application/json',accept:'application/json, text/event-stream'},body:'{}'})).status===401);
  mc=new Client({name:'kit-e2e',version:'1'});await mc.connect(new StreamableHTTPClientTransport(new URL(ag.url)));
  const tools=(await mc.listTools()).tools.map(x=>x.name);check('real MCP client connected over HTTP; tools listed',tools.includes('kipurse_pay')&&tools.includes('kipurse_propose_trust'),{n:tools.length});
  const call=async(name,args)=>{const r=await mc.callTool({name,arguments:args});const x=r.content?.[0]?.text??'';try{return JSON.parse(x);}catch{return {raw:x};}};
  const di=await call('kipurse_deposit_info',{});check('agent: deposit info (address, QR, warnings)',di.address===W||JSON.stringify(di).includes(W),{});
  const tag=Date.now().toString(36);const F=privateKeyToAccount(generatePrivateKey()).address,X=privateKeyToAccount(generatePrivateKey()).address;
  const p1=await call('kipurse_pay',{payment:{to:F,amount:'0.05'},merchant:'shop.test',orderRef:'a-'+tag,idempotencyKey:'k1-'+tag});await sleep(3000);
  check('agent pays an UNKNOWN payee 0.05 (<= owner cap 0.1): paid',p1.state==='paid'&&(await bal(F))===50000n,{state:p1.state,reason:p1.reason,error:p1.error});
  const p2=await call('kipurse_pay',{payment:{to:X,amount:'0.15'},merchant:'shop.test',orderRef:'b-'+tag,idempotencyKey:'k2-'+tag});
  check('unknown payee 0.15 > 0.1: refused, nothing sent',p2.state!=='paid'&&(await bal(X))===0n,{reason:p2.reason});
  const pr=await call('kipurse_propose_trust',{payee:X,reason:'e2e supplier',single:'300000',daily:'600000'});st=await api('state');
  check('agent proposes trust -> routed into the owner trust-request flow (awaiting_owner)',pr.status==='awaiting_owner',{});
  const q1=await call('kipurse_pay',{payment:{to:X,amount:'0.3'},merchant:'sup.test',orderRef:'c-'+tag,idempotencyKey:'k3-'+tag});
  await api('trust',{action:'approve',id:pr.id});
  const q2=await call('kipurse_pay',{payment:{to:X,amount:'0.3'},merchant:'sup.test',orderRef:'c-'+tag,idempotencyKey:'k4-'+tag});
  check('trusted 0.3 blocked while 0.4 is quarantined (spendable too low)',q2.state!=='paid'&&/quarantin|insufficient/.test(q2.reason??''),{before:q1.reason,reason:q2.reason});
  st=await api('state');const dep=st.deposits[0];await api('release',{id:dep.id});
  const q3=await call('kipurse_pay',{payment:{to:X,amount:'0.3'},merchant:'sup.test',orderRef:'c-'+tag,idempotencyKey:'k5-'+tag});await sleep(3000);
  check('owner one-tap approve + release quarantine -> trusted 0.3 paid',q3.state==='paid'&&(await bal(X))===300000n,{state:q3.state,reason:q3.reason,error:q3.error});
  const l1=await call('kipurse_set_limits',{changes:{unrecognizedPerPayment:'50000'}});const l2=await call('kipurse_set_limits',{changes:{unrecognizedPerPayment:'80000'}});
  st=await api('state');check('limit change: tighten immediate; loosen pending until owner approves',st.limits.unrecognizedPerPayment==='50000'&&st.pending.changes.length===1,{l1:!!l1,l2:l2?.pendingOwnerApproval?.id});
  await api('limits',{approveId:st.pending.changes[0].id});st=await api('state');check('owner approves loosen -> applied',st.limits.unrecognizedPerPayment==='80000',{});
  const wr=await call('kipurse_withdraw_request',{amount:'100000'});const we=await call('kipurse_withdraw_execute',{withdrawalId:wr.id});const ob=await bal(owner.address);
  const wa=await api('withdraw',{approveId:wr.id});await sleep(3000);
  check('withdrawal: agent request refused until owner approves; then 0.1 to the owner',we.state!=='paid'&&wa.state==='paid'&&(await bal(owner.address))-ob===100000n,{agentExec:we.reason,state:wa.state});
  const pz=await api('pause',{});const p3=await call('kipurse_pay',{payment:{to:F,amount:'0.02'},merchant:'shop.test',orderRef:'d-'+tag,idempotencyKey:'k6-'+tag});
  check('pause: AI payments stop',pz.state==='paused'&&p3.state!=='paid'&&/pause/.test(JSON.stringify(p3)),{reason:p3.reason});
  const ex=await api('exitCalls',{});const ob2=await bal(owner.address);await t('exit',()=>ow.sendTransaction({to:ex.calls[0].to,data:ex.calls[0].data,gas:1500000n}));await sleep(4000);
  check('exit: one signature takes everything back to the owner',(await bal(W))===0n&&(await bal(owner.address))>ob2,{returned:ex.returns});
}catch(e){check('run',false,{error:String(e.message).slice(0,500),log:log.slice(-600)});}
finally{try{await mc?.close();}catch{}srv.kill();}
const pass=R.filter(r=>r.ok).length;const out=`${tmpdir()}/kit-sepolia-e2e-${new Date().toISOString().replace(/[:.]/g,'')}.json`;fs.writeFileSync(out,JSON.stringify({pass,total:R.length,R},null,1));console.log(`${pass}/${R.length} passed -> ${out}`);process.exit(pass===R.length?0:1);
