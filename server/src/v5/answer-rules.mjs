// SPDX-License-Identifier: AGPL-3.0-only
// Dependency-free owner-answer rules shared by the gateway (validateAnswers) and the kit page (browser). Plain-Chinese errors.
// Term: the V5 adapter accepts any term with period == end - start and period <= 365 days (KipurseAdapterV5.sol, Term()), so any whole number of days 1..365 is allowed.
export const TERM_MIN_DAYS=1,TERM_MAX_DAYS=365,TERM_PRESETS=[30,90,180,365];
export const USDC_KEYS=['perPayment','perDay','termTotal','unrecognizedPerPayment','unrecognizedPerDay','depositDailyLimit'];
export const LARGE_USDC=100;// warning threshold (USDC); a warning, never a block
export const NAME_ZH={termDays:'授权天数',perPayment:'每笔上限',perDay:'每天上限',termTotal:'整个期间上限',unrecognizedPerPayment:'陌生收款方每笔上限',unrecognizedPerDay:'陌生收款方每天上限',depositDailyLimit:'每天充值上限'};
/** '1.5' -> 1500000n; undefined when not a plain positive-format number with <= 6 decimals. Accepts a Chinese/fullwidth decimal comma. */
export function parseUsdc(v){const s=String(v??'').trim().replace(/[，,。]/g,'.').replace(/[０-９]/g,c=>String.fromCharCode(c.charCodeAt(0)-0xFEE0));
  const m=/^(\d{1,12})(?:\.(\d{0,6}))?$/.exec(s)||/^()\.(\d{1,6})$/.exec(s);if(!m)return undefined;return BigInt(m[1]||'0')*1000000n+BigInt((m[2]??'').padEnd(6,'0')||'0');}
export function usdcErrorZh(key,v){const n=NAME_ZH[key]??key;if(v===undefined||v===null||String(v).trim()==='')return `${n}：请填写一个数字`;
  const s=String(v).trim();if(/^-/.test(s))return `${n}：不能是负数`;if(/\.\d{7,}$/.test(s.replace(/[，,]/g,'.')))return `${n}：USDC 最多 6 位小数`;
  const x=parseUsdc(v);if(x===undefined)return `${n}：请只填数字，比如 5 或 0.5`;if(x<=0n)return `${n}：必须大于 0`;return null;}
export function termErrorZh(v){const s=String(v??'').trim();if(!s)return '授权天数：请选一个或自己填天数';if(!/^\d+$/.test(s))return '授权天数：请填整数天，比如 60';
  const d=Number(s);if(d<TERM_MIN_DAYS||d>TERM_MAX_DAYS)return `授权天数：合约只允许 ${TERM_MIN_DAYS} 到 ${TERM_MAX_DAYS} 天`;return null;}
/** Field errors + cross-field errors + large-amount warnings. Works on partial answers (only checks what is filled). */
export function checkAnswersZh(a={},{partial=false}={}){const errors=[],warnings=[],v={};
  const has=k=>!(a[k]===undefined||a[k]===null||String(a[k]).trim()==='');
  if(has('termDays')||!partial){const e=termErrorZh(a.termDays);if(e)errors.push({key:'termDays',zh:e});else v.termDays=Number(a.termDays);}
  for(const k of USDC_KEYS){if(!has(k)&&partial)continue;const e=usdcErrorZh(k,a[k]);if(e)errors.push({key:k,zh:e});else v[k]=parseUsdc(a[k]);}
  const le=(x,y,key,zh)=>{if(v[x]!==undefined&&v[y]!==undefined&&v[x]>v[y])errors.push({key,zh});};
  le('perPayment','perDay','perPayment','每笔上限不能大于每天上限');le('perDay','termTotal','perDay','每天上限不能大于整个期间上限');
  le('unrecognizedPerPayment','perPayment','unrecognizedPerPayment','陌生收款方每笔上限不能大于每笔上限');le('unrecognizedPerDay','perDay','unrecognizedPerDay','陌生收款方每天上限不能大于每天上限');
  le('unrecognizedPerPayment','unrecognizedPerDay','unrecognizedPerPayment','陌生收款方每笔上限不能大于陌生收款方每天上限');
  const big=Object.entries(v).filter(([k,x])=>k!=='termDays'&&x>BigInt(LARGE_USDC)*1000000n).map(([k])=>NAME_ZH[k]);
  if(big.length)warnings.push(`金额较大（${big.join('、')} 超过 ${LARGE_USDC} USDC）。这个钱包完全由 AI 控制，请只放少量资金。`);
  return {ok:errors.length===0,errors,warnings,values:v};}
/** Later limit changes (gateway-enforced keys). `main` = on-chain single/daily (atomic strings) for the "≤ main caps" rule. */
export function checkLimitChangeZh(ch={},{current={},main}={}){const errors=[],warnings=[],v={};
  for(const [k,x] of Object.entries(ch)){const e=usdcErrorZh(k,x);if(e)errors.push({key:k,zh:e});else v[k]=parseUsdc(x);}
  const m={...Object.fromEntries(Object.entries(current).filter(([k])=>USDC_KEYS.includes(k)).map(([k,x])=>[k,BigInt(x)])),...v};
  if(main){if(m.unrecognizedPerPayment>BigInt(main.single))errors.push({key:'unrecognizedPerPayment',zh:'陌生收款方每笔上限不能大于链上每笔上限（要更高需重新确认）'});
    if(m.unrecognizedPerDay>BigInt(main.daily))errors.push({key:'unrecognizedPerDay',zh:'陌生收款方每天上限不能大于链上每天上限（要更高需重新确认）'});}
  if(m.unrecognizedPerPayment!==undefined&&m.unrecognizedPerDay!==undefined&&m.unrecognizedPerPayment>m.unrecognizedPerDay)errors.push({key:'unrecognizedPerPayment',zh:'陌生收款方每笔上限不能大于陌生收款方每天上限'});
  if(Object.values(v).some(x=>x>BigInt(LARGE_USDC)*1000000n))warnings.push(`金额较大。这个钱包完全由 AI 控制，请只放少量资金。`);
  return {ok:!errors.length,errors,warnings,values:v};}
