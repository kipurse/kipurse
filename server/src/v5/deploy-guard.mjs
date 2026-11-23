// SPDX-License-Identifier: AGPL-3.0-only
// Mainnet guard for scripts/v5-ops-deploy.mjs (reviewed 2026-10-17). DEFAULT OFF. Base mainnet needs ALL of:
//   --mainnet  --execute  --i-have-owner-approval  an interactive TTY  3 typed confirmations  the owner's own funding tx.
// Without --execute, mainnet is a READ-ONLY dry run (plan + live cost estimate, nothing signed or sent). The script never holds or
// reads an owner mainnet key: the owner funds the ops address from their own wallet; the only key used is the fresh ops signer.
import {getAddress,isAddress} from 'viem';
export const MAX_MAINNET_FUND_ATOMIC=5_000_000n; // hard ceiling on what the plan may ask the owner to send (5 USDC)
export function parseDeployArgs(argv){
  const flags=new Set(argv.filter(a=>a.startsWith('--')&&!a.includes('=')));const kv=Object.fromEntries(argv.filter(a=>a.startsWith('--')&&a.includes('=')).map(a=>{const i=a.indexOf('=');return [a.slice(2,i),a.slice(i+1)];}));
  const pos=argv.filter(a=>!a.startsWith('--'));
  const mainnet=flags.has('--mainnet');const execute=flags.has('--execute');const approval=flags.has('--i-have-owner-approval');
  const dryRun=flags.has('--dry-run')||(mainnet&&!execute);
  const errors=[];
  if(mainnet){
    if(execute&&!approval)errors.push('--execute on mainnet requires --i-have-owner-approval');
    for(const k of ['treasury','fee-admin','registry-maintainer'])if(!kv[k]||!isAddress(kv[k],{strict:false}))errors.push(`--${k}=<address> is required on mainnet`);
    if(execute&&!kv['bundler-url-env'])errors.push('--bundler-url-env=<ENV NAME> (BYO / free-tier bundler URL, never printed) is required on mainnet');
    const fund=BigInt(kv.fund??'1000000');if(fund>MAX_MAINNET_FUND_ATOMIC)errors.push(`--fund above the ${MAX_MAINNET_FUND_ATOMIC} atomic ceiling`);
  }
  if(!mainnet&&(execute||approval))errors.push('--execute / --i-have-owner-approval are mainnet-only flags');
  return {mainnet,execute:mainnet?execute&&approval&&!dryRun:!dryRun,dryRun,approval,chainId:mainnet?8453:84532,pos,kv,errors,
    fund:BigInt(kv.fund??'1000000'),treasury:kv.treasury&&getAddress(kv.treasury),feeAdmin:kv['fee-admin']&&getAddress(kv['fee-admin']),
    registryMaintainer:kv['registry-maintainer']&&getAddress(kv['registry-maintainer']),bundlerUrlEnv:kv['bundler-url-env']};
}
/** The three typed confirmations. `ask(question)` returns the typed line. Any mismatch aborts before anything is sent. */
export async function confirmMainnet({ask,isTTY,ops,fund,steps,estimateUsd}){
  if(!isTTY)throw Error('MAINNET_REFUSED: confirmations need an interactive terminal');
  const want=[[`Type the ops account address to deploy from (${ops}):`,ops],
    [`You (the owner) will send ${(Number(fund)/1e6).toFixed(6)} USDC from YOUR wallet to that address and it pays ~$${estimateUsd.toFixed(2)} of gas. Type FUND ${(Number(fund)/1e6).toFixed(6)} USDC:`,`FUND ${(Number(fund)/1e6).toFixed(6)} USDC`],
    [`Type DEPLOY ${steps} OPS ON BASE MAINNET to broadcast ${steps} user operations:`,`DEPLOY ${steps} OPS ON BASE MAINNET`]];
  for(const [q,a] of want){const got=String(await ask(q)).trim();if(got!==a)throw Error('MAINNET_REFUSED: confirmation mismatch; nothing was sent');}
  return true;
}
