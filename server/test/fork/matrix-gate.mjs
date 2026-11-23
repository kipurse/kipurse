// t1150u / handbook 0A#6 + 0A#7: install/deploy gate for the fork flow matrix. Exit 0 ONLY when the report is complete and every step passed,
// including the three duplicate-protection cases. Usage: node test/fork/matrix-gate.mjs <matrix-report.json> [minSteps]
import fs from 'node:fs';import {createHash} from 'node:crypto';
const f=process.argv[2],min=Number(process.argv[3]??149);const raw=fs.readFileSync(f);const R=JSON.parse(raw);const steps=R.steps??[];
const need=[/^DUP-1 same request resent/,/^DUP-2 same merchant \+ orderRef \+ amount paid again with a NEW Idempotency-Key/,/^DUP-3 same deposit \(tx:logIndex\) rescanned/];
// t1166u / handbook §6#80 (PERMANENT LOCKED RULE, mandatory before every deploy): AI-facing amounts must be human-ready USDC. Never remove these.
const needAmounts=[/^§6#80 every MCP tool description says amounts are already USDC/,/^§6#80 balance headline: wallet_status usdc = chain balance in USDC/,/^§6#80 all [0-9]+ mcp answers collected in this run/,/^§6#80 all [0-9]+ siri answers collected in this run/,/^§6#80 the 1 USDC AI payment answer/];
// t1170u / handbook §6#82 (locked): the owner-ask flow (new payee above an AI auto limit) must be proven end to end before every deploy. Never remove these.
const needAsk=[/^ASK stopped AI: new payee over its limit -> AGENT_STOPPED/,/^new payee 3 USDC > AI per-payment 2 -> ask_owner/,/^AI-faked "认识"/,/^认识并信任 -> paid 3 USDC once/,/^trusted payee: next 1 USDC/,/^只付这一次 -> paid 3 USDC once/,/^only once: the next payment to the same payee asks again/,/^double approval -> already handled/,/^6 USDC > wallet per-payment 5 -> refuse OVER_WALLET_LIMIT/,/^24 h expiry -> approval refused/,/^§6#82 ask answers keep the §6#80 amount rule/];
// t1197u / handbook §6#92: new wallets on V5.3, existing wallets stay V5.2 - both must be proven in the run.
const needSuite=[/^§6#92 NEW wallet opened on V5\.3/,/^§6#92 existing wallet stays on V5\.2/];
// t1204 / handbook §6#93: AI-filled merchant orders (missing-field refusal, AI-supplied fields paid once, first-bid route, secrets never stored/logged/echoed). Never remove these.
const needOrder=[/^§6#93 missing order fields -> refuse/,/^§6#93 AI-supplied fields/,/^§6#93 status follow-up used the AI token/,/^§6#93 the AI token is not in the answer/,/^§6#93 same merchantPurchaseId again -> no second charge/,/^§6#93 merchant refusal that echoes the AI token -> redacted/,/^§6#93 no-listing first bid/,/^§6#93 AI secrets never stored/,/^§6#93 AI secrets never logged/];
const bad=[];if(R.ok!==true)bad.push('run did not reach the end (R.ok!==true)');if(!R.fork||R.chainId!==8453)bad.push('not a Base(8453) fork run');
const failed=steps.filter(s=>!s.ok);if(failed.length)bad.push(failed.length+' failed: '+failed.map(s=>s.user+' '+s.step).join(' | '));
if(steps.length<min)bad.push(`only ${steps.length} steps (< ${min})`);
for(const re of need){const s=steps.filter(x=>re.test(x.step));if(s.length!==1||!s[0].ok)bad.push('missing or failed: '+re);}
for(const re of needAmounts){const s=steps.filter(x=>re.test(x.step));if(s.length!==1||!s[0].ok)bad.push('§6#80 AI amount check missing or failed: '+re);}
for(const re of needSuite){const s=steps.filter(x=>re.test(x.step));if(s.length!==1||!s[0].ok)bad.push('§6#92 suite check missing or failed: '+re);}
for(const re of needAsk){const s=steps.filter(x=>re.test(x.step));if(s.length!==1||!s[0].ok)bad.push('§6#82 owner-ask check missing or failed: '+re);}
for(const re of needOrder){const s=steps.filter(x=>re.test(x.step));if(s.length!==1||!s[0].ok)bad.push('§6#93 merchant-order check missing or failed: '+re);}
const amt=steps.filter(x=>/^§6#80 /.test(x.step));if(amt.length<10)bad.push('§6#80 AI amount checks: only '+amt.length+' (< 10)');
const out={gate:bad.length?'FAIL':'PASS',steps:steps.length,amountRule:amt.length>=10&&amt.every(x=>x.ok),amountChecks:amt.length,askRule:needAsk.every(re=>steps.some(x=>re.test(x.step)&&x.ok)),passed:steps.length-failed.length,failed:failed.length,report:f,reportSha256:createHash('sha256').update(raw).digest('hex'),problems:bad,at:new Date().toISOString()};
console.log(JSON.stringify(out,null,1));process.exit(bad.length?1:0);
