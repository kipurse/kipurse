// SANCTIONS SCREENING (t595 item 4). Blocks payments, trust entries and withdrawal destinations to OFAC SDN-listed crypto
// addresses. Sources: (1) vendored OFAC SDN snapshot (data/ofac-sdn-eth.json; refresh by hand with scripts/update-sanctions.mjs,
// no recurring job); (2) optional read-only Chainalysis sanctions oracle on Base (deprecated by Chainalysis, last update
// 2026-03-18; used only as an extra "yes"). Listed by either -> blocked. Oracle errors never unblock and never block by themselves.
import fs from 'node:fs';import {fileURLToPath} from 'node:url';
export const CHAINALYSIS_ORACLE={8453:'0x3A91A31cB3dC49b4db9Ce721F50a9D076c8D739B'};
const ORACLE_ABI=[{type:'function',name:'isSanctioned',stateMutability:'view',inputs:[{name:'addr',type:'address'}],outputs:[{type:'bool'}]}];
const DEFAULT_FILE=fileURLToPath(new URL('./data/ofac-sdn-eth.json',import.meta.url));
let SNAP=null;
export function loadSnapshot(file=DEFAULT_FILE){const j=JSON.parse(fs.readFileSync(file,'utf8'));return {date:j.snapshotDate,count:j.addresses.length,set:new Set(j.addresses.map(a=>String(a).toLowerCase()))};}
export const SANCTIONS_SAY={zh:'这个地址在美国财政部 OFAC 制裁名单上，法律禁止向它付款或转账。钱没有动。',en:'This address is on the US Treasury OFAC sanctions list. Payments and transfers to it are prohibited. No money moved.'};
/* t629: weekly refreshed list (systemd timer, owner approved) in a LIVE file. Union only: the live file can add blocks, never remove
   one from the vendored snapshot, so a bad or tampered update cannot unblock anybody. Re-read when its mtime changes (checked <= every 60 s). */
export const LIVE_FILE=process.env.KIPURSE_SANCTIONS_LIVE??'/opt/kipurse-main/shared/data/ofac-sdn-eth.live.json';
export function liveReader(file=LIVE_FILE,{now=()=>Date.now()}={}){let m=-1,at=0,cur={date:null,set:new Set()};
  return ()=>{const t=now();if(t-at<60e3)return cur;at=t;try{const st=fs.statSync(file);if(st.mtimeMs!==m){const s=loadSnapshot(file);if(s.count>=50){cur=s;m=st.mtimeMs;}}}catch{}return cur;};}
export function createSanctions({file,pub,chainId=8453,oracle=CHAINALYSIS_ORACLE[chainId],oracleTimeoutMs=3000,extra=[],live=liveReader()}={}){
  const snap=file?loadSnapshot(file):(SNAP??=loadSnapshot());const ex=new Set(extra.map(a=>String(a).toLowerCase()));
  const cache=new Map();
  async function onOracle(a){if(!pub||!oracle)return null;const k=a.toLowerCase();const c=cache.get(k);if(c&&Date.now()-c.at<600e3)return c.v;
    try{const v=await Promise.race([pub.readContract({address:oracle,abi:ORACLE_ABI,functionName:'isSanctioned',args:[a]}),new Promise((_,r)=>setTimeout(()=>r(Error('timeout')),oracleTimeoutMs))]);
      const b=v===true;cache.set(k,{v:b,at:Date.now()});return b;}catch{return null;}}
  /** -> null (not listed) or {code:'SANCTIONED_ADDRESS', address, source, say_zh, say_en} */
  async function check(address){const a=String(address??'');if(!/^0x[0-9a-fA-F]{40}$/.test(a))return null;const l=a.toLowerCase();
    if(snap.set.has(l)||ex.has(l))return hit(a,'ofac_sdn_snapshot_'+snap.date);
    {const L=live?.();if(L?.set?.has(l))return hit(a,'ofac_sdn_live_'+L.date);}
    if(await onOracle(a)===true)return hit(a,'chainalysis_oracle_base');return null;}
  const hit=(a,source)=>({code:'SANCTIONED_ADDRESS',address:a,source,say_zh:SANCTIONS_SAY.zh,say_en:SANCTIONS_SAY.en});
  async function checkAll(list){for(const a of list??[]){const h=await check(a);if(h)return h;}return null;}
  return {check,checkAll,info:()=>({snapshotDate:snap.date,count:snap.count,liveDate:live?.()?.date??null,oracle:oracle??null})};
}
