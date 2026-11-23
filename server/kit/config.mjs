// SPDX-License-Identifier: AGPL-3.0-only
// Kit network config. Nothing deployment-specific is hardcoded: the Kipurse adapter (your deployment) comes from
// KIPURSE_ADAPTER or a JSON file (KIPURSE_CONFIG, else <data dir>/config.json). Public Base Sepolia infrastructure
// (Circle test USDC, Coinbase SpendPermissionManager, Coinbase Smart Wallet factory) has defaults that env/config may override.
import fs from 'node:fs';import {join} from 'node:path';import {getAddress} from 'viem';
export const SEPOLIA_DEFAULTS={chainId:84532,hex:'0x14a34',rpc:'https://sepolia.base.org',usdc:'0x036CbD53842c5426634e7929541eC2318f3dCF7e',
  spm:'0xf85210B21cC50302F477BA56686d2019dC9b67Ad',factory:'0x0BA5ED0c6AA8c49038F819E587E2633c4A9F428a',explorer:'https://sepolia.basescan.org'};
const ENV={rpc:'KIPURSE_RPC',usdc:'KIPURSE_USDC',spm:'KIPURSE_SPM',factory:'KIPURSE_FACTORY',adapter:'KIPURSE_ADAPTER',explorer:'KIPURSE_EXPLORER'};
export function loadKitConfig(dir,env=process.env){
  const file=env.KIPURSE_CONFIG||join(dir,'config.json');let f={};
  if(fs.existsSync(file))f=JSON.parse(fs.readFileSync(file,'utf8'));
  const c={...SEPOLIA_DEFAULTS};for(const [k,e] of Object.entries(ENV)){const v=env[e]??f[k];if(v)c[k]=String(v);}
  if(!c.adapter)throw Error(`KIPURSE_ADAPTER is not set: put the Kipurse V5 adapter address in ${file} ({"adapter":"0x..."}) or the KIPURSE_ADAPTER env var (see .env.example)`);
  for(const k of ['usdc','spm','factory','adapter'])c[k]=getAddress(c[k]);
  if(Number(f.chainId??84532)!==84532)throw Error('the kit runs on Base Sepolia only (test mode)');
  return c;}
