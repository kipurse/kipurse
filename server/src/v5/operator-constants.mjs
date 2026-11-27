// SPDX-License-Identifier: AGPL-3.0-only
// Operator constants (owner decision 2026-11-22): the official fee address and the paymaster addresses the ledger labels are OPERATOR
// values, not core constants. The launcher reads them from its operator config (mainnet-trustflow.config.json, key "operatorConstants").
// `defaults` is the launcher's own fallback for a config written before this key existed; an open-source build ships no defaults, so a
// missing or malformed value stops the start (fail closed) instead of paying fees to an address nobody chose.
const ADDR=/^0x[0-9a-fA-F]{40}$/;
/** t1346 (decision 169, owner t1302): the company Safe "Blessbridge Treasury" on Base (SafeL2 1.5.0, 2-of-3) is the ONLY fee address. */
export const COMPANY_FEE_TO='0x82ecF6e2F76eE100E4676dabe193bca6bcab64fD';
/** t1346: retired fee addresses that must never be paid again: the scrubbed open-source placeholder 0xf14E…0Dd9 (nobody holds its key)
 *  and the old ops account 0xfc0E…345B. Config, env and every fee builder refuse them (fail closed). */
export const RETIRED_FEE_TO=Object.freeze(['0xf14ef5dc4723245866c22c749a0a84afceba0dd9','0xfc0e68572cdba016c1c90a45e1792f3fe0ee345b']);
export const isRetiredFeeTo=a=>RETIRED_FEE_TO.includes(String(a??'').trim().toLowerCase());
export function assertFeeToUsable(a,what='fee address'){if(isRetiredFeeTo(a))throw Error(`${what}: ${a} is a retired fee address (t1346) - use the company Safe`);return a;}
export function operatorConstants(cfg,defaults={}){
  if(cfg!=null&&(typeof cfg!=='object'||Array.isArray(cfg)))throw Error('operator config: operatorConstants must be an object');
  const pick=k=>cfg?.[k]??defaults?.[k];
  const feeTo=pick('feeTo');
  if(typeof feeTo!=='string'||!ADDR.test(feeTo))throw Error('operator config: operatorConstants.feeTo (the official fee address) is missing or not an address');
  assertFeeToUsable(feeTo,'operator config: operatorConstants.feeTo');
  const list=k=>{const v=pick(k)??[];if(!Array.isArray(v)||!v.every(a=>typeof a==='string'&&ADDR.test(a)))throw Error(`operator config: operatorConstants.${k} must be a list of addresses`);return Object.freeze([...v]);};
  return Object.freeze({feeTo,paymasters:list('paymasters'),ownerPaymasters:list('ownerPaymasters')});}
