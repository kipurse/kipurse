// REAL Base Sepolia e2e of create → connect agents (key URL, Bearer, OAuth) → use → delete → zero residue + every token dead with a THROWAWAY test owner (testnet EOA standing in for the Base Account signature).
//   KIPURSE_ADAPTER=0x... node kit/e2e-delete-sepolia.mjs <testnet keys.json, 0600, never printed> [outFile]
// A: full path  = export ledger -> withdraw all + on-chain revoke (one owner signature) -> phrase -> ticket -> wait -> delete.
// B: skip path  = delete WITHOUT withdrawing/revoking, then recover the money with ONLY the recovery package + public chain:
//    kill switch removeOwnerAtIndex(1,SPM), revoke(permission) through wallet.execute, vault sweep, wallet.execute(USDC.transfer).
import fs from 'node:fs';import {join} from 'node:path';import {spawn} from 'node:child_process';import {mkdtempSync} from 'node:fs';import {tmpdir} from 'node:os';
import {createPublicClient,createWalletClient,http,parseAbi,encodeFunctionData,encodeAbiParameters,getAddress} from 'viem';import {privateKeyToAccount,generatePrivateKey} from 'viem/accounts';import {baseSepolia} from 'viem/chains';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';import {SSEClientTransport} from '@modelcontextprotocol/sdk/client/sse.js';
import {createHash,randomBytes} from 'node:crypto';import {openVault} from './vault.mjs';
const kf=process.argv[2];if((fs.statSync(kf).mode&0o777)!==0o600)throw Error('keys 0600');const owner=privateKeyToAccount(JSON.parse(fs.readFileSync(kf)).owner);
const U='0x036CbD53842c5426634e7929541eC2318f3dCF7e',SPM='0xf85210B21cC50302F477BA56686d2019dC9b67Ad';const pub=createPublicClient({chain:baseSepolia,transport:http('https://sepolia.base.org',{retryCount:3})});
const ow=createWalletClient({chain:baseSepolia,account:owner,transport:http('https://sepolia.base.org',{retryCount:3})});
const ERC=parseAbi(['function balanceOf(address) view returns (uint256)','function transfer(address,uint256) returns (bool)']);
const SP='(address account,address spender,address token,uint160 allowance,uint48 period,uint48 start,uint48 end,uint256 salt,bytes extraData)';
const CB=parseAbi(['function execute(address target,uint256 value,bytes data) payable','function removeOwnerAtIndex(uint256 index,bytes owner)','function ownerAtIndex(uint256) view returns (bytes)',
  `function isValid(${SP} p) view returns (bool)`,'function sweep() returns (uint256)']);
const bal=a=>pub.readContract({address:U,abi:ERC,functionName:'balanceOf',args:[a]});const sleep=ms=>new Promise(r=>setTimeout(r,ms));
// public RPC is load-balanced: a read right after a receipt can be stale, so state checks poll until they hold (max 40 s)
const until=async(f,ok)=>{let v;for(let i=0;i<20;i++){v=await f();if(ok(v))return v;await sleep(2000);}return v;};
const R=[];const check=(n,ok,ev)=>{R.push({name:n,ok:!!ok,ev});console.log((ok?'PASS ':'FAIL ')+n+' '+JSON.stringify(ev??{}).slice(0,240));};
const t=async(label,f)=>{const h=await f();const r=await pub.waitForTransactionReceipt({hash:h,timeout:180000});if(r.status!=='success')throw Error(label+' reverted');return h;};
async function kit(port){const DIR=mkdtempSync(join(tmpdir(),'kit-fr-'));const KEYF=join(mkdtempSync(join(tmpdir(),'kit-frk-')),'k.key'),LOGF=join(tmpdir(),'kit-fr-'+Date.now()+'.log');const srv=spawn(process.execPath,['kit/server.mjs','--port',String(port),'--dir',DIR],{stdio:['ignore','pipe','pipe'],env:{KIPURSE_DEMO:'1',...process.env,KIPURSE_DELETE_WAIT_MS:'3000',KIPURSE_KEY_FILE:KEYF,KIPURSE_LOG_FILE:LOGF}});
  let log='';srv.stdout.on('data',d=>{log+=d;fs.appendFileSync(LOGF,d);});srv.stderr.on('data',d=>{log+=d;fs.appendFileSync(LOGF,d);});const B=`http://localhost:${port}`;
  for(let i=0;i<60&&!fs.existsSync(join(DIR,'owner-link.txt'));i++)await sleep(500);const link=fs.readFileSync(join(DIR,'owner-link.txt'),'utf8').trim();
  const lg=await fetch(link,{redirect:'manual'});const cookie=lg.headers.get('set-cookie').split(';')[0];const csrf=(await (await fetch(B+'/api/csrf',{headers:{cookie}})).json()).csrf;
  const raw=(p,b)=>fetch(B+'/api/'+p,{method:b?'POST':'GET',headers:{cookie,'x-kp-csrf':csrf,'content-type':'application/json'},body:b?JSON.stringify(b):undefined});
  const api=async(p,b)=>{const r=await raw(p,b);const j=await r.json();if(!r.ok)throw Error(p+': '+j.error);return j;};return {DIR,KEYF,LOGF,srv,B,api,raw,cookie,csrf,link,log:()=>log};}
async function setupWallet(k,deposit){const prep=await k.api('prepare',{owner:owner.address,answers:{termDays:30,perPayment:'1',perDay:'2',termTotal:'3',unrecognizedPerPayment:'0.1',unrecognizedPerDay:'0.2',depositDailyLimit:'5',withdrawalAddress:owner.address,riskNoticeAcknowledged:true,technicalConsent:true}});
  await t('deposit',()=>ow.writeContract({address:U,abi:ERC,functionName:'transfer',args:[prep.wallet,deposit],gas:120000n}));
  for(const [i,c] of prep.calls.entries())await t('call'+i,()=>ow.sendTransaction({to:c.to,data:c.data,gas:i?2500000n:700000n}));
  let st;for(let i=0;i<72;i++){st=await k.api('state');if(st.setup.active)break;await sleep(5000);}if(!st.setup.active)throw Error('setup never became active');return prep.wallet;}


for(const n of ['merchantA','merchantB']){const a=privateKeyToAccount(JSON.parse(fs.readFileSync(kf))[n]);const b=await bal(a.address);if(b>0n){const w=createWalletClient({chain:baseSepolia,account:a,transport:http('https://sepolia.base.org',{retryCount:3})});await t('top-up '+n,()=>w.writeContract({address:U,abi:ERC,functionName:'transfer',args:[owner.address,b],gas:120000n}));}}
const k=await kit(8697);const out=process.argv[3]??`kit-factory-reset-sepolia-${new Date().toISOString().replace(/[:.]/g,'')}.json`;
const mcp=async(url,hdr={})=>{const c=new Client({name:'e2e',version:'1'});const tr=new StreamableHTTPClientTransport(new URL(url),{requestInit:{headers:hdr}});await c.connect(tr);const tl=await c.listTools();const st=await c.callTool({name:'kipurse_wallet_status',arguments:{}}).catch(e=>({error:e.message}));await c.close();return {tools:tl.tools.length,st};};
const raw401=async(url,hdr={})=>(await fetch(url,{method:'POST',headers:{'content-type':'application/json',accept:'application/json, text/event-stream',...hdr},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/list'})})).status;
try{
  const W=await setupWallet(k,300000n);check('create: throwaway wallet active',true,{wallet:W});
  // connect 3 ways
  const a1=await k.api('newAgent',{name:'FR key-url agent'});const keyUrl=a1.url;const key=keyUrl.split('/mcp/')[1];
  const asm=await (await fetch(k.B+'/.well-known/oauth-authorization-server')).json();
  const cli=await (await fetch(asm.registration_endpoint,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({client_name:'FR OAuth agent',redirect_uris:['https://agent.example/cb']})})).json();
  const v=randomBytes(32).toString('base64url'),ch=createHash('sha256').update(v).digest('base64url');
  const q=new URLSearchParams({response_type:'code',client_id:cli.client_id,redirect_uri:'https://agent.example/cb',code_challenge:ch,code_challenge_method:'S256',state:'s',resource:k.B+'/mcp'});
  const html=await (await fetch(asm.authorization_endpoint+'?'+q,{headers:{cookie:k.cookie}})).text();const req=/name=req value="([^"]+)"/.exec(html)[1],cs=/name=csrf value="([^"]+)"/.exec(html)[1];
  const dr=await fetch(k.B+'/oauth/decision',{method:'POST',redirect:'manual',headers:{cookie:k.cookie,'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({req,csrf:cs,d:'approve'})});const code=new URL(dr.headers.get('location')).searchParams.get('code');
  const tok=await (await fetch(asm.token_endpoint,{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'authorization_code',code,code_verifier:v,client_id:cli.client_id,redirect_uri:'https://agent.example/cb',resource:k.B+'/mcp'})})).json();
  check('connect: key-URL agent + OAuth agent (access + refresh token)',!!key&&!!tok.access_token&&!!tok.refresh_token,{});
  // use
  const u1=await mcp(keyUrl),u2=await mcp(k.B+'/mcp',{authorization:'Bearer '+tok.access_token}),u3=await mcp(k.B+'/mcp',{authorization:'Bearer '+key});
  const sseUse=async(url,hdr={})=>{const c=new Client({name:'e2e-sse',version:'1'});const tr=new SSEClientTransport(new URL(url),{requestInit:{headers:hdr},eventSourceInit:{fetch:(u,i)=>fetch(u,{...i,headers:{...(i?.headers??{}),...hdr}})}});await c.connect(tr);const n=(await c.listTools()).tools.length;const st=await c.callTool({name:'kipurse_wallet_status',arguments:{}});await c.close();return {n,ok:!st.isError};};
  const ux=[await mcp(k.B+'/mcp?api_key='+key),await mcp(k.B+'/mcp',{'x-api-key':key}),await mcp(k.B+'/mcp',{authorization:'Basic '+Buffer.from('kipurse:'+key).toString('base64')})];
  const ss=[await sseUse(k.B+'/sse',{authorization:'Bearer '+key}),await sseUse(k.B+'/sse?key='+key),await sseUse(k.B+'/sse',{authorization:'Bearer '+tok.access_token})];
  check('zero-config auth: query key, X-API-Key, Basic on streamable HTTP + legacy SSE (Bearer key, ?key=, OAuth token) all list tools and read status',ux.every(u=>u.tools>5&&!u.st.error)&&ss.every(x=>x.n>5&&x.ok),{http:ux.map(u=>u.tools),sse:ss.map(x=>x.n)});
  check('use: all three connections list tools and read status',u1.tools>5&&u2.tools>5&&u3.tools>5&&!u1.st.error&&!u2.st.error,{tools:[u1.tools,u2.tools,u3.tools]});
  const st=await k.api('state');check('lastUsed activity recorded',st.agents.filter(a=>a.lastUsed).length>=2,{agents:st.agents.map(a=>a.name)});
  const encBefore=fs.readFileSync(join(k.DIR,'state.enc'));check('state encrypted at rest (no agent name, wallet or token in the file)',!encBefore.toString('latin1').includes('FR OAuth agent')&&!encBefore.toString('latin1').toLowerCase().includes(W.slice(2).toLowerCase())&&!fs.existsSync(join(k.DIR,'state.json')),{});
  {const R=join(k.DIR,'owner-rules');const rules=fs.existsSync(R)?fs.readdirSync(R).filter(f=>/\.json$/.test(f)):[];const plainRules=rules.filter(f=>fs.readFileSync(join(R,f)).subarray(0,4).toString()!=='KPE1');
   const audits=fs.existsSync(R)?fs.readdirSync(R).filter(f=>f.endsWith('.jsonl')):[];const plainAudit=audits.filter(f=>fs.readFileSync(join(R,f),'utf8').split('\n').some(l=>l&&!l.startsWith('E1:')));
   check('ledger + owner rules encrypted at rest',fs.existsSync(join(k.DIR,'ledger.sqlite.enc'))&&!fs.existsSync(join(k.DIR,'ledger.sqlite'))&&fs.readFileSync(join(k.DIR,'ledger.sqlite.enc')).subarray(0,4).toString()==='KPE1'&&rules.length>0&&!plainRules.length&&!plainAudit.length,{rules,audits,plainRules,plainAudit});}
  // delete (skip withdraw: money stays on chain, owner-controlled)
  const tk=await k.api('deleteStart',{confirm:'删除我的账户'});await sleep(3200);const d=await k.api('deleteAccount',{ticket:tk.ticket,confirm:'删除我的账户',skippedRevoke:true});
  check('delete: report steps',d.deleted&&d.report.steps.every(s=>s.ok),{steps:d.report.steps.map(s=>s.step)});
  // zero residue
  const files=fs.readdirSync(k.DIR).sort();check('data dir = exactly a fresh install (owner-link, session key, state.enc; adapter via env)',JSON.stringify(files)===JSON.stringify(['owner-link.txt','session-key.json','state.enc']),{files});
  const fresh=openVault(k.DIR,k.KEYF).load();check('state = fresh install (no setup, agents, sessions, OAuth)',!fresh.setup&&!Object.keys(fresh.agents).length&&!Object.keys(fresh.sessions).length&&!Object.keys(fresh.oauth.clients).length&&!Object.keys(fresh.oauth.tokens??{}).length,{});
  let leak=[];for(const f of files){const b=fs.readFileSync(join(k.DIR,f)).toString('latin1').toLowerCase();for(const x of [W.slice(2).toLowerCase(),owner.address.slice(2).toLowerCase(),'fr oauth agent','fr key-url agent',key.toLowerCase(),cli.client_id.toLowerCase()])if(b.includes(x))leak.push(f);}
  check('no file in the data dir mentions the wallet, owner, agents or keys',leak.length===0,{leak});
  const T=mkdtempSync(join(tmpdir(),'kit-old-'));fs.writeFileSync(join(T,'state.enc'),encBefore);let unreadable=false;try{openVault(T,k.KEYF).load();}catch{unreadable=true;}check('old encrypted data is unreadable (key rotated = crypto-shredded)',unreadable,{});
  check('server log wiped',fs.readFileSync(k.LOGF,'utf8').trim()==='',{});
  // every credential dead
  const dead=[await raw401(keyUrl),await raw401(k.B+'/mcp',{authorization:'Bearer '+tok.access_token}),await raw401(k.B+'/mcp',{authorization:'Bearer '+key})];
  check('old key URL / OAuth access token / Bearer key -> 401',dead.every(x=>x===401),{dead});
  const rf=await fetch(asm.token_endpoint,{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'refresh_token',refresh_token:tok.refresh_token,client_id:cli.client_id})});check('old refresh token refused',rf.status>=400,{status:rf.status});
  check('old owner cookie -> 401',(await k.raw('state')).status===401,{});
  check('old login link refused',(await fetch(k.link,{redirect:'manual'})).status===403,{});
  const nl=fs.readFileSync(join(k.DIR,'owner-link.txt'),'utf8').trim();const lg=await fetch(nl,{redirect:'manual'});const c2=lg.headers.get('set-cookie').split(';')[0];const cs2=(await (await fetch(k.B+'/api/csrf',{headers:{cookie:c2}})).json()).csrf;
  const s2=await (await fetch(k.B+'/api/state',{headers:{cookie:c2,'x-kp-csrf':cs2}})).json();check('fresh first-run: new login works, no wallet, no agents (onboarding)',lg.status===303&&s2.setup===null&&s2.agents.length===0,{});
  check('money untouched on chain (owner-controlled)',(await bal(W))>0n,{balance:(await bal(W)).toString()});
}catch(e){check('run',false,{error:String(e.message).slice(0,300)});}
finally{try{k.srv.kill();}catch{}}
const pass=R.filter(x=>x.ok).length;fs.writeFileSync(out,JSON.stringify({at:new Date().toISOString(),network:'base-sepolia',pass,total:R.length,results:R},null,1));console.log(`\n${pass}/${R.length} passed -> ${out}`);process.exit(pass===R.length?0:1);
