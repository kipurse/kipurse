#!/usr/bin/env node
// Kipurse Test Shop service. Public HTTP on 127.0.0.1:8661 (reached through the Cloudflare tunnel), admin API on a 0600 unix socket.
import http from 'node:http';import fs from 'node:fs';import {join} from 'node:path';
import {readDataKey,loadOrCreateSeed,shopKeys} from '../src/keys.mjs';import {makePublicClient,chainReader} from '../src/chain.mjs';
import {createShop} from '../src/shop.mjs';import {bundlerRpc} from '../src/sweep.mjs';
const E=process.env;const env=(k,d)=>E[k]!==undefined&&E[k]!==''?E[k]:d;
const cfg={origin:env('SHOP_ORIGIN','http://127.0.0.1:8661'),host:env('SHOP_HOST','127.0.0.1'),port:Number(env('SHOP_PORT','8661')),
  stateDir:env('SHOP_STATE_DIR','/var/lib/kipurse-testshop'),dataKeyFile:env('SHOP_DATA_KEY_FILE','/etc/kipurse-testshop/data.key'),
  adminSocket:env('SHOP_ADMIN_SOCKET','/run/kipurse-testshop/admin.sock'),rpc:env('SHOP_RPC','https://base-rpc.publicnode.com,https://mainnet.base.org'),
  bundler:env('SHOP_BUNDLER_URL','https://public.pimlico.io/v2/8453/rpc'),sweepTo:env('SHOP_SWEEP_TO',''),   // no default: set your OWN wallet, or sweeping stays off
  autoSweep:env('SHOP_AUTO_SWEEP','1')==='1',autoMin:BigInt(env('SHOP_AUTO_SWEEP_MIN_ATOMIC','300000')),tickMs:Number(env('SHOP_TICK_MS','15000')),
  autoSweepEveryMs:Number(env('SHOP_AUTO_SWEEP_CHECK_MS','3600000'))};
if(!['127.0.0.1','::1','localhost'].includes(cfg.host))throw Error('SHOP_HOST must be a loopback address');
const log=(event,data={})=>{try{process.stdout.write(JSON.stringify({t:new Date().toISOString(),event,...data},(k,v)=>typeof v==='bigint'?v.toString():v)+'\n');}catch{}};
fs.mkdirSync(cfg.stateDir,{recursive:true,mode:0o700});
const keys=shopKeys(loadOrCreateSeed(join(cfg.stateDir,'seed.enc'),readDataKey(cfg.dataKeyFile)));
const pub=makePublicClient(cfg.rpc);
const shop=createShop({stateFile:join(cfg.stateDir,'state.json'),keys,origin:cfg.origin,chain:chainReader(pub),log,
  sweep:{to:cfg.sweepTo,rpc:bundlerRpc(cfg.bundler),pub,auto:cfg.autoSweep,autoMinAtomic:cfg.autoMin}});
const srv=http.createServer({requestTimeout:15000,headersTimeout:10000,maxHeaderSize:8192},shop.publicHandler);srv.keepAliveTimeout=5000;
srv.listen(cfg.port,cfg.host,()=>log('listening',{host:cfg.host,port:cfg.port,origin:cfg.origin,signer:shop.signer,autoSweep:cfg.autoSweep,sweepTo:cfg.sweepTo}));
try{fs.unlinkSync(cfg.adminSocket);}catch{}
const adm=http.createServer({requestTimeout:600000},shop.adminHandler);const um=process.umask(0o177);
adm.listen(cfg.adminSocket,()=>{process.umask(um);try{fs.chmodSync(cfg.adminSocket,0o600);}catch{}log('admin_listening',{socket:cfg.adminSocket});});
let busy=false;const tick=async()=>{if(busy)return;busy=true;try{await shop.tick();}catch(e){log('tick_failed',{error:String(e?.message??e).slice(0,120)});}finally{busy=false;}};
setInterval(tick,cfg.tickMs).unref();
setInterval(()=>{shop.autoSweepCheck().then(r=>{if(r.ran||r.reason==='below_threshold')log('auto_sweep_check',{ran:r.ran,reason:r.reason??null,total:r.total??null});}).catch(e=>log('auto_sweep_failed',{error:String(e?.message??e).slice(0,160)}));},cfg.autoSweepEveryMs).unref();
const stop=()=>{log('stopping');srv.close();adm.close();setTimeout(()=>process.exit(0),500).unref();};process.on('SIGTERM',stop);process.on('SIGINT',stop);
