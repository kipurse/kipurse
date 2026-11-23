// SPDX-License-Identifier: Apache-2.0
// t1166u (handbook §6#80, PERMANENT LOCKED RULE): every AI-facing amount is human-ready USDC.
// Output shape for each USDC amount field `x` (MCP tools, /v1 agent API, /siri/*):
//   x          = exact decimal USDC string, e.g. "13.23532"      (never base units)
//   xDisplay   = "13.24 USDC" (2 decimals; a non-zero amount under 0.01 shows its exact value)
//   xAtomic    = base units (machine use only; only ever under a name ending in "Atomic")
// Owner-signing structures and request objects an AI sends back are left byte-for-byte unchanged.
export const NOTE_EN='All amounts are already in USDC (e.g. "13.24 USDC"): read them as they are, never convert. *Atomic fields are base units for machines only; do not read them to the user.';
export const NOTE_ZH='所有金额已经是 USDC（如 "13.24 USDC"），直接读，不要换算；带 Atomic 的字段是给机器用的最小单位，不要念给用户。';
// USDC amount keys (lower-cased match). Code that outputs an already-decimal USDC value under one of these keys MUST add its *Atomic sibling
// (e.g. allowances single:"6" + singleAtomic:"6000000"); humanize then only adds the Display and never divides again. Deliberately explicit; unknown keys are left alone and the regression check names them.
const AMOUNT=/^(amount|balance|used|overall|monthly|gasquote|funded|outstandingfailedgas|reserved|refunds|totalcost|strangertoday|verifiedtoday|usedtoday|spendable|available|reserve|vaultbalance|fee|fees|protocolfee|networkfee|gasrecovery|gasfee|total|totalfee|subtotal|grandtotal|spent|spenttoday|spentterm|spentmonth|remaining|remainingtoday|remainingterm|left|lefttoday|leftterm|leftmonth|limit|cap|single|daily|term|total_cap|requestedsingle|requesteddaily|requestedterm|perpayment|perday|termtotal|today|month|week|price|maxprice|max_price|maxpayable|maxamount|minamount|refund|refunded|refundedamount|leftover|quarantined|headroom|delta|owed|budget|allowance|deposit|deposited|withdrawn|withdrawable|floatbalance|committed|vouchers|value_usdc|sum|net|gross|paid|received|unrecognizedperpayment|unrecognizedperday|perpaymentcap|totalcap|dailycap|singlecap|opensingle|opendaily|maxsingle|maxdaily|maxterm|floor|amountdue|due|charge|charged|cost|tip)$/;
// Subtrees that must stay exactly as produced: owner signing (typed data, calls, user ops, permissions) and request objects an AI may pass back.
const KEEP=new Set(['typedData','typed_data','typed','domain','types','message','calls','call','userOp','userOperation','permission','permissionContext','eip712','signature',
  'direct','request','signedOrder','http','uri','payment','coinbaseCheckout','stripePaymentIntent','canonical','raw','ownerApproval','tx','transaction','order_params','orderParams','headers','body']);
const INT=/^-?[0-9]+$/,DEC=/^-?[0-9]+\.[0-9]+$/;
// camelCase / snake_case keys whose LAST word is an unambiguous USDC word (termSpent, strangerTodaySpent, verifiedSingle, maxNetworkFee, walletBalance, ...)
const SUFFIX=/^(spent|single|daily|fee|fees|balance|amount|limit|cap|remaining|refund|refunded|paid|price|cost|budget|allowance|deposit|deposited|withdrawn|withdrawable|total|perpayment|perday)$/;
// never USDC even if the last word matches: counts, times, gas/wei, rates, ids
const NOT=new Set(['count','days','hours','seconds','secs','ms','wei','gwei','gas','bps','ppm','nonce','block','index','idx','id','ids','percent','pct','ratio','rate','version','eth','at','time','until','expires','deadline','number','num']);
const words=k=>k.replace(/([a-z0-9])([A-Z])/g,'$1 $2').toLowerCase().split(/[ _-]+/).filter(Boolean);
export const isAmountKey=k=>{if(typeof k!=='string'||/atomic$/i.test(k)||/display$/i.test(k))return false;const l=k.toLowerCase();if(AMOUNT.test(l)||l==='usdc')return true;
  const w=words(k);if(w.length<2||w.some(x=>NOT.has(x)))return false;return SUFFIX.test(w[w.length-1])||SUFFIX.test(w.slice(-2).join(''));};
/** base units (bigint|int string) -> exact decimal string, no trailing zeros: 13235320 -> "13.23532", 1000000 -> "1" */
export function atomicToUsdc(v){const b=BigInt(v);const neg=b<0n,a=neg?-b:b;const w=a/1000000n,f=a%1000000n;return (neg?'-':'')+w.toString()+(f?'.'+f.toString().padStart(6,'0').replace(/0+$/,''):'');}
/** exact decimal USDC string -> "13.24 USDC" (2 decimals, half-up); non-zero |x| < 0.01 keeps its exact value */
export function displayUsdc(dec){const s=String(dec);const neg=s.startsWith('-');const [w,f='']=s.replace('-','').split('.');
  const a=BigInt(w)*1000000n+BigInt((f+'000000').slice(0,6));if(a===0n)return '0.00 USDC';
  if(a<10000n)return (neg?'-':'')+atomicToUsdc(a)+' USDC';
  const c=(a+5000n)/10000n;return (neg?'-':'')+(c/100n).toString()+'.'+(c%100n).toString().padStart(2,'0')+' USDC';}
const isIntish=v=>typeof v==='bigint'||(typeof v==='string'&&INT.test(v)&&v.length<=30)||(typeof v==='number'&&Number.isSafeInteger(v));
/** Make an AI-facing response human-ready (returns a new object; never mutates). */
export function humanize(o,{depth=0}={}){
  if(depth>40)return o;
  if(typeof o==='bigint')return o.toString();
  if(Array.isArray(o))return o.map(x=>humanize(x,{depth:depth+1}));
  if(!o||typeof o!=='object')return o;
  const out={};
  for(const [k,v] of Object.entries(o)){
    if(KEEP.has(k)){out[k]=v;continue;}
    // already paired with base units (native or a second pass): the value is decimal USDC; only add the Display
    // paired with base units (native or a second pass): the base units are the truth, the decimal is derived from them (engine answers carry amount AND amountAtomic both in base units)
    if(isAmountKey(k)&&(typeof v==='string'||typeof v==='number')&&(INT.test(String(v))||DEC.test(String(v)))&&INT.test(String(o[k+'Atomic']??''))){const dec=atomicToUsdc(o[k+'Atomic']);out[k]=dec;out[k+'Display']=displayUsdc(dec);continue;}
    if(isAmountKey(k)&&isIntish(v)){const dec=atomicToUsdc(v);out[k]=dec;if(!(k+'Display' in o))out[k+'Display']=displayUsdc(dec);if(!(k+'Atomic' in o))out[k+'Atomic']=String(v);continue;}
    if(isAmountKey(k)&&typeof v==='string'&&DEC.test(v)){out[k]=v;if(!(k+'Display' in o))out[k+'Display']=displayUsdc(v);continue;}
    out[k]=humanize(v,{depth:depth+1});
  }
  return out;}
/** Top-level human summary for balance answers. */
export function withSummary(o){if(!o||typeof o!=='object'||Array.isArray(o)||o.summary)return o;
  const b=o.balanceDisplay??o.usdcDisplay??o.wallet?.balanceDisplay??o.wallet?.usdcDisplay;if(!b)return o;return {summary:`余额 ${b} / Balance ${b}`,...o};}
/** The one entry point for AI-facing JSON: humanize, add the summary and the unit note. */
export function forAI(o){const h=withSummary(humanize(o));if(h&&typeof h==='object'&&!Array.isArray(h))return {...h,amountsUnit:'USDC',amountsNote:NOTE_EN+' '+NOTE_ZH};return h;}
/** PERMANENT regression check (handbook §6#80): every problem = a raw base-unit integer as an amount field, or an amount without its Display. */
export function amountProblems(o,path='$',acc=[],depth=0){
  if(depth>40||!o||typeof o!=='object')return acc;
  if(Array.isArray(o)){o.forEach((x,i)=>amountProblems(x,path+'['+i+']',acc,depth+1));return acc;}
  for(const [k,v] of Object.entries(o)){const p=path+'.'+k;
    if(KEEP.has(k))continue;
    if(isAmountKey(k)&&(isIntish(v)||(typeof v==='string'&&DEC.test(v)))){
      const d=o[k+'Display'],at=o[k+'Atomic'];
      if(typeof d!=='string'||!/ USDC$/.test(d))acc.push(p+': '+(isIntish(v)?'raw base-unit integer '+String(v)+' (no '+k+'Display)':'no '+k+'Display'));
      else if(at!==undefined&&(!INT.test(String(at))||atomicToUsdc(at)!==String(v)))acc.push(p+': value '+String(v)+' is not the USDC of '+k+'Atomic '+String(at));
      else if(displayUsdc(String(v))!==d)acc.push(p+': '+k+'Display '+d+' does not match '+String(v));
    }
    if(v&&typeof v==='object')amountProblems(v,p,acc,depth+1);}
  return acc;}
