// SPDX-License-Identifier: AGPL-3.0-only
// Merchant credentials for signed-order requests (V5.1). A credential is loaded lazily from a local file, attached ONLY to https
// requests to its own host, and never returned, logged or put into errors / ledger rows.
import fs from 'node:fs';
/** ExampleShop listing owner token: the `#owner=<uuid>` fragment of the private recovery URL in the listing secrets file. */
export function exampleshopOwnerTokenLoader(file){return ()=>{const S=JSON.parse(fs.readFileSync(file,'utf8'));
  const m=/#owner=([0-9a-fA-F-]{36})/.exec(String(S?.response?.body?.ownership?.privateRecoveryUrl??''));if(!m)throw Error('ownerToken not found in the listing secrets file');return m[1];};}
/** cfg.signedOrderAuth = [{host:'exampleshop.example', bearer: () => token}]; host matches exactly or as a parent domain. */
export function authHeaderFor(rules,url){let u;try{u=new URL(url);}catch{return null;}if(u.protocol!=='https:')return null;
  const h=u.hostname.toLowerCase();const r=(rules??[]).find(x=>{const d=String(x.host).toLowerCase();return h===d||h.endsWith('.'+d);});
  if(!r)return null;const t=typeof r.bearer==='function'?r.bearer():r.bearer;if(!t)return null;return {Authorization:'Bearer '+t};}
/** Removes any configured credential from a string before it can reach a result or log. */
export function redactSecrets(rules,s){let out=String(s??'');for(const r of rules??[]){let t=null;try{t=typeof r.bearer==='function'?r.bearer():r.bearer;}catch{}if(t)out=out.split(t).join('<redacted>');}return out;}
/** Config wiring: cfg.exampleshopListingSecretsFile (0600) -> Bearer ownerToken for https://exampleshop.example signed-order requests only. */
export function applyMerchantAuthConfig(cfg){if(cfg.exampleshopListingSecretsFile){const f=cfg.exampleshopListingSecretsFile;
  if((fs.statSync(f).mode&0o077)!==0)throw Error('merchant secrets file must not be group/world readable');
  cfg.signedOrderAuth=[...(cfg.signedOrderAuth??[]),{host:'exampleshop.example',bearer:exampleshopOwnerTokenLoader(f)}];}return cfg;}
