// Weekly (systemd timer, owner approved t629s2791): fetch the OFAC SDN ETH list and write the LIVE file the server unions with
// its vendored snapshot. Never removes an address already present (live or vendored). Free, read-only network fetch.
import fs from 'node:fs';import {LIVE_FILE,loadSnapshot} from '../src/v5/sanctions.mjs';
const URL_LIST='https://raw.githubusercontent.com/0xB10C/ofac-sanctioned-digital-currency-addresses/lists/sanctioned_addresses_ETH.txt';
const URL_COMMIT='https://api.github.com/repos/0xB10C/ofac-sanctioned-digital-currency-addresses/commits?sha=lists&per_page=1';
const out=process.argv[2]??LIVE_FILE;const txt=await (await fetch(URL_LIST)).text();
const got=[...new Set(txt.split(/\s+/).filter(a=>/^0x[0-9a-fA-F]{40}$/.test(a)).map(a=>a.toLowerCase()))];
if(got.length<50){console.error('ALERT sanctions: suspiciously short upstream list ('+got.length+'), live file unchanged');process.exit(1);}
const keep=new Set(got);for(const f of [out,new URL('../src/v5/data/ofac-sdn-eth.json',import.meta.url)])try{for(const a of loadSnapshot(f).set)keep.add(a);}catch{}
let date=new Date().toISOString().slice(0,10);try{date=(await (await fetch(URL_COMMIT,{headers:{'user-agent':'kipurse'}})).json())[0].commit.committer.date.slice(0,10);}catch{}
const addrs=[...keep].sort();const tmp=out+'.tmp';fs.writeFileSync(tmp,JSON.stringify({source:URL_LIST,snapshotDate:date,fetchedAt:new Date().toISOString(),count:addrs.length,addresses:addrs}));fs.renameSync(tmp,out);
console.log('OK sanctions live',date,'count',addrs.length);
