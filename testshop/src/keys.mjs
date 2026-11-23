// Shop keys. ONE random 32-byte seed, stored only encrypted at rest (AES-256-GCM under a 32-byte data key that lives in a separate
// 0400 file). Every key the shop uses is derived from the seed:
//   deposit key #i  = keccak256(seed || "testshop/deposit/" || i)   (plain EOA; the order's deposit address)
//   order signer    = keccak256(seed || "testshop/signer")          (published as merchant.expectedSigner)
//   unpublished key = keccak256(seed || "testshop/unpublished")     (only for the "bad signature" test switch)
//   swap address #i = address of keccak256(seed || "testshop/swap/" || i) (only shown by the "swap address" test switch; never used)
// Private keys never leave this module: callers get viem LocalAccounts (sign / signTypedData / signAuthorization) and addresses.
import fs from 'node:fs';import {createCipheriv,createDecipheriv,randomBytes} from 'node:crypto';
import {keccak256,concat,toBytes,toHex,numberToHex} from 'viem';import {privateKeyToAccount} from 'viem/accounts';
const N=0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
export function readDataKey(file){const raw=fs.readFileSync(file);const s=raw.toString('utf8').trim();
  const k=/^[0-9a-fA-F]{64}$/.test(s)?Buffer.from(s,'hex'):raw.length===32?raw:null;if(!k)throw Error('DATA_KEY_BAD: need 32 raw bytes or 64 hex chars');return k;}
export function encrypt(dataKey,plain){const iv=randomBytes(12);const c=createCipheriv('aes-256-gcm',dataKey,iv);c.setAAD(Buffer.from('kipurse-testshop-seed-v1'));
  const ct=Buffer.concat([c.update(plain),c.final()]);return {v:1,alg:'aes-256-gcm',iv:iv.toString('hex'),tag:c.getAuthTag().toString('hex'),ct:ct.toString('hex')};}
export function decrypt(dataKey,box){if(box?.v!==1||box.alg!=='aes-256-gcm')throw Error('SEED_FILE_BAD');const d=createDecipheriv('aes-256-gcm',dataKey,Buffer.from(box.iv,'hex'));
  d.setAAD(Buffer.from('kipurse-testshop-seed-v1'));d.setAuthTag(Buffer.from(box.tag,'hex'));return Buffer.concat([d.update(Buffer.from(box.ct,'hex')),d.final()]);}
/** Load the encrypted seed file, creating it (0600, exclusive) on first start. */
export function loadOrCreateSeed(file,dataKey){
  if(!fs.existsSync(file)){const seed=randomBytes(32);fs.writeFileSync(file,JSON.stringify(encrypt(dataKey,seed)),{mode:0o600,flag:'wx'});}
  if((fs.statSync(file).mode&0o077)!==0)throw Error('SEED_FILE_MODE: seed file must not be readable by group/other');
  const seed=decrypt(dataKey,JSON.parse(fs.readFileSync(file,'utf8')));if(seed.length!==32)throw Error('SEED_FILE_BAD');return seed;}
function derive(seed,label){let k=BigInt(keccak256(concat([toHex(seed),toHex(toBytes(label))])));for(let i=0;k===0n||k>=N;i++)k=BigInt(keccak256(concat([numberToHex(k,{size:32}),numberToHex(i,{size:4})])));
  return numberToHex(k,{size:32});}
export function shopKeys(seed){if(!Buffer.isBuffer(seed)||seed.length!==32)throw Error('seed must be 32 bytes');const S=Buffer.from(seed);
  const cache=new Map();const acct=label=>{if(!cache.has(label))cache.set(label,privateKeyToAccount(derive(S,label)));return cache.get(label);};
  const idx=i=>{if(!Number.isSafeInteger(i)||i<0)throw Error('bad index');return String(i);};
  return {deposit:i=>acct('testshop/deposit/'+idx(i)),signer:()=>acct('testshop/signer'),unpublished:()=>acct('testshop/unpublished'),
    swapAddress:i=>privateKeyToAccount(derive(S,'testshop/swap/'+idx(i))).address};}
