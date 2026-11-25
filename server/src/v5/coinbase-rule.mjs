// SPDX-License-Identifier: AGPL-3.0-only
// t1238 (decision 108): mirror of the Base Account popup's batch check, read from keys.coinbase.com's public script on 2026-11-20
// (chunk.cd68c7e3a50d77361475.js, functions jne / Mne). Coinbase can change it at any time (decision 107): this only catches what we know.
//   - "Self calls are not allowed."             : any call to the Base Account itself
//   - "Spend permission calls are not allowed." : any top-level call to the SpendPermissionManager
//   - "Account owner or upgrade calls are not allowed." : addOwnerAddress / addOwnerPublicKey / removeOwnerAtIndex / removeLastOwner /
//      upgradeToAndCall / initialize at any depth of execute / executeBatch / executeWithoutChainIdValidation (deeper than 4 = refused)
import {decodeFunctionData,getAddress,parseAbi} from 'viem';
const CBSW=parseAbi(['function execute(address target,uint256 value,bytes data)','function executeBatch((address target,uint256 value,bytes data)[] calls)',
  'function executeWithoutChainIdValidation(bytes[] calls)','function addOwnerAddress(address owner)','function addOwnerPublicKey(bytes32 x,bytes32 y)',
  'function removeOwnerAtIndex(uint256 index,bytes owner)','function removeLastOwner(uint256 index,bytes owner)','function upgradeToAndCall(address impl,bytes data)','function initialize(bytes[] owners)']);
const BLOCKED=new Set(['addOwnerAddress','addOwnerPublicKey','removeOwnerAtIndex','removeLastOwner','upgradeToAndCall','initialize']);
function deep(d,r=0){if(!d||d==='0x')return false;if(r>4)return true;let t;try{t=decodeFunctionData({abi:CBSW,data:d});}catch{return false;}
  if(BLOCKED.has(t.functionName))return true;
  if(t.functionName==='execute')return deep(t.args[2],r+1);if(t.functionName==='executeBatch')return t.args[0].some(c=>deep(c.data,r+1));
  if(t.functionName==='executeWithoutChainIdValidation')return t.args[0].some(c=>deep(c,r+1));return false;}
/** false = passes; 'self' | 'spm' | 'owner' = what Coinbase would say no to. */
export function coinbaseRefuses(calls,from,spm){
  if(calls.some(c=>getAddress(c.to)===getAddress(from)))return 'self';
  if(calls.some(c=>getAddress(c.to)===getAddress(spm)))return 'spm';
  return calls.some(c=>deep(c.data))?'owner':false;}
