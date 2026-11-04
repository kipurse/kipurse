// SPDX-License-Identifier: Apache-2.0
export type PaymentRequest =
  | { status: number; headers?: Record<string, string>; body?: unknown; url?: string }
  | { uri: string }
  | { direct: { chainId: number; token: string; payee: string; amount: string; merchantOrderId: string } }
  | { signedOrder: Record<string, unknown> }
  | { coinbaseCheckout: Record<string, unknown> }
  | { stripePaymentIntent: Record<string, unknown> };
export interface Preflight { canPay: boolean; reasons: string[]; needsOwnerApproval: boolean; tier: string; merchant: string | null; amount: string;
  fee: { protocolAtomic: string; note: string }; gas: { units: string | null; wei: string | null; sponsored: string }; remainingAfter: Record<string, string | null>;
  purchaseKey: string | null; existing: { state: string; paidBy: string } | null; simulation: string | null; next?: { tool: string; url: string } }
/** state 'retry_later' (reason 'gas_spike' | 'tx_in_flight') = nothing was sent; retry after retryAfterSec.
 *  V5 amounts are atomic USDC strings: total = amount + fee (0.1%, rounded up) + networkFee (gas quote + gasRecovery). */
export interface PayResult { state: string; purchaseKey?: string; txHash?: string; reason?: string; paidBy?: string; body?: string;
  amount?: string; fee?: string; networkFee?: string; gasRecovery?: string; total?: string; retryAfterSec?: number; via?: "float"; [k: string]: unknown }
export class KipurseError extends Error { status: number; body: unknown }
export function newIdempotencyKey(prefix?: string): string;
export class KipurseClient {
  constructor(o: { baseUrl: string; token?: string; agentId?: string; fetch?: typeof fetch });
  status(): Promise<Record<string, unknown>>;
  limits(): Promise<Record<string, unknown>>;
  parse(request: PaymentRequest, o?: { intentId?: string; repeatKey?: string }): Promise<Record<string, unknown>>;
  preflight(input: PaymentRequest | { parsedId: string }, o?: { intentId?: string; repeatKey?: string }): Promise<Preflight>;
  pay(o: { request?: PaymentRequest; parsedId?: string; intentId?: string; repeatKey?: string; maxAmount?: string; ownerApproval?: OwnerApproval; idempotencyKey?: string }): Promise<PayResult>;
  payAny(o:{payment:string|Record<string,unknown>;merchant?:string;orderRef?:string;expiresAt?:number|string;allowSameAmount?:boolean;signedOrderUrl?:string;intentId?:string;repeatKey?:string;maxAmount?:string;ownerApproval?:{signature:string;deadline:string|number};idempotencyKey?:string}):Promise<any>;
  parseAny(o:{payment:string|Record<string,unknown>;merchant?:string;orderRef?:string;expiresAt?:number|string;intentId?:string;repeatKey?:string}):Promise<any>;
  setup(o?:{answers?:Record<string,unknown>}):Promise<any>;
  setLimits(o:{changes:Record<string,string>}):Promise<any>;
  proposeTrust(o:{payee?:string;domain?:string;reason:string;single:string;daily:string}):Promise<any>;
  trustList():Promise<any>;
  depositInfo():Promise<any>;
  deposits():Promise<any>;
  requestWithdrawal(o:{amount:string}):Promise<any>;
  executeWithdrawal(o:{withdrawalId:string}):Promise<any>;
  payMerchantOrder(o:{origin:string;orderParams?:Record<string,unknown>;merchantPurchaseId:string;signedOrder?:boolean;intentId?:string;repeatKey?:string;maxAmount?:string;idempotencyKey?:string}):Promise<any>;
  discoverMerchant(origin:string):Promise<any>;
  paidFetch(o: { url: string; method?: 'GET' | 'POST'; headers?: Record<string, string>; body?: string; intentId?: string; repeatKey?: string; maxAmount?: string; idempotencyKey?: string }): Promise<PayResult>;
  claimPurchase(o: { intentId: string; lineKey: string; ttlSec?: number; note?: string }): Promise<{ won: boolean; owner: string; leaseUntil: number }>;
  merchantInfo(q?: { payee?: string; domain?: string; merchantId?: string; signer?: string }): Promise<Record<string, unknown>>;
  listPurchases(q?: { since?: number; state?: string; mine?: 0 | 1; limit?: number }): Promise<Record<string, unknown>[]>;
  getPurchase(key: string): Promise<Record<string, unknown>>;
  // V5 mode
  approvalRequest(input: PaymentRequest | { parsedId: string }, o?: { intentId?: string; repeatKey?: string }): Promise<OwnerRequest>;
  trustRequest(o: { merchantId: string; payees: string[]; signers?: string[]; single: string; daily?: string; expiresInDays?: number }): Promise<OwnerRequest>;
  /** trust.name is the human-readable merchant name; trust.merchant = keccak256(name). */
  requestTrustFromOwner(o: { merchantName: string; payee: string; chain?: string; single: string; total?: string; expiresInDays?: number; reason: string }): Promise<{ id: string; status: string; idempotent: boolean }>;
  trustRequestStatus(o: { id: string }): Promise<{ id: string; status: string }>;
  untrustRequest(o: { merchantId: string }): Promise<OwnerRequest>;
  untrustSubmit(o: { merchant: string; nonce: string; deadline: string; signature: string }): Promise<{ state: string; txHash: string }>;
  denySignerRequest(o: { signer: string }): Promise<OwnerRequest>;
  denySignerSubmit(o: { signer: string; nonce: string; deadline: string; signature: string }): Promise<{ state: string; txHash: string }>;
  exitPlan(): Promise<ExitPlan>;
  recordGasSettlement(txHash: string): Promise<{ state: 'recorded' | 'already_recorded' | 'rejected'; paid?: string; applied?: string; outstanding?: string; reason?: string }>;
  pause(): Promise<{ state: string; txHash: string }>;
  settleRoutine(): Promise<Array<{ key: string; digest: string; state: string; txHash?: string }>>;
  exportCsv(o?: { from?: string; to?: string; tz?: string }): Promise<{ csv: string; rows: number }>;
  receipt(purchaseKey: string, o?: { tz?: string }): Promise<Receipt | { state: 'not_found'; purchaseKey: string }>;
  annualSummary(year?: number, o?: { tz?: string }): Promise<AnnualSummary>;
  floatStatus(): Promise<FloatStatus>;
  floatFund(o?: { amount?: string; hours?: number }): Promise<{ state: 'funded' | 'rejected' | 'retry_later'; reason?: string; txHash?: string; floatVault?: string; amount?: string; feeReserve?: string; networkFee?: string; expiry?: number }>;
  floatReconcile(): Promise<{ state: 'reconciled' | 'waiting' | 'nothing_open' | 'retry_later'; txHash?: string; expiry?: number }>;
  collectFees(): Promise<{ state: 'collected' | 'nothing_to_collect'; amount?: string; txHash?: string }>;
}
export interface OwnerApproval { signature: string; deadline: string }
export interface OwnerRequest { ok: boolean; action?: string; typedData?: Record<string, unknown>; digest?: string; nonce?: string; deadline?: string; ownerDirectCall?: { to: string; data: string }; [k: string]: unknown }
/** V5 preflight: amount + 0.1% protocol fee + network fee (actual gas, never subsidized) and per-cap headroom.
 *  Per-payment caps count the amount; daily / term caps count the total. */
export interface PreflightV5 extends Omit<Preflight, 'fee' | 'remainingAfter'> { quote: { amount: string; fee: string; networkFee: string; gasQuote: string | null; gasRecovery: string; total: string; feePpm: string; feePercent: number; maxNetworkFee: string };
  fee: { protocolAtomic: string }; maxPayable: { overall: string; byCap: Record<string, { limit: string; used: string; remaining: string; maxPayable: string }> }; merchantRef: string | null }
export function wrapFetch(client: KipurseClient, o?: { maxAmount?: string; intentId?: string; repeatKey?: string }): (url: string | URL, init?: RequestInit) => Promise<Response>;

export interface FloatStatus { cap: string; open: boolean; funded: string; expiry: number; floatVault: string; balance: string;
  session: { session: string; floatVault: string; expiry: number; funded: string } | null; committed: string; thresholdAtomic: string }
export interface Receipt { state: 'ok'; receiptNo: string; purchaseKey: string; type: string; date: string; dateUtc: string; payer: string | null; merchant: string | null; payee: string;
  amount: string; protocolFee: string; networkFee: string; gasRecovery: string; total: string; refund: string; currency: 'USDC'; txHash: string | null; txUrl: string | null;
  settlementTx: string | null; settlementUrl: string | null; note: string; text: string }
export interface SummaryBucket { count: number; amount: string; protocolFee: string; networkFee: string; total: string; refunds: string }
export interface AnnualSummary { year: number; timeZone: string; currency: 'USDC'; totals: SummaryBucket; byMonth: Record<string, SummaryBucket>; byMerchant: Record<string, SummaryBucket>; byType: Record<string, SummaryBucket>; note: string }
export interface ExitPlan { WARNING: string; chainId: number; wallet: string; calls: Array<{ label: string; to: string; value: string; data: string }>; walletExecuteBatch: { to: string; data: string }; note: string;
  settleGasDebt: null | { optional: true; separateSignature: true; amount: string; recipient: string; token: string; label: string; calls: Array<{ label: string; to: string; value: string; data: string }>; walletExecute: { to: string; data: string }; note: string } }
