// SPDX-License-Identifier: AGPL-3.0-only
// Operator layer loader. The open-source core never names who runs it: company, brand, accounts, IDs, domains and key
// paths come from an operator.json OUTSIDE the repo (see config/operator.example.json + operator.schema.json and
// docs/ARCHITECTURE_LAYERS.md). Lookup: KIPURSE_OPERATOR_CONFIG, else the per-OS default below.
// Missing config => startup fails, unless KIPURSE_DEMO=1 (unbranded demo: no onramp key, no public URL).
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {fileURLToPath} from 'node:url';
// Repo root = nearest ancestor of kit/ holding .git or LICENSE (source checkout); a code-only deploy (no marker) => kit/..
// Never walk to $HOME: a bare ../.. would treat every per-user config path as "inside the repo".
const KIT_PARENT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const REPO_ROOT=(()=>{const home=path.resolve(os.homedir());let d=KIT_PARENT;for(let i=0;i<3;i++){if(d===home||d===path.dirname(d))break;
  if(fs.existsSync(path.join(d,'.git'))||fs.existsSync(path.join(d,'LICENSE')))return d;d=path.dirname(d);}return KIT_PARENT;})();
export function defaultOperatorPath(env=process.env,platform=process.platform,home=os.homedir()){
  if(platform==='darwin')return path.join(home,'Library','Application Support','Kipurse','operator','operator.json');
  return path.join(env.XDG_CONFIG_HOME||path.join(home,'.config'),'kipurse-operator','operator.json');}
const SECTIONS={operator:['legalName','displayName','website','supportEmail','reviewEmail'],endpoints:['publicUrl','mcpUrl','rescueUrl'],
  cdp:['entityId','projectId','apiKeyFile','onrampAppName'],apple:['teamId','bundleIdPrefix','apnsKeyId','apnsKeyFile'],fees:['recipientLabel','recipient','opsAddress'],cardIssuer:['provider','accountRef']};
export const DEMO_OPERATOR=Object.freeze({demo:true,file:null,operator:{displayName:'Kipurse (unbranded demo)'},endpoints:{},cdp:{},apple:{},fees:{recipientLabel:'fee account (on chain)'},cardIssuer:{provider:'mock'}});
export function validateOperator(o){const errs=[];if(!o||typeof o!=='object'||Array.isArray(o))return ['must be a JSON object'];
  for(const k of Object.keys(o))if(k!=='$schema'&&!SECTIONS[k])errs.push(`unknown section "${k}"`);
  for(const [sec,keys] of Object.entries(SECTIONS)){const v=o[sec];if(v==null)continue;if(typeof v!=='object'||Array.isArray(v)){errs.push(`${sec} must be an object`);continue;}
    for(const [k,x] of Object.entries(v)){if(!keys.includes(k))errs.push(`unknown field ${sec}.${k}${/secret|private|token|password/i.test(k)?' (secrets are never inline: use a key FILE path)':''}`);else if(typeof x!=='string')errs.push(`${sec}.${k} must be a string`);}}
  if(!o.operator?.displayName)errs.push('operator.displayName is required');
  for(const k of ['apiKeyFile']){const p=o.cdp?.[k];if(p&&!path.isAbsolute(p))errs.push(`cdp.${k} must be an absolute path`);}
  if(o.apple?.apnsKeyFile&&!path.isAbsolute(o.apple.apnsKeyFile))errs.push('apple.apnsKeyFile must be an absolute path');
  if(o.cardIssuer?.provider&&!['mock','rain','stripe-issuing'].includes(o.cardIssuer.provider))errs.push('cardIssuer.provider must be mock | rain | stripe-issuing');
  for(const k of ['publicUrl','mcpUrl','rescueUrl'])if(o.endpoints?.[k]&&!/^https?:\/\//.test(o.endpoints[k]))errs.push(`endpoints.${k} must be an http(s) URL`);
  return errs;}
const inside=(p,root)=>{const r=path.relative(root,p);return r&&!r.startsWith('..')&&!path.isAbsolute(r);};
export function loadOperatorConfig({env=process.env,repoRoot=REPO_ROOT,platform=process.platform,home=os.homedir()}={}){
  const file=path.resolve(env.KIPURSE_OPERATOR_CONFIG||defaultOperatorPath(env,platform,home));
  if(!fs.existsSync(file)){if(env.KIPURSE_DEMO==='1')return DEMO_OPERATOR;
    throw Error(`operator config not found at ${file}\n  Copy config/operator.example.json to a path OUTSIDE the repo, fill it in, and set KIPURSE_OPERATOR_CONFIG=/that/path (or use the default path).\n  To run an unbranded local demo without one: KIPURSE_DEMO=1`);}
  const real=fs.realpathSync(file);
  if(inside(real,fs.realpathSync(repoRoot)))throw Error(`operator config ${real} is inside the open-source tree; move it outside the repo (operator data must never be committed)`);
  let o;try{o=JSON.parse(fs.readFileSync(real,'utf8'));}catch(e){throw Error(`operator config ${real} is not valid JSON: ${e.message}`);}
  const errs=validateOperator(o);if(errs.length)throw Error(`operator config ${real} is invalid:\n  - `+errs.join('\n  - '));
  for(const sec of ['cdp','apple'])for(const k of ['apiKeyFile','apnsKeyFile']){const p=o[sec]?.[k];if(p&&inside(path.resolve(p),repoRoot))throw Error(`${sec}.${k} points inside the open-source tree; keep keys outside the repo`);}
  const out={demo:false,file:real};for(const s of Object.keys(SECTIONS))out[s]={...(o[s]||{})};return Object.freeze(out);}
// The few values the kit consumes; env vars still win so existing deployments keep working.
export function operatorRuntime(op,env=process.env){return {
  publicUrl:(env.KIPURSE_PUBLIC_URL||op.endpoints.publicUrl||'').replace(/\/$/,''),
  cdpKeyFile:env.KIPURSE_CDP_KEY_FILE||op.cdp.apiKeyFile||undefined,
  rescueUrl:env.KIPURSE_RESCUE_URL||op.endpoints.rescueUrl||'',
  displayName:op.operator.displayName,feeRecipientLabel:op.fees.recipientLabel||`${op.operator.displayName} fee account (on chain)`,
  publicInfo:{displayName:op.operator.displayName,website:op.operator.website||'',supportEmail:op.operator.supportEmail||'',demo:!!op.demo}};}
