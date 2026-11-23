// REAL Base Sepolia e2e of account deletion with a THROWAWAY test owner (testnet EOA standing in for the Base Account signature).
//   KIPURSE_ADAPTER=0x... node kit/e2e-delete-sepolia.mjs <testnet keys.json, 0600, never printed> [outFile]
// A: full path  = export ledger -> withdraw all + on-chain revoke (one owner signature) -> phrase -> ticket -> wait -> delete.
// B: skip path  = delete WITHOUT withdrawing/revoking, then recover the money with ONLY the recovery package + public chain:
//    kill switch removeOwnerAtIndex(1,SPM), revoke(permission) through wallet.execute, vault sweep, wallet.execute(USDC.transfer).
import fs from 'node:fs';import {join} from 'node:path';import {spawn} from 'node:child_process';import {mkdtempSync} from 'node:fs';import {tmpdir} from 'node:os';
import {createPublicClient,createWalletClient,http,parseAbi,encodeFunctionData,encodeAbiParameters,getAddress} from 'viem';import {privateKeyToAccount,generatePrivateKey} from 'viem/accounts';import {baseSepolia} from 'viem/chains';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
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
async function kit(port){const DIR=mkdtempSync(join(tmpdir(),'kit-del-'));const srv=spawn(process.execPath,['kit/server.mjs','--port',String(port),'--dir',DIR],{stdio:['ignore','pipe','pipe'],env:{KIPURSE_DEMO:'1',...process.env,KIPURSE_DELETE_WAIT_MS:'3000'}});
  let log='';srv.stdout.on('data',d=>log+=d);srv.stderr.on('data',d=>log+=d);const B=`http://localhost:${port}`;
  for(let i=0;i<60&&!fs.existsSync(join(DIR,'owner-link.txt'));i++)await sleep(500);const link=fs.readFileSync(join(DIR,'owner-link.txt'),'utf8').trim();
  const lg=await fetch(link,{redirect:'manual'});const cookie=lg.headers.get('set-cookie').split(';')[0];const csrf=(await (await fetch(B+'/api/csrf',{headers:{cookie}})).json()).csrf;
  const raw=(p,b)=>fetch(B+'/api/'+p,{method:b?'POST':'GET',headers:{cookie,'x-kp-csrf':csrf,'content-type':'application/json'},body:b?JSON.stringify(b):undefined});
  const api=async(p,b)=>{const r=await raw(p,b);const j=await r.json();if(!r.ok)throw Error(p+': '+j.error);return j;};return {DIR,srv,B,api,raw,log:()=>log};}
async function setupWallet(k,deposit){const prep=await k.api('prepare',{owner:owner.address,answers:{termDays:30,perPayment:'1',perDay:'2',termTotal:'3',unrecognizedPerPayment:'0.1',unrecognizedPerDay:'0.2',depositDailyLimit:'5',withdrawalAddress:owner.address,riskNoticeAcknowledged:true,technicalConsent:true}});
  await t('deposit',()=>ow.writeContract({address:U,abi:ERC,functionName:'transfer',args:[prep.wallet,deposit],gas:120000n}));
  for(const [i,c] of prep.calls.entries())await t('call'+i,()=>ow.sendTransaction({to:c.to,data:c.data,gas:i?2500000n:700000n}));
  let st;for(let i=0;i<72;i++){st=await k.api('state');if(st.setup.active)break;await sleep(5000);}if(!st.setup.active)throw Error('setup never became active');return prep.wallet;}
const mcpCall=async(url,headers)=>{const c=new Client({name:'del-e2e',version:'1'});try{await c.connect(new StreamableHTTPClientTransport(new URL(url),{requestInit:{headers}}));const n=(await c.listTools()).tools.length;await c.close();return n;}catch(e){try{await c.close();}catch{}return 'ERR '+String(e.message).slice(0,80);}};
let A,Bk;
try{
  // ---------------- A: full path ----------------
  A=await kit(18690);const W=await setupWallet(A,300000n);check('A setup: throwaway wallet active',true,{wallet:W});
  const ag=await A.api('newAgent',{name:'del e2e agent'});const n0=await mcpCall(ag.url);check('A agent connected over MCP before deletion',typeof n0==='number'&&n0>10,{tools:n0});
  const pv=await A.api('deletePreview');check('A preview: balances, meaning, phrase, agents',BigInt(pv.balances.total)>0n&&pv.meaning.length>=4&&pv.confirmPhrase==='删除我的账户'&&pv.agents===1&&pv.permissionValid===true,{total:pv.balances.total,valid:pv.permissionValid});
  const exl=await A.api('exportLedger');check('A ledger export offered (JSON with wallet + deposits)',exl.kind==='kipurse-ledger-export'&&exl.wallet===W&&Array.isArray(exl.deposits),{deposits:exl.deposits.length});
  const ob=await bal(owner.address);const ex=await A.api('exitCalls',{});await t('exit',()=>ow.sendTransaction({to:ex.calls[0].to,data:ex.calls[0].data,gas:1500000n}));await sleep(4000);
  const vaultA=(await until(()=>A.api('deletePreview'),v=>BigInt(v.balances.total)===0n)).balances;check('A 先全部取回: one owner signature -> wallet+vault 0, owner received it',BigInt(vaultA.total)===0n&&(await bal(owner.address))>ob,{returned:ex.returns});

  check('A wrong phrase refused',(await A.raw('deleteStart',{confirm:'删除'})).status===400);
  const tk=await A.api('deleteStart',{confirm:'删除我的账户'});check('A countdown enforced server-side (too early refused)',(await A.raw('deleteAccount',{ticket:tk.ticket,confirm:'删除我的账户'})).status===400);
  await sleep(3500);const del=await A.api('deleteAccount',{ticket:tk.ticket,confirm:'删除我的账户'});
  check('A deleted: keys revoked, revocation package, data wiped, logged out',del.deleted&&del.report.steps.find(s=>s.step==='revokeAgents').info.count===1&&del.report.steps.some(s=>s.step==='deleteData'&&s.ok),{steps:del.report.steps.map(s=>s.step+':'+s.ok)});
  check('A permission no longer valid on chain (revoked by the exit signature)',del.recovery.permissionValid===false,{});
  check('A old owner session -> 401 (logged out)',(await A.raw('state')).status===401);
  const n1=await mcpCall(ag.url);check('A old agent MCP URL refused',typeof n1!=='number',{r:n1});
  const files=fs.readdirSync(A.DIR);const stj=JSON.parse(fs.readFileSync(join(A.DIR,'state.json'),'utf8'));
  check('A server data gone (no ledger, no owner rules, fresh state, new executor key)',!files.includes('ledger.sqlite')&&!files.includes('owner-rules')&&!stj.setup&&Object.keys(stj.agents).length===0&&Object.keys(stj.sessions).length===0,{files});
  // ---------------- B: skip path, then self-recovery from the recovery package only ----------------
  Bk=await kit(18691);const W2=await setupWallet(Bk,250000n);check('B setup: second throwaway wallet active',true,{wallet:W2});
  const tk2=await Bk.api('deleteStart',{confirm:'删除我的账户'});await sleep(3500);const d2=await Bk.api('deleteAccount',{ticket:tk2.ticket,confirm:'删除我的账户',skippedRevoke:true});
  Bk.srv.kill();const rc=d2.recovery;check('B deleted while skipping withdraw+revoke: recovery package has wallet, permission, revoke calldata',rc.wallet===W2&&rc.permission&&rc.revoke?.data&&rc.revokeSkipped===true&&rc.permissionValid===true,{pause:d2.report.steps.find(s=>s.step==='pause')});
  // (c)/(a) kill switch: ownerAtIndex(1) is the SPM; remove it from the wallet (owner pays gas in ETH)
  const o1=await pub.readContract({address:W2,abi:CB,functionName:'ownerAtIndex',args:[1n]});const spmBytes=encodeAbiParameters([{type:'address'}],[SPM]);
  check('B ownerAtIndex(1) == SpendPermissionManager (kill switch target verified)',o1.toLowerCase()===spmBytes.toLowerCase());
  await t('kill',()=>ow.writeContract({address:W2,abi:CB,functionName:'removeOwnerAtIndex',args:[1n,spmBytes],gas:300000n}));
  // revoke via the package calldata (wallet.executeBatch built before deletion)
  await t('revoke',()=>ow.sendTransaction({to:rc.revoke.to,data:rc.revoke.data,gas:1500000n}));
  const p=rc.permission;const pv2=await until(()=>pub.readContract({address:SPM,abi:CB,functionName:'isValid',args:[{...p,allowance:BigInt(p.allowance),salt:BigInt(p.salt),period:Number(p.period),start:Number(p.start),end:Number(p.end)}]}),v=>v===false);
  check('B kill switch + revoke from the package landed; permission invalid',pv2===false);
  const vb=await until(()=>bal(rc.payerVault),v=>v===0n);const wb=await bal(W2);check('B revoke batch swept the payer vault back into the wallet',vb===0n&&wb>0n,{vault:vb.toString(),wallet:wb.toString()});
  const ob2=await bal(owner.address);await t('withdraw',()=>ow.writeContract({address:W2,abi:CB,functionName:'execute',args:[U,0n,encodeFunctionData({abi:ERC,functionName:'transfer',args:[owner.address,wb]})],gas:200000n}));
  check('B Basescan-style execute(USDC.transfer) returned everything to the owner',(await until(()=>bal(W2),v=>v===0n))===0n&&(await until(()=>bal(owner.address),v=>v-ob2===wb))-ob2===wb,{amount:wb.toString()});
}catch(e){check('run',false,{error:String(e.message).slice(0,400),logA:A?.log().slice(-300),logB:Bk?.log().slice(-300)});}
finally{A?.srv.kill();Bk?.srv.kill();}
const pass=R.filter(r=>r.ok).length;const out=process.argv[3]??`/tmp/kit-delete-e2e-${Date.now()}.json`;fs.writeFileSync(out,JSON.stringify({pass,total:R.length,R},null,1));console.log(`${pass}/${R.length} passed -> ${out}`);process.exit(pass===R.length?0:1);
