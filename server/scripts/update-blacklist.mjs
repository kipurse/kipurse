// Manual update of the scam-address blacklist from PUBLIC lists (no key). Run by hand / at deploy, never on a timer:
//   node scripts/update-blacklist.mjs <outFile>   (the engine merges <outFile> = cfg.blacklistFile with the bundled list)
import {writeFileSync} from 'node:fs';
const out=process.argv[2]??new URL('../src/v5/data/scam-blacklist.json',import.meta.url).pathname;const A={};
const ss=await (await fetch('https://raw.githubusercontent.com/scamsniffer/scam-database/main/blacklist/address.json')).json();for(const a of ss)if(/^0x[0-9a-fA-F]{40}$/.test(String(a).trim()))A[String(a).trim().toLowerCase()]='scamsniffer';
const mew=await (await fetch('https://raw.githubusercontent.com/MyEtherWallet/ethereum-lists/master/src/addresses/addresses-darklist.json')).json();for(const e of mew){const a=String(e?.address??'').trim().toLowerCase();if(/^0x[0-9a-f]{40}$/.test(a))A[a]??='mew-darklist';}
writeFileSync(out,JSON.stringify({updated:new Date().toISOString().slice(0,10),sources:{scamsniffer:'https://github.com/scamsniffer/scam-database (GPL-3.0)','mew-darklist':'https://github.com/MyEtherWallet/ethereum-lists (MIT)'},addresses:A}));
console.log('blacklist',Object.keys(A).length,'->',out);
