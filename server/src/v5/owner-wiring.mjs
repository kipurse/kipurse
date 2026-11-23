// SPDX-License-Identifier: AGPL-3.0-only
// Config wiring for the gateway-enforced owner rules. cfg.ownerRulesDir (0700) holds owner-guard state, the joint trust list, the audit
// logs and the OWNER secret (0600, separate from agent tokens). Off-chain limits activate only when cfg.permission (the one the owner
// signed) is valid on chain.
import fs from 'node:fs';import {join} from 'node:path';import {createPublicClient,http,getAddress} from 'viem';
import {createJointTrust,loadOrCreateOwnerSecret} from './joint-trust.mjs';import {createDisputes} from './disputes.mjs';import {createOwnerGuard} from './owner-guard.mjs';
import {permissionFromJson,decodePolicyV5,spendPermissionHash} from './abi.mjs';import {SPM_BASE} from './plan.mjs';
export function onchainFromPermission(cfg){const p=permissionFromJson(cfg.permission),pol=decodePolicyV5(p.extraData);
  return {single:String(pol.single),daily:String(pol.daily),term:String(pol.term),end:Number(p.end),permissionHash:spendPermissionHash(p,{chainId:cfg.chainId,manager:getAddress(cfg.manager??SPM_BASE)})};}
export async function applyOwnerRulesConfig(cfg,{isValid}={}){if(!cfg.ownerRulesDir)return cfg;const d=cfg.ownerRulesDir;fs.mkdirSync(d,{recursive:true,mode:0o700});
  const ownerSecret=loadOrCreateOwnerSecret(join(d,'owner-secret.hex'));const onchain=()=>onchainFromPermission(cfg);
  const g=createOwnerGuard({store:cfg.atRest,dir:d,ownerSecret,chainId:cfg.chainId,wallet:permissionFromJson(cfg.permission).account,onchain});
  const jt=createJointTrust({store:cfg.atRest,file:join(d,'trust-list.json'),auditFile:join(d,'trust-audit.jsonl'),caps:()=>g.capsForTrust(),ownerSecret});
  if(!g.limits()){const ok=isValid?await isValid():null;if(ok)g.activateIfSigned();}
  cfg.ownerGuard=g;cfg.jointTrust=jt;cfg.disputes=createDisputes({store:cfg.atRest,file:join(d,'disputes.json')});Object.defineProperty(cfg,'__ownerSecret',{value:ownerSecret,enumerable:false});return cfg;}
