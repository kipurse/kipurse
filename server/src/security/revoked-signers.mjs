// SPDX-License-Identifier: AGPL-3.0-only
// Merchant signers that must NEVER be honoured again, regardless of what any permission's signerRoot still contains
// (e.g. a merchant signing key that leaked). No built-in list: operators supply one at runtime, no code change:
//   KIPURSE_REVOKED_SIGNERS="0xabc...,0xdef..."   and/or   AGENT_WALLET_REVOKED_SIGNERS_FILE=/path/revoked-signers.json (JSON array)
import {readFileSync,existsSync} from 'node:fs';
export function revokedSigners(env=process.env){
  const s=new Set();for(const x of String(env.KIPURSE_REVOKED_SIGNERS??'').split(',').map(v=>v.trim()).filter(Boolean))s.add(x.toLowerCase());
  const f=env.AGENT_WALLET_REVOKED_SIGNERS_FILE;
  if(f&&existsSync(f)){const a=JSON.parse(readFileSync(f,'utf8'));if(!Array.isArray(a))throw Error('REVOKED_SIGNERS_FILE_INVALID');for(const x of a)s.add(String(x).toLowerCase());}
  return s;
}
export const isRevokedSigner=(addr,env)=>!!addr&&revokedSigners(env).has(String(addr).toLowerCase());
