#!/usr/bin/env node
// Admin CLI for the Kipurse Test Shop (talks to the 0600 admin unix socket; run as root or kipurse-testshop on the server).
//   testshop-admin status
//   testshop-admin set mode=unsigned swapAddress=true neverConfirm=false badSignature=false noSignature=false
//   testshop-admin reset                      (all switches back to: mode=signed, everything else false)
//   testshop-admin orders [limit]
//   testshop-admin balances [--all]
//   testshop-admin sweep [--dry-run] [--all]  (moves USDC from deposit addresses to the configured owner wallet)
//   testshop-admin recheck <purchaseId>
import http from 'node:http';
const sock=process.env.SHOP_ADMIN_SOCKET||'/run/kipurse-testshop/admin.sock';
const call=(method,path,body)=>new Promise((ok,no)=>{const r=http.request({socketPath:sock,method,path,headers:{'content-type':'application/json'}},res=>{let d='';res.on('data',c=>d+=c);res.on('end',()=>ok({code:res.statusCode,d}));});r.on('error',no);if(body)r.write(JSON.stringify(body));r.end();});
const [cmd,...a]=process.argv.slice(2);const flag=f=>a.includes(f);
const val=v=>v==='true'?true:v==='false'?false:v;
let r;
if(cmd==='status')r=await call('GET','/admin/status');
else if(cmd==='set')r=await call('POST','/admin/switches',Object.fromEntries(a.map(x=>{const i=x.indexOf('=');return [x.slice(0,i),val(x.slice(i+1))];})));
else if(cmd==='reset')r=await call('POST','/admin/switches',{mode:'signed',swapAddress:false,neverConfirm:false,badSignature:false,noSignature:false});
else if(cmd==='orders')r=await call('GET','/admin/orders?limit='+(Number(a[0])||20));
else if(cmd==='balances')r=await call('GET','/admin/balances'+(flag('--all')?'?all=1':''));
else if(cmd==='sweep')r=await call('POST','/admin/sweep',{dryRun:flag('--dry-run'),all:flag('--all')});
else if(cmd==='recheck')r=await call('POST','/admin/recheck',{purchaseId:a[0]});
else{console.log('usage: testshop-admin status | set k=v ... | reset | orders [n] | balances [--all] | sweep [--dry-run] [--all] | recheck <purchaseId>');process.exit(2);}
try{console.log(JSON.stringify(JSON.parse(r.d),null,1));}catch{console.log(r.d);}process.exit(r.code<400?0:1);
