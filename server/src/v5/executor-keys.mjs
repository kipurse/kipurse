// SPDX-License-Identifier: AGPL-3.0-only
// PER-USER EXECUTOR (session signer) KEYS. Each wallet gets its own secp256k1 key; it is named as the `executor` in THAT wallet's spend
// permission only, so on chain it can act for that one wallet and nothing else (the adapter checks msg.sender / the userOp signer
// against the permission's executor). Keys are encrypted at rest with a per-wallet AES key (HKDF of the operator data key + the wallet
// address), stored in a file named by a hash of the wallet, never logged, and deleted on account erase.
// The keyring only hands a key out for a wallet whose permission names that key's address (accountFor), so a bug or a confused request
// cannot use user A's key with user B's permission.
import fs from 'node:fs';import {join} from 'node:path';import {createHash} from 'node:crypto';
import {getAddress} from 'viem';import {generatePrivateKey,privateKeyToAccount} from 'viem/accounts';
import {tenantStore,plainStore} from './at-rest.mjs';import {decodePolicyV5,permissionFromJson} from './abi.mjs';
const fileOf=(dir,w)=>join(dir,createHash('sha256').update('kipurse-exec-v1:'+getAddress(w).toLowerCase()).digest('hex').slice(0,40)+'.key');
export function createExecutorKeyring({dir,dataKey,allowPlain=false}){
  if(!dataKey&&!allowPlain)throw Error('EXECUTOR_KEYS: a data key is required (keys are encrypted at rest per user)');
  fs.mkdirSync(dir,{recursive:true,mode:0o700});
  const store=w=>dataKey?tenantStore(dataKey,getAddress(w)):plainStore;
  const read=w=>{const f=fileOf(dir,w);if(!fs.existsSync(f))return null;const o=store(w).readJson(f,null);
    if(!o||getAddress(o.wallet)!==getAddress(w))throw Object.assign(Error('executor key file does not belong to this wallet'),{code:'key_wallet_mismatch'});return o;};
  /** Create (once) and return the PUBLIC address of this wallet's executor. */
  function ensure(wallet){const w=getAddress(wallet);let o=read(w);if(!o){const key=generatePrivateKey();o={v:1,wallet:w,key,address:privateKeyToAccount(key).address};
      const f=fileOf(dir,w);store(w).writeJson(f,o);try{fs.chmodSync(f,0o600);}catch{}}
    return getAddress(o.address);}
  const address=wallet=>{const o=read(wallet);return o?getAddress(o.address):null;};
  /** The signing account for `wallet`, ONLY if `permission` is that wallet's and names this key as executor. */
  function accountFor(wallet,permission){const w=getAddress(wallet);const p=permissionFromJson(permission);
    if(getAddress(p.account)!==w)throw Object.assign(Error('permission belongs to another wallet'),{code:'cross_wallet'});
    const o=read(w);if(!o)throw Object.assign(Error('no executor key for this wallet'),{code:'no_key'});
    const ex=getAddress(decodePolicyV5(p.extraData).executor);if(ex!==getAddress(o.address))throw Object.assign(Error('permission executor is not this wallet\'s key'),{code:'executor_mismatch'});
    return privateKeyToAccount(o.key);}
  function forget(wallet){const f=fileOf(dir,wallet);if(fs.existsSync(f)){try{const n=fs.statSync(f).size;fs.writeFileSync(f,Buffer.alloc(n));}catch{}fs.rmSync(f,{force:true});}return {ok:true};}
  return {ensure,address,accountFor,forget,_file:w=>fileOf(dir,w)};}
