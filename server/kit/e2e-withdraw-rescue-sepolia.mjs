// REAL Base Sepolia e2e of plain deposit/withdraw + the server-free rescue page logic with a THROWAWAY test owner (testnet EOA standing in for the Base Account signature).
//   KIPURSE_ADAPTER=0x... node kit/e2e-delete-sepolia.mjs <testnet keys.json, 0600, never printed> [outFile]
// A: full path  = export ledger -> withdraw all + on-chain revoke (one owner signature) -> phrase -> ticket -> wait -> delete.
// B: skip path  = delete WITHOUT withdrawing/revoking, then recover the money with ONLY the recovery package + public chain:
//    kill switch removeOwnerAtIndex(1,SPM), revoke(permission) through wallet.execute, vault sweep, wallet.execute(USDC.transfer).
import fs from 'node:fs';import {join} from 'node:path';import {spawn} from 'node:child_process';import {mkdtempSync} from 'node:fs';import {tmpdir} from 'node:os';
import {createPublicClient,createWalletClient,http,parseAbi,encodeFunctionData,encodeAbiParameters,getAddress} from 'viem';import {privateKeyToAccount,generatePrivateKey} from 'viem/accounts';import {baseSepolia} from 'viem/chains';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {parseCard,buildRescue,checkTo} from './rescue/src/plan.mjs';
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

const K=JSON.parse(fs.readFileSync(kf));const mA=privateKeyToAccount(K.merchantA);const ma=createWalletClient({chain:baseSepolia,account:mA,transport:http('https://sepolia.base.org',{retryCount:3})});
{const b=await bal(mA.address);if(b>0n)await t('top-up owner (test USDC)',()=>ma.writeContract({address:U,abi:ERC,functionName:'transfer',args:[owner.address,b],gas:120000n}));}
const k=await kit(8695);const out=process.argv[3]??`kit-withdraw-rescue-sepolia-${new Date().toISOString().replace(/[:.]/g,'')}.json`;
try{
  const W=await setupWallet(k,1300000n);check('setup active',true,{wallet:W});
  const dep=await k.api('depositOptions');check('deposit: address + only-USDC-on-Base warning + Coinbase stub on testnet',dep.address===W&&/Base/.test(dep.warning)&&dep.coinbase.stub===true,{warning:dep.warning});
  const page=await fetch(k.B+'/rescue/');const rjs=await fetch(k.B+'/rescue/rescue.js');check('rescue page served (static)',page.ok&&rjs.ok&&/取回我的钱/.test(await page.text()),{csp:page.headers.get('content-security-policy')?.slice(0,60)});
  const bad=[['bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq','比特币'],['0x1234','42 位'],['0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02912','校验'],[W,'自己的地址'],[U,'代币合约']];
  for(const [a,want] of bad){const r=await k.raw('withdrawQuote',{to:a,amount:'0.1'});const j=await r.json();check('reject bad address: '+want,!r.ok&&j.error.includes(want),{error:j.error});}
  const X=privateKeyToAccount(K.merchantB).address;const x0=await bal(X);const q=await k.api('withdrawQuote',{to:X,amount:'0.3'});
  check('quote in plain words: fee 0.1% + gas max, no ETH',q.fee==='300'&&q.gasMax==='50000'&&q.needsEth===false&&!q.problem&&/不需要 ETH/.test(q.plain),{plain:q.plain,warnings:q.warnings});
  const over=await k.api('withdrawQuote',{to:X,amount:'all'});check('全部 is capped by the per-payment cap and explained',BigInt(over.amount)<=1000000n,{amount:over.amount,maxAll:over.maxAll,everything:over.everything});
  const eth0=await pub.getBalance({address:owner.address});const b0=await bal(W);
  const r=await k.api('withdraw',{to:X,amount:'0.3'});const xb=await until(()=>bal(X),v=>v>=x0+300000n)-x0;const eth1=await pub.getBalance({address:owner.address});const b1=await until(()=>bal(W),v=>v<b0);
  check('withdraw 0.3 to a pasted new address: arrives exactly',xb===300000n,{state:r.state,tx:r.txHash,received:xb.toString()});
  check('withdraw paid gas in USDC from the wallet (owner ETH untouched)',eth1===eth0,{walletSpent:(b0-b1).toString(),ownerEthDelta:(eth1-eth0).toString()});
  const st=await k.api('state');check('new destination became the registered withdrawal address',getAddress(st.limits.withdrawalAddress)===X,{});
  const r2=await k.raw('withdraw',{to:X,amount:'5'});check('over-cap withdraw refused in plain words, nothing sent',!r2.ok&&/上限|不够/.test((await r2.json()).error),{});
  // ---- rescue page path: only the rescue card (link fragment) + public chain + the owner's signature ----
  const link=(await k.api('rescueLink')).url;const card=parseCard(link.slice(link.indexOf('#')+1));check('rescue link carries the card in the #fragment only (never sent to a server)',card&&card.wallet===W&&!!card.permission&&new URL(link).search==='',{});
  k.srv.kill();await sleep(1500);const down=await fetch(k.B+'/api/state').then(()=>false).catch(()=>true);check('Kipurse server is down for the rescue',down,{});
  const Y=mA.address;const y0=await bal(Y);check('rescue destination check',checkTo(Y,card).ok&&!checkTo(W,card).ok,{});
  const wB=await bal(W),vB=card.vault?await bal(card.vault):0n;
  const plan=buildRescue({card,owner:owner.address,to:Y,balances:{wallet:wB,vault:vB},chainId:84532});
  for(const c of plan.calls)await t('rescue',()=>ow.sendTransaction({to:c.to,data:c.data,gas:1500000n}));
  const yb=await until(()=>bal(Y),v=>v>y0)-y0;const wE=await until(()=>bal(W),v=>v===0n);
  check('rescue: ONE tap moved everything to the chosen address',yb===BigInt(plan.receive)&&wE===0n,{received:yb.toString(),labels:plan.labels});
  const valid=await until(()=>pub.readContract({address:SPM,abi:CB,functionName:'isValid',args:[{...card.permission,allowance:BigInt(card.permission.allowance),salt:BigInt(card.permission.salt),period:Number(card.permission.period),start:Number(card.permission.start),end:Number(card.permission.end)}]}),v=>v===false);
  check('rescue also stopped the AI permission',valid===false,{});
}catch(e){check('run',false,{error:String(e.message).slice(0,300)});}
finally{try{k.srv.kill();}catch{}}
const pass=R.filter(x=>x.ok).length;fs.writeFileSync(out,JSON.stringify({at:new Date().toISOString(),network:'base-sepolia',pass,total:R.length,results:R},null,1));console.log(`\n${pass}/${R.length} passed -> ${out}`);process.exit(pass===R.length?0:1);
