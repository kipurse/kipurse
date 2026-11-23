// SPDX-License-Identifier: Apache-2.0
// One tool spec, reused by every framework adapter. The SDK holds no keys; the gateway enforces caps, pause and exactly-once.
export const TOOLS=[
 {name:'kipurse_preflight',description:'Check whether a payment request can be paid within the owner limits. Returns canPay, reasons, fees in USDC.',
  parameters:{type:'object',properties:{uri:{type:'string',description:'Payment request URI or x402 URL'},intentId:{type:'string'}},required:['uri','intentId']}},
 {name:'kipurse_pay',description:'Pay a request exactly once (same intentId = same purchase). Fails closed if paused or over a limit.',
  parameters:{type:'object',properties:{uri:{type:'string'},intentId:{type:'string'},maxAmount:{type:'string',description:'USDC base units'}},required:['uri','intentId']}},
 {name:'kipurse_limits',description:'Remaining daily/term limits of this AI.',parameters:{type:'object',properties:{}}}];
export function runTool(kp,name,a={}){
  if(name==='kipurse_limits')return kp.limits();
  if(name==='kipurse_preflight')return kp.preflight({uri:a.uri},{intentId:a.intentId});
  if(name==='kipurse_pay')return kp.pay({request:{uri:a.uri},intentId:a.intentId,maxAmount:a.maxAmount});
  throw Error('unknown tool '+name);}
