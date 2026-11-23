// SPDX-License-Identifier: AGPL-3.0-only
// Operator constants (owner decision 2026-11-22): the official fee address and the paymaster addresses the ledger labels are OPERATOR
// values, not core constants. The launcher reads them from its operator config (mainnet-trustflow.config.json, key "operatorConstants").
// `defaults` is the launcher's own fallback for a config written before this key existed; an open-source build ships no defaults, so a
// missing or malformed value stops the start (fail closed) instead of paying fees to an address nobody chose.
const ADDR=/^0x[0-9a-fA-F]{40}$/;
export function operatorConstants(cfg,defaults={}){
  if(cfg!=null&&(typeof cfg!=='object'||Array.isArray(cfg)))throw Error('operator config: operatorConstants must be an object');
  const pick=k=>cfg?.[k]??defaults?.[k];
  const feeTo=pick('feeTo');
  if(typeof feeTo!=='string'||!ADDR.test(feeTo))throw Error('operator config: operatorConstants.feeTo (the official fee address) is missing or not an address');
  const list=k=>{const v=pick(k)??[];if(!Array.isArray(v)||!v.every(a=>typeof a==='string'&&ADDR.test(a)))throw Error(`operator config: operatorConstants.${k} must be a list of addresses`);return Object.freeze([...v]);};
  return Object.freeze({feeTo,paymasters:list('paymasters'),ownerPaymasters:list('ownerPaymasters')});}
