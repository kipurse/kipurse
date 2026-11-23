// SPDX-License-Identifier: AGPL-3.0-only
// t1157u: the connected-AI lists the owner app reads (state.agents and GET /safety/mandates agents), as pure functions so they are unit-tested.
// Siri appears ONCE: the phone 'siri' row (authorized by the enrolled phone + saved AI limits). The 'oauth-siri' record that a Siri
// first-connect reserves never receives a token (its redirect is not a real client), so listing it showed a second, never-connected Siri.
export const SIRI_OAUTH_ID='oauth-siri';
const live=a=>!!a&&!a.revoked;
/** state.agents. Same fields and order as before t1157u, minus the oauth-siri record. */
export function stateAgents({tokenAgents=[],oauthAgents={},tokens={},nowS=Date.now()/1000,phoneActive=false,siriAgent=null,spendOk=()=>false,siriStopped=()=>false,lastSeen={}}={}){
  const ag=new Map();for(const a of tokenAgents??[])if(!a.disabled)ag.set(a.id,{id:a.id,name:a.name??a.id,kind:a.id,via:'token'});
  const liveTok=id=>Object.values(tokens??{}).some(t=>t.agentId===id&&t.exp>nowS);
  for(const [id,a] of Object.entries(oauthAgents??{}))if(live(a)&&id!==SIRI_OAUTH_ID)ag.set(id,{id,name:a.name??id,kind:a.kind??id,via:'oauth',connectedAt:a.created,connected:liveTok(id)||ag.has(id)});
  // t915: Siri is authorized by the enrolled phone (Face ID signer active on the server), not by a token. Stopped via its agent cap.
  if(!ag.has('siri')){let stopped=false;try{stopped=!!siriStopped();}catch{}
    if(phoneActive||siriAgent){let ok=false;try{ok=spendOk()===true;}catch{ok=false;}ag.set('siri',{id:'siri',name:'Siri',kind:'siri',via:'phone',connected:!!phoneActive&&ok,paused:stopped,connectedAt:siriAgent?.since??null});}}
  // lastUsed = last REAL authenticated call from that agent (MCP request / Siri API).
  return [...ag.values()].map(a=>({connected:true,...a,lastUsed:lastSeen?.[a.id]??null}));}
/** GET /safety/mandates agents: one Siri row when Siri was connected (siriAgent) or a Siri first-connect record exists. */
export function mandateAgents({tokenAgents=[],oauthAgents={},siriAgent=null}={}){
  const siri=!!siriAgent||live(oauthAgents?.[SIRI_OAUTH_ID]);
  return [...(tokenAgents??[]).filter(a=>!a.disabled).map(a=>({id:a.id,name:a.name??a.id})),...Object.entries(oauthAgents??{}).filter(([id,a])=>live(a)&&id!==SIRI_OAUTH_ID).map(([id,a])=>({id,name:a.name??id})),...(siri?[{id:'siri',name:'Siri'}]:[])];}
/** t1161u (§6#78): why /mcp refused a request, for a privacy-safe log line (reason + agent id only, never the token or its hash).
 *  tokenAgentHit(tok) -> the agents.json row whose hash matches (or null); accessStatus(tok) -> OAuth view. */
export function mcpRefusal({tok,tokenAgentHit=()=>null,accessStatus=()=>({reason:'unknown_or_expired'})}={}){
  if(!tok)return {reason:'no_token',agentId:null};
  if(String(tok).startsWith('kps_'))return {reason:'phone_session_not_agent',agentId:null};
  let row=null;try{row=tokenAgentHit(tok);}catch{row=null;}
  if(row)return {reason:row.disabled?'agent_key_disabled':'ok',agentId:row.id??null};
  let s;try{s=accessStatus(tok)??{reason:'unknown_or_expired'};}catch{s={reason:'unknown_or_expired'};}
  return {reason:String(s.reason??'unknown_or_expired'),agentId:s.agentId??null};}
