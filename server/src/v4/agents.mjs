// Per-agent bearer tokens with sub-budgets. Only SHA-256 hashes of tokens are stored in config; tokens are minted once
// and handed to the agent's operator (never logged). Sub-budgets are enforced by the gateway on top of the on-chain caps.
import {createHash,randomBytes,timingSafeEqual} from 'node:crypto';
export const hashToken=t=>createHash('sha256').update(String(t)).digest('hex');
export const mintAgentToken=()=>'kpa_'+randomBytes(32).toString('base64url');
/** agents: [{id, tokenSha256, dailyAtomic?, termAtomic?, maxPaymentAtomic?, disabled?}] */
export function resolveAgent(agents,token){
  if(!Array.isArray(agents)||typeof token!=='string'||token.length<16)return null;
  const h=Buffer.from(hashToken(token),'hex');
  for(const a of agents){const x=Buffer.from(String(a.tokenSha256??''),'hex');if(x.length===h.length&&timingSafeEqual(x,h))return a.disabled?null:a;}
  return null;
}
/** Returns null if within the agent's sub-budget, else a reason code. day = permission day (same as the adapter). */
export function agentBudgetReason(agent,ledger,amount,permission,nowS=Math.floor(Date.now()/1000)){
  if(!agent)return null;
  if(agent.maxPaymentAtomic!==undefined&&amount>BigInt(agent.maxPaymentAtomic))return 'over_agent_single_limit';
  const start=Number(permission.start),dayStart=(start+Math.floor(Math.max(0,nowS-start)/86400)*86400)*1000;
  if(agent.dailyAtomic!==undefined&&ledger.agentSpentSince(agent.id,dayStart)+amount>BigInt(agent.dailyAtomic))return 'over_agent_daily_budget';
  if(agent.termAtomic!==undefined&&ledger.agentSpentSince(agent.id,start*1000)+amount>BigInt(agent.termAtomic))return 'over_agent_term_budget';
  return null;
}
export function agentBudgetStatus(agent,ledger,permission,nowS=Math.floor(Date.now()/1000)){
  if(!agent)return null;const start=Number(permission.start),dayStart=(start+Math.floor(Math.max(0,nowS-start)/86400)*86400)*1000;
  const d=ledger.agentSpentSince(agent.id,dayStart),t=ledger.agentSpentSince(agent.id,start*1000);
  const rem=(cap,used)=>cap===undefined?'unlimited':(BigInt(cap)>used?BigInt(cap)-used:0n).toString();
  return {agentId:agent.id,todaySpent:d.toString(),termSpent:t.toString(),dailyRemaining:rem(agent.dailyAtomic,d),termRemaining:rem(agent.termAtomic,t),maxPaymentAtomic:agent.maxPaymentAtomic??null};
}
