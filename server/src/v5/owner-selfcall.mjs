// t1238 (decision 106, owner 2026-11-20 ~09:40 CT "[zh]"): keys.coinbase.com refuses any TOP-LEVEL call that carries a
// Coinbase Smart Wallet owner/upgrade selector ("Account owner or upgrade calls are not allowed."). Every owner change we put in a
// Base Account batch is therefore a wallet self-call: wallet.execute(wallet, 0, addOwnerAddress/removeOwnerAtIndex(...)). CBSW's
// onlyOwner accepts msg.sender == the wallet itself, so the on-chain effect is identical. This module is the single source of truth.
import {encodeFunctionData,getAddress,parseAbi,toFunctionSelector} from 'viem';
export const OWNER_SELECTOR_NAMES=['function addOwnerAddress(address)','function addOwnerPublicKey(bytes32,bytes32)','function addOwnerAddressAtIndex(address,uint256)','function addOwnerPublicKeyAtIndex(bytes32,bytes32,uint256)',
  'function removeOwnerAtIndex(uint256,bytes)','function removeLastOwner(uint256,bytes)','function upgradeToAndCall(address,bytes)','function upgradeTo(address)','function executeWithoutChainIdValidation(bytes[])','function initialize(bytes[])'];
const SEL=new Set(OWNER_SELECTOR_NAMES.map(n=>toFunctionSelector(n)));
const EXEC=parseAbi(['function execute(address target, uint256 value, bytes data)']);
/** Indices of calls whose top-level selector is an owner/upgrade function (must be empty for anything we hand to the Base Account). */
export function ownerUpgradeTopLevel(calls){return (calls??[]).map((c,i)=>[i,String(c?.data??'0x').slice(0,10).toLowerCase()]).filter(([,s])=>SEL.has(s)).map(([i])=>i);}
/** wallet.execute(wallet, 0, data): the only shape an owner change may take in a Base Account batch. */
export function selfCall(wallet,data,label){const W=getAddress(wallet);const c={to:W,value:'0x0',data:encodeFunctionData({abi:EXEC,functionName:'execute',args:[W,0n,data]})};return label?{...c,label}:c;}
/** Throws owner_call_top_level if a batch still carries a top-level owner/upgrade call. Nothing is handed out then, nothing is charged. */
export function assertNoTopLevelOwnerCall(calls){if(ownerUpgradeTopLevel(calls).length)throw Object.assign(Error('owner/upgrade selector at top level'),{code:'owner_call_top_level'});return calls;}
