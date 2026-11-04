// SPDX-License-Identifier: AGPL-3.0-only
// BALANCE LEDGER (read-only): every USDC balance change of the agent wallet and its fee vault, straight from on-chain Transfer logs.
// One row per (tx, account) with signed delta, short Chinese reason and the resulting balance. Opening balance = current - sum(deltas),
// so no archive reads are needed. Scans incrementally and caches to a JSON file; never sends anything.
import fs from 'node:fs';import {parseAbiItem,getAddress} from 'viem';
const T=parseAbiItem('event Transfer(address indexed from,address indexed to,uint256 value)');
const lc=a=>String(a).toLowerCase();const usd=a=>{const n=BigInt(a),s=n<0n?'-':'',m=n<0n?-n:n,w=m/1000000n,f=(m%1000000n).toString().padStart(6,'0').replace(/0+$/,'');return s+(f?`${w}.${f}`:`${w}`);};
/** transfers: [{tx,block,t,li,from,to,value(bigint)}] -> rows (oldest first) for wallet + vault. names: {lowercase addr: 'label'}. */
export function classify(transfers,{wallet,vault,paymasters=[],names={},owner=null,ownerPaymasters=[]}){const W=lc(wallet),V=lc(vault),PM=new Set(paymasters.map(lc)),O=owner?lc(owner):null,OPM=new Set(ownerPaymasters.map(lc));const by=new Map();
  for(const x of [...transfers].sort((a,b)=>a.block-b.block||a.li-b.li)){if(!by.has(x.tx))by.set(x.tx,[]);by.get(x.tx).push(x);}
  const rows=[];const nm=a=>names[lc(a)]??(lc(a).slice(0,6)+'…'+lc(a).slice(-4));
  for(const [tx,xs] of by){const t=xs[0].t,block=xs[0].block;const d=acc=>xs.reduce((s,x)=>s+(lc(x.to)===acc?x.value:0n)-(lc(x.from)===acc?x.value:0n),0n);
    const wd=d(W),vd=d(V);const payee=xs.filter(x=>lc(x.from)===V&&!PM.has(lc(x.to))&&lc(x.to)!==W);const paid=payee.reduce((s,x)=>s+x.value,0n);
    const pmNet=xs.reduce((s,x)=>s+(lc(x.from)===V&&PM.has(lc(x.to))?x.value:0n)-(lc(x.to)===V&&PM.has(lc(x.from))?x.value:0n),0n);
    if(wd!==0n){let kind,zh;
      if(wd>0n){kind='deposit';const src=xs.find(x=>lc(x.to)===W);zh=`充值（来自 ${nm(src.from)}）`;}
      else if(paid>0n){kind='payment';const over=-wd-paid;zh=`AI 付款 ${usd(paid)} 给 ${nm(payee[0].to)}`+(over>0n?`（含手续费和手续费 ${usd(over)}）`:'');}
      else{const dst=xs.find(x=>lc(x.from)===W);kind='withdraw';zh=`转出到 ${nm(dst.to)}`;}
      rows.push({tx,block,t,account:'wallet',kind,delta:wd.toString(),zh,detail:paid>0n?{paid:paid.toString(),overhead:(-wd-paid).toString()}:undefined});}
    if(O){const fee=xs.filter(x=>lc(x.from)===O&&OPM.has(lc(x.to))).reduce((a,x)=>a+x.value,0n);if(fee>0n)rows.push({tx,block,t,account:'owner',kind:'ownerfee',delta:(-fee).toString(),zh:'确认手续费 · 你的 Base Account'});}
    if(vd!==0n){let kind,zh;
      if(paid>0n&&wd<0n){kind='settle';zh=`备用金：收回本笔费用 ${usd(-wd-paid+0n)}，付手续费 ${usd(pmNet)}`;}
      else if(pmNet!==0n&&xs.every(x=>[lc(x.from),lc(x.to)].some(a=>a===V||PM.has(a)))){kind='gas';zh='备用金：付手续费（钱包操作）';}
      else if(vd>0n){kind='topup';zh='备用金充值';}else{kind='vault-out';zh='备用金转出';}
      rows.push({tx,block,t,account:'vault',kind,delta:vd.toString(),zh});}}
  return rows;}
/** Adds `balance` after each row, walking back from the current balances. */
export function withBalances(rows,current){const bal={wallet:BigInt(current.wallet),vault:BigInt(current.vault)};const out=rows.map(r=>({...r}));
  for(let i=out.length-1;i>=0;i--){const r=out[i];if(!(r.account in bal)){r.balance=null;continue;}r.balance=bal[r.account].toString();bal[r.account]-=BigInt(r.delta);}
  return {rows:out,opening:{wallet:bal.wallet.toString(),vault:bal.vault.toString()}};}
/** Incremental scanner. pub: viem public client. Adapts the log range to what the RPC allows. */
export function createLedger({pub,token,wallet,vault,paymasters,names,owner=null,ownerPaymasters=[],fromBlock,file,minIntervalMs=30000,now=()=>Date.now()}){
  let cache={next:Number(fromBlock),transfers:[]};try{const j=JSON.parse(fs.readFileSync(file,'utf8'));if(j.wallet===lc(wallet)&&j.from===Number(fromBlock)&&(j.owner??null)===(owner?lc(owner):null))cache=j;}catch{}
  cache.transfers=(cache.transfers??[]).map(x=>({...x,value:BigInt(x.value)}));let last=0,busy=null,span=2000n;const tcache=new Map();
  const save=()=>{try{fs.writeFileSync(file+'.tmp',JSON.stringify({...cache,wallet:lc(wallet),owner:owner?lc(owner):null,from:Number(fromBlock),transfers:cache.transfers.map(x=>({...x,value:x.value.toString()}))}));fs.renameSync(file+'.tmp',file);}catch{}};
  async function scan(){const head=Number(await pub.getBlockNumber());const A=[getAddress(wallet),getAddress(vault),...(owner?[getAddress(owner)]:[])];
    while(cache.next<=head){const to=Math.min(head,cache.next+Number(span)-1);let logs=[];
      try{for(const side of ['from','to'])logs.push(...await pub.getLogs({address:token,event:T,args:{[side]:A},fromBlock:BigInt(cache.next),toBlock:BigInt(to)}));}
      catch(e){if(span>50n){span/=2n;continue;}throw e;}
      const seen=new Set(cache.transfers.map(x=>x.tx+':'+x.li));
      for(const l of logs){const k=l.transactionHash+':'+l.logIndex;if(seen.has(k))continue;seen.add(k);const bn=Number(l.blockNumber);
        if(!tcache.has(bn))tcache.set(bn,Number((await pub.getBlock({blockNumber:l.blockNumber})).timestamp));
        cache.transfers.push({tx:l.transactionHash,block:bn,t:tcache.get(bn),li:l.logIndex,from:l.args.from,to:l.args.to,value:l.args.value});}
      cache.next=to+1;}
    save();}
  async function refresh(){if(now()-last<minIntervalMs)return;if(busy)return busy;busy=scan().then(()=>{last=now();}).finally(()=>{busy=null;});return busy;}
  /** Rows newest first, with balances; current = {wallet,vault} atomic balances right now. */
  function view(current,{limit=200}={}){const {rows,opening}=withBalances(classify(cache.transfers,{wallet,vault,paymasters,names,owner,ownerPaymasters}),current);return {rows:rows.reverse().slice(0,limit),opening,fromBlock:Number(fromBlock),scannedTo:cache.next-1};}
  // delete-everything: drop the local cache (it only mirrors public on-chain transfers and is rebuilt from the chain on demand).
  function forget(){cache={next:Number(fromBlock),transfers:[]};try{fs.rmSync(file,{force:true});fs.rmSync(file+'.tmp',{force:true});}catch{}}
  return {refresh,view,forget};}
