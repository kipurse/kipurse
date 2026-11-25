// SPDX-License-Identifier: AGPL-3.0-only
// t1238 (decision 108 / decision 109): Face ID KEY SEAT. Coinbase's Base Account popup refuses every owner change (addOwnerAddress,
// removeOwnerAtIndex, ... even inside wallet.execute). New wallets therefore get ALL their owners when the Coinbase factory creates them:
// [owner's Base Account, this owner's key seat, SpendPermissionManager]. After that no owner is ever added or removed:
//   - first phone / new phone / reinstall = wallet.execute(seat, 0, setKey(x, y))
//   - Face ID off                          = wallet.execute(seat, 0, clearKey())
// The seat's address depends only on (factory, owner, spm, trust) - never on the phone key - so the wallet address is known before opening.
// Behind KIPURSE_KEY_SEAT (default OFF). Contract source: work/t1213/contracts/src/KipurseKeySeatV1.sol (dev only, NOT audited).
import fs from 'node:fs';import {concat,encodeAbiParameters,encodeFunctionData,getAddress,getContractAddress,keccak256,parseAbi,toHex} from 'viem';
const ART=JSON.parse(fs.readFileSync(new URL('./key-seat-v1-artifact.json',import.meta.url)));
export const SEAT_ABI=ART.abi;
export const SEAT_VERSION='seat1';
export const DETERMINISTIC_DEPLOYER='0x4e59b44847b379578588920cA78FbF26c0B4956C';
export const SEAT_SALT=keccak256(toHex('kipurse-key-seat-v1'));
/** Gas for a post-opening setKey batch: setKey via wallet.execute (~70k measured on a Base fork) + the wallet-pays USDC fee leg + headroom. */
export const SEAT_ENROLL_GAS=200_000n;
const WALLET=parseAbi(['function execute(address target, uint256 value, bytes data)']);
const enc=a=>encodeAbiParameters([{type:'address'}],[getAddress(a)]);
/** CREATE2 (deterministic deployer) of the seat for this owner. deployData = salt ‖ initcode (the deployer's calldata). */
export function seatInit({factory,owner,spm,trust}){
  const initcode=concat([ART.bytecode,encodeAbiParameters([{type:'address'},{type:'address'},{type:'address'},{type:'address'}],[getAddress(factory),getAddress(owner),getAddress(spm),getAddress(trust)])]);
  const address=getContractAddress({from:DETERMINISTIC_DEPLOYER,opcode:'CREATE2',salt:SEAT_SALT,bytecode:initcode});
  return {initcode,salt:SEAT_SALT,address,deployData:concat([SEAT_SALT,initcode])};}
/** The owners the Coinbase factory gets at creation, in this exact order (index 0 = Base Account, 1 = seat, 2 = SpendPermissionManager). */
export const seatOwners=(owner,seat,spm)=>[enc(owner),enc(seat),enc(spm)];
export const SEAT_OWNER_INDEX=1;
export function setKeyCall(wallet,seat,x,y){return {to:getAddress(wallet),value:'0x0',data:encodeFunctionData({abi:WALLET,functionName:'execute',args:[getAddress(seat),0n,encodeFunctionData({abi:SEAT_ABI,functionName:'setKey',args:[BigInt(x),BigInt(y)]})]})};}
export function clearKeyCall(wallet,seat){return {to:getAddress(wallet),value:'0x0',data:encodeFunctionData({abi:WALLET,functionName:'execute',args:[getAddress(seat),0n,encodeFunctionData({abi:SEAT_ABI,functionName:'clearKey'})]})};}
/** On-chain key of the seat (0,0 = Face ID off). */
export async function seatKey(pub,seat){const [x,y,w]=await Promise.all(['x','y','wallet'].map(f=>pub.readContract({address:getAddress(seat),abi:SEAT_ABI,functionName:f})));return {x:BigInt(x),y:BigInt(y),wallet:getAddress(w)};}
