// Apple App Attest verification (t629, owner approved). Proves a new-wallet request comes from the genuine Kipurse app on a
// real Apple device. Free; no Apple server call. Spec: developer.apple.com "Validating apps that connect to your server".
// clientDataHash = SHA-256("kipurse-attest-v1|" + x + "|" + y): binds the attestation to the phone key being enrolled.
import {createHash,X509Certificate} from 'node:crypto';import fs from 'node:fs';
const sha=b=>createHash('sha256').update(b).digest();
export const APPLE_ROOT=fs.readFileSync(new URL('./data/apple-app-attest-root.pem',import.meta.url),'utf8');
export const clientData=(x,y)=>sha(Buffer.from(`kipurse-attest-v1|${String(x).toLowerCase()}|${String(y).toLowerCase()}`));
// minimal CBOR (major types 0,2,3,4,5) — enough for the attestation object
export function cbor(buf){let i=0;const len=ai=>{if(ai<24)return ai;if(ai===24)return buf[i++];if(ai===25){const v=buf.readUInt16BE(i);i+=2;return v;}if(ai===26){const v=buf.readUInt32BE(i);i+=4;return v;}throw Error('cbor_len');};
  const item=()=>{if(i>=buf.length)throw Error('cbor_eof');const b=buf[i++],mt=b>>5,n=len(b&31);
    if(mt===0)return n;if(mt===2){const v=buf.subarray(i,i+n);if(v.length!==n)throw Error('cbor_eof');i+=n;return Buffer.from(v);}
    if(mt===3){const v=buf.subarray(i,i+n).toString('utf8');i+=n;return v;}if(mt===4){const a=[];for(let k=0;k<n;k++)a.push(item());return a;}
    if(mt===5){const o={};for(let k=0;k<n;k++){const key=item();o[key]=item();}return o;}throw Error('cbor_type');};
  const v=item();return v;}
// value of extension 1.2.840.113635.100.8.2: SEQUENCE { [1] { OCTET STRING nonce(32) } }
const OID=Buffer.from('06092a864886f763640802','hex');
function nonceOf(der){const k=der.indexOf(OID);if(k<0)return null;const tail=der.subarray(k+OID.length);const j=tail.indexOf(Buffer.from('0420','hex'));return j<0?null:Buffer.from(tail.subarray(j+2,j+34));}
/** Returns {ok:true, keyId, env} or {ok:false, reason}. Never throws. */
export function verifyAttestation({keyId,attestation,x,y,appId,root=APPLE_ROOT,now=new Date()}){
  try{const att=cbor(Buffer.from(String(attestation),'base64'));if(att.fmt!=='apple-appattest')return {ok:false,reason:'fmt'};
    const x5c=att.attStmt?.x5c;if(!Array.isArray(x5c)||x5c.length<2)return {ok:false,reason:'x5c'};
    const leaf=new X509Certificate(x5c[0]),mid=new X509Certificate(x5c[1]),R=new X509Certificate(root);
    const t=+now;for(const c of [leaf,mid])if(t<Date.parse(c.validFrom)||t>Date.parse(c.validTo))return {ok:false,reason:'expired'};
    if(!leaf.verify(mid.publicKey)||!mid.verify(R.publicKey)||!leaf.checkIssued(mid)||!mid.checkIssued(R))return {ok:false,reason:'chain'};
    const ad=att.authData;if(!Buffer.isBuffer(ad)||ad.length<55)return {ok:false,reason:'authdata'};
    const n=nonceOf(leaf.raw);if(!n||!n.equals(sha(Buffer.concat([ad,clientData(x,y)]))))return {ok:false,reason:'nonce'};
    const pub=leaf.publicKey.export({format:'jwk'});const pt=Buffer.concat([Buffer.from([4]),Buffer.from(pub.x,'base64url'),Buffer.from(pub.y,'base64url')]);
    const kid=Buffer.from(String(keyId),'base64');if(!sha(pt).equals(kid))return {ok:false,reason:'keyid'};
    if(!ad.subarray(0,32).equals(sha(Buffer.from(appId))))return {ok:false,reason:'appid'};
    if(ad.readUInt32BE(33)!==0)return {ok:false,reason:'counter'};
    const aaguid=ad.subarray(37,53).toString('latin1');const env=aaguid==='appattestdevelop'?'development':aaguid==='appattest\0\0\0\0\0\0\0'?'production':null;if(!env)return {ok:false,reason:'aaguid'};
    const cl=ad.readUInt16BE(53);if(!ad.subarray(55,55+cl).equals(kid))return {ok:false,reason:'credid'};
    return {ok:true,keyId:kid.toString('base64'),env};}catch(e){return {ok:false,reason:'malformed'};}}
