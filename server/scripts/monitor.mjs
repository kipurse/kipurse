// Read-only health + tamper monitor. Costs nothing, sends nothing, holds no keys.
// Run by hand (or from a scheduler the owner approves): node scripts/monitor.mjs
// Env: KIPURSE_BASE (default https://pay.kipurse.com), KIPURSE_REGISTRY (merchant registry address, optional),
//      KIPURSE_MONITOR_BLOCKS (default 43200 ≈ 1 day on Base). Exit code 1 = something needs a human.
import {createPublicClient,http,getAddress} from 'viem';import {base} from 'viem/chains';
import fs from 'node:fs';import {CBV} from '../src/v5/cb-verified.mjs';
const BASE=process.env.KIPURSE_BASE??'https://pay.kipurse.com';const alerts=[];const ok=[];
const pub=createPublicClient({chain:base,transport:http(process.env.KIPURSE_RPC??'https://mainnet.base.org')});
// end-to-end: the live server must still say the public positive-control account is verified
try{const r=await fetch(BASE+'/onboard/new/verified?owner=0x1B1b13a923b6367A523BDcD88B9b96623Ea4C606');const j=await r.json().catch(()=>({}));(r.ok&&j.verified===true?ok:alerts).push('live verify check '+r.status+' '+JSON.stringify(j).slice(0,80));}catch(e){alerts.push('live server unreachable');}
try{const c=await pub.getCode({address:CBV.indexer});(c&&c.length>2?ok:alerts).push('Coinbase attestation indexer readable');}catch{alerts.push('attestation RPC down (new sign-ups fail closed)');}
const S=JSON.parse(fs.readFileSync(new URL('../src/v5/data/ofac-sdn-eth.json',import.meta.url),'utf8'));
const age=(Date.now()-Date.parse(S.snapshotDate))/86400e3;(age>45?alerts:ok).push(`sanctions snapshot ${S.snapshotDate} (${Math.round(age)} days, ${S.count} addresses)`);
if(process.env.KIPURSE_REGISTRY){const a=getAddress(process.env.KIPURSE_REGISTRY);let done=false;
  for(const url of (process.env.KIPURSE_LOG_RPCS??'https://base-rpc.publicnode.com,https://mainnet.base.org').split(',')){try{const c=createPublicClient({chain:base,transport:http(url)});const n=await c.getBlockNumber();const from=n-BigInt(process.env.KIPURSE_MONITOR_BLOCKS??43200);
    let logs=[];for(let s=from;s<=n;s+=2000n){const e=s+1999n>n?n:s+1999n;logs=logs.concat(await c.getLogs({address:a,fromBlock:s,toBlock:e}));}
    (logs.length?alerts:ok).push(`registry ${a}: ${logs.length} change event(s) in last ${n-from} blocks`+(logs.length?' -> confirm each was made by the owner (48 h to cancel): '+logs.map(l=>l.transactionHash).join(','):''));done=true;break;}catch{}}
  if(!done)alerts.push('registry events could not be read (all RPCs refused); retry next hour');}
// live sanctions file freshness (weekly timer)
try{const L=JSON.parse(fs.readFileSync(process.env.KIPURSE_SANCTIONS_LIVE??'/opt/kipurse-main/shared/data/ofac-sdn-eth.live.json','utf8'));const a=(Date.now()-Date.parse(L.fetchedAt))/86400e3;(a>9?alerts:ok).push(`live sanctions refreshed ${Math.round(a)} day(s) ago`);}catch{ok.push('live sanctions file not readable here (checked by the sanctions timer)');}
for(const m of ok)console.log('OK   ',m);for(const m of alerts)console.log('ALERT',m);
if(process.env.KIPURSE_MONITOR_STATUS)try{fs.writeFileSync(process.env.KIPURSE_MONITOR_STATUS,JSON.stringify({at:new Date().toISOString(),ok,alerts}));}catch{}
process.exit(alerts.length?1:0);
