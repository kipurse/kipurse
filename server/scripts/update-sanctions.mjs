// Manual refresh of the vendored OFAC SDN ETH address snapshot (run by hand; no recurring job). Review the diff, run tests, deploy.
//   node scripts/update-sanctions.mjs
import fs from 'node:fs';
const URL_LIST='https://raw.githubusercontent.com/0xB10C/ofac-sanctioned-digital-currency-addresses/lists/sanctioned_addresses_ETH.txt';
const URL_COMMIT='https://api.github.com/repos/0xB10C/ofac-sanctioned-digital-currency-addresses/commits?sha=lists&per_page=1';
const out=new URL('../src/v5/data/ofac-sdn-eth.json',import.meta.url);
const txt=await (await fetch(URL_LIST)).text();const addrs=[...new Set(txt.split(/\s+/).filter(a=>/^0x[0-9a-fA-F]{40}$/.test(a)).map(a=>a.toLowerCase()))].sort();
if(addrs.length<50)throw Error('suspiciously short list ('+addrs.length+'), not writing');
let date=new Date().toISOString().slice(0,10);try{date=(await (await fetch(URL_COMMIT)).json())[0].commit.committer.date.slice(0,10);}catch{}
const old=JSON.parse(fs.readFileSync(out,'utf8'));const removed=old.addresses.filter(a=>!addrs.includes(a));
if(removed.length)console.warn('WARNING: addresses removed upstream (review before deploying):',removed);
fs.writeFileSync(out,JSON.stringify({...old,snapshotDate:date,fetchedAt:new Date().toISOString().slice(0,10),count:addrs.length,addresses:addrs},null,0));
console.log('snapshot',date,'count',addrs.length,'added',addrs.filter(a=>!old.addresses.includes(a)).length,'removed',removed.length);
