import {applyOwnerRulesConfig} from './owner-wiring.mjs';import {ownerRulesIsValid} from './owner-wiring-chain.mjs';
// SPDX-License-Identifier: AGPL-3.0-only
// V5 HTTP entry (loopback, testnet only). V5_CONFIG=<cfg> V5_KEYS=<0600 keys file> [PORT] node src/v5/http-main.mjs
import fs from 'node:fs';import {createEngineV5} from './engine.mjs';import {applyMerchantAuthConfig} from './merchant-auth.mjs';import {createV5HttpServer} from './http.mjs';
const cfg=JSON.parse(fs.readFileSync(process.env.V5_CONFIG));if(cfg.chainId!==84532)throw Error('V5 gateway mode is testnet-only until the owner migrates mainnet');
if((fs.statSync(process.env.V5_KEYS).mode&0o777)!==0o600)throw Error('keys must be 0600');cfg.executorKey=JSON.parse(fs.readFileSync(process.env.V5_KEYS)).executor;applyMerchantAuthConfig(cfg);await applyOwnerRulesConfig(cfg,{isValid:()=>ownerRulesIsValid(cfg)});
const engineV5=createEngineV5(cfg,{ledgerFile:process.env.V5_LEDGER??cfg.ledgerFile});const srv=createV5HttpServer(engineV5,{agents:cfg.agents});const port=Number(process.env.PORT??8650);
srv.listen(port,process.env.HOST??'127.0.0.1',()=>console.log(JSON.stringify({listening:`http://${process.env.HOST??'127.0.0.1'}:${port}`,version:5,chainId:cfg.chainId})));

// owner-only approval surface (separate port, owner credential; agents cannot reach its actions)
if(cfg.ownerRulesDir&&cfg.ownerSurfacePort){const {createOwnerSurface}=await import('./owner-surface.mjs');
  const os=createOwnerSurface({ownerSecret:cfg.__ownerSecret,jointTrust:cfg.jointTrust,ownerGuard:cfg.ownerGuard,engine:engineV5,loginFile:cfg.ownerRulesDir+'/owner-login-url.txt',port:Number(cfg.ownerSurfacePort)});
  await os.listen();console.log(JSON.stringify({ownerSurface:`http://localhost:${cfg.ownerSurfacePort}`,login:'one-time link in owner-login-url.txt (0600)'}));}
