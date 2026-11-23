// Strict TypeScript consumer of @kipurse/sdk (compiled with tsc --noEmit --strict in the test suite; never run against a live wallet).
import { KipurseClient, KipurseError, newIdempotencyKey, wrapFetch, type PayResult, type Preflight, type Receipt, type AnnualSummary, type FloatStatus } from '../src/index.js';

export async function demo(baseUrl: string): Promise<string[]> {
  const kp = new KipurseClient({ baseUrl, agentId: 'research-agent' });
  const out: string[] = [];
  const req = { direct: { chainId: 84532, token: '0x036CbD53842c5426634e7929541eC2318f3dCF7e', payee: '0xaC3c14a42628EAA726DCF3560c97F4cB4F4Bd521', amount: '20000', merchantOrderId: 'o-1' } };
  const pf: Preflight = await kp.preflight(req, { intentId: 'team-1' });
  if (!pf.canPay) out.push('blocked: ' + pf.reasons.join(','));
  const r: PayResult = await kp.pay({ request: req, intentId: 'team-1', idempotencyKey: newIdempotencyKey('pay') });
  if (r.state === 'retry_later') out.push(`retry in ${r.retryAfterSec ?? 60}s`);
  else out.push(`${r.state} total=${r.total ?? '?'} fee=${r.fee ?? '?'} gas=${r.networkFee ?? '?'}`);
  const f: PayResult = await kp.paidFetch({ url: 'https://api.example/report', maxAmount: '100000' });
  if (f.via === 'float') out.push('paid from the daily float');
  const fl: FloatStatus = await kp.floatStatus(); out.push(`float ${fl.balance}/${fl.cap}`);
  const csv = await kp.exportCsv({ from: '2026-01-01', tz: 'America/Chicago' }); out.push(`csv rows ${csv.rows}`);
  if (r.purchaseKey) { const rc = await kp.receipt(r.purchaseKey); if (rc.state === 'ok') out.push((rc as Receipt).text); }
  const y: AnnualSummary = await kp.annualSummary(2026); out.push(`year total ${y.totals.total}`);
  const fees = await kp.collectFees(); out.push(fees.state);
  const tr = await kp.trustRequest({ merchantId: 'shop.example', payees: ['0x3444AA8eD2716e0F60483E02DEC8EDaB7B2E94d3'], single: '1000000' }); out.push(String(tr.digest));
  const paidFetch = wrapFetch(kp, { maxAmount: '50000' });
  try { const res = await paidFetch('https://api.example/premium'); out.push(String(res.status)); }
  catch (e) { if (e instanceof KipurseError) out.push('refused ' + e.status); else throw e; }
  return out;
}
