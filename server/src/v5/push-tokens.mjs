// SPDX-License-Identifier: AGPL-3.0-only
// The APNs tokens of one wallet (KV push:<wallet>:tokens, at most 5). t1243 (decision 113): a phone that uploads a NEW token names its
// previous one as `replaces`; that old token leaves THIS wallet's list (never another wallet's) so one notification reaches the phone once.
// The route calling register() requires the phone session (only the owner's own phone can change the list).
export const TOKEN_RE=/^[0-9a-f]{32,200}$/i;
export function pushTokenList(KV,key){
  const get=()=>KV.get(key)??[];
  return {list:get,
    add:(t,lang,replaces=null)=>{const l=get().filter(x=>x.token!==t&&(!replaces||x.token!==replaces));l.push({token:t,lang:lang==='en'?'en':'zh',at:Date.now()});KV.put(key,l.slice(-5));},
    remove:t=>KV.put(key,get().filter(x=>x.token!==t)),
    setEnv:(t,env)=>KV.put(key,get().map(x=>x.token===t?{...x,env}:x))};}
/** body {token, lang, replaces?} -> [status, json]; `replaces` is ignored unless it is a token-shaped value different from the new one */
export function registerPushToken(list,b){const t=String(b?.token??'');if(!TOKEN_RE.test(t))return [400,{error:'bad_token'}];
  const rp=String(b?.replaces??'');const rep=TOKEN_RE.test(rp)&&rp.toLowerCase()!==t.toLowerCase()?rp:null;
  const replaced=rep?list.list().some(x=>x.token===rep):false;list.add(t,b?.lang,rep);return [200,{ok:true,replaced}];}
