// SPDX-License-Identifier: AGPL-3.0-only
export const AGENT_READ=new Set(['parseAny','parse','ledger','trustList','status','receipt','preflight','merchantInfo','listPurchases','limits','floatStatus','exportCsv','exitPlan','discoverMerchant','deposits','depositInfo','annualSummary','pause','requestRefund','disputes','cards']);
export const pausedEngine=(e,a)=>new Proxy(e,{get(t,k){const v=t[k];if(typeof v!=='function'||AGENT_READ.has(k))return typeof v==='function'?v.bind(t):v;
  return async()=>({state:'rejected',reason:'agent_paused',detail:`the owner paused this agent (${a.name}); nothing was sent. Ask the owner to resume it in the Kipurse app.`,fix:'wait for the owner to resume this agent'});}});
// t934: re-check the agent's pause / revoke state on EVERY call, so a long-lived (legacy SSE) session opened before the owner
// paused or revoked the agent can't keep spending with the engine it was handed at connect time.
export const liveAgentEngine=(e,getAgent)=>new Proxy(e,{get(t,k){const v=t[k];if(typeof v!=='function')return v;if(AGENT_READ.has(k))return v.bind(t);
  return async(...args)=>{const a=getAgent();if(!a||a.revoked)return {state:'rejected',reason:'agent_revoked',detail:'this AI was disconnected by the owner; nothing was sent.',fix:'reconnect in the Kipurse app'};
    if(a.paused)return pausedEngine(t,a)[k](...args);return v.apply(t,args);};}});
