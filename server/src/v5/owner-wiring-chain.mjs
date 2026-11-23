// SPDX-License-Identifier: AGPL-3.0-only
import {createPublicClient,http,getAddress,parseAbi} from 'viem';import {permissionFromJson} from './abi.mjs';import {SPM_BASE} from './plan.mjs';
const SP='(address account,address spender,address token,uint160 allowance,uint48 period,uint48 start,uint48 end,uint256 salt,bytes extraData)';
export async function ownerRulesIsValid(cfg){try{const pub=createPublicClient({transport:(await import('./rpc.mjs')).rpcTransport(cfg.rpc)});
  return await pub.readContract({address:getAddress(cfg.manager??SPM_BASE),abi:parseAbi([`function isValid(${SP} p) view returns (bool)`]),functionName:'isValid',args:[permissionFromJson(cfg.permission)]});}catch{return false;}}
