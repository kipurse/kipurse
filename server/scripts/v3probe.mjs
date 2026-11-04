import * as P256 from 'ox/P256';import {toHex} from 'viem';
const B='https://pay.kipurse.com',O='0xC14B0707634A55B3DE43811FD34C92f6f49f410b';
const k=P256.getPublicKey({privateKey:P256.randomPrivateKey()});const x=toHex(k.x,{size:32}),y=toHex(k.y,{size:32});
const j=async(p,b)=>{const r=await fetch(B+p,b?{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(b)}:{});return [r.status,await r.json().catch(()=>null)];};
const q=await j('/onboard/new/quote?owner='+O);console.log('quote',q[0],JSON.stringify(q[1]).slice(0,400));
const s=await j('/onboard/new/start',{x,y,single:'5',daily:'50',term:'500',days:90});console.log('start',s[0]);
const p=await j('/onboard/new/prepare',{id:s[1].id,owner:O});console.log('prepare',p[0],'calls',p[1]?.calls?.length,'paymaster',p[1]?.paymaster);
console.log(JSON.stringify({x,y,wallet:p[1]?.wallet,calls:p[1]?.calls}));
