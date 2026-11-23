/**
 * t1213 (handbook §6#99 / §6#100): V5.4 signed-merchant auto-pay, OFF unless KIPURSE_V54_SIGNER_TRUST=1 AND the wallet's suite is V5.4.
 * Nothing here is wired into today's payment paths: the owner's V5.2 wallet behaves exactly as before.
 *
 * Owner decision (2026-11-19 21:20 CT): a merchant the owner trusted once, whose order carries a valid merchant signature from the
 * signer the merchant publishes on its own verified https origin, is not a "new payee" for each per-order deposit address.
 * The decision below returns {route:'auto'} ONLY when every check passes; anything else returns {route:'card', reason} (today's
 * Face ID card). The impersonation warning is only for a missing / wrong signer (reason signer_*), never for a fresh deposit address.
 * The chain re-checks everything again (KipurseAdapterV54.paySignedTrusted): signature, chain / adapter / payer, deadline, orderId
 * replay, grant signature + epoch (owner revoke), deny lists, pause, caps. Sanctions / scam screening of the deposit address stays
 * in the engine (unchanged) and runs before this.
 */
import {recoverTypedDataAddress,encodeFunctionData,parseAbi,getAddress,isAddress,encodeAbiParameters,encodePacked,keccak256,toBytes} from 'viem';

export const FLAG = 'KIPURSE_V54_SIGNER_TRUST';
export const enabled = (env = process.env) => String(env?.[FLAG] ?? '') === '1';
const lc = a => String(a ?? '').toLowerCase();
const ORDER_TYPES = {PaymentOrder: [{name: 'payee', type: 'address'}, {name: 'amount', type: 'uint256'}, {name: 'orderId', type: 'bytes32'},
  {name: 'deadline', type: 'uint256'}, {name: 'chainId', type: 'uint256'}, {name: 'adapter', type: 'address'}, {name: 'payer', type: 'address'}]};
/** exampleshop publishes "EIP-712 AgentWalletPaymentOrder v5" (capabilities usdcPayments.signedOrder): domain name/version below. */
export const orderDomain = ({adapter, chainId}) => ({name: 'AgentWalletPaymentOrder', version: '5', chainId: Number(chainId), verifyingContract: getAddress(adapter)});

export const V54_ABI = parseAbi([
  'struct SpendPermission { address account; address spender; address token; uint160 allowance; uint48 period; uint48 start; uint48 end; uint256 salt; bytes extraData; }',
  'struct PaymentOrder { address payee; uint256 amount; bytes32 orderId; uint256 deadline; uint256 chainId; address adapter; address payer; }',
  'function paySignedTrusted(SpendPermission p, PaymentOrder o, bytes signature, bytes ownerSignerTrust, uint256 networkFee, uint48 txDeadline)',
  'function orderDigest(PaymentOrder o) view returns (bytes32)',
  'function orderUsed(address signer, bytes32 orderId) view returns (bool)',
  'function purchaseUsed(address account, bytes32 key) view returns (bool)',
  'function signedPurchaseKey(bytes32 merchant, bytes32 orderId) pure returns (bytes32)',
  'function trust() view returns (address)']);
export const TRUST_V54_ABI = parseAbi([
  'struct SignerTrust { bytes32 merchant; string name; address[] signers; uint160 single; uint160 daily; uint64 expiry; }',
  'function signerTrustStructHash(address account, SignerTrust t, bytes32 nonce, uint256 deadline) view returns (bytes32)',
  'function ownerDigest(bytes32 structHash) view returns (bytes32)',
  'function trustOf(address account, bytes32 merchant) view returns (uint64 epoch, uint64 expiry, bool active, uint160 single, uint160 daily)',
  'function deniedSigner(address account, address signer) view returns (bool)']);
const GRANT_PARAMS = [{type: 'tuple', components: [{name: 'merchant', type: 'bytes32'}, {name: 'name', type: 'string'}, {name: 'signers', type: 'address[]'},
  {name: 'single', type: 'uint160'}, {name: 'daily', type: 'uint160'}, {name: 'expiry', type: 'uint64'}]}, {type: 'bytes32'}, {type: 'uint256'}, {type: 'bytes'}];

/** merchant id = keccak256(origin host), the same string the owner sees on the card ("shop.example"). */
export const merchantName = origin => new URL(String(origin)).hostname.toLowerCase();
export const merchantId = name => keccak256(toBytes(String(name)));

/** The signer the merchant publishes on its OWN verified https origin (capabilities.merchant.expectedSigner, origin must match). */
export function publishedSigner(caps, verifiedOrigin) {
  const m = caps?.merchant; if (!m || !isAddress(String(m.expectedSigner ?? ''))) return null;
  let o, v; try { o = new URL(String(m.origin)); v = new URL(String(verifiedOrigin)); } catch { return null; }
  if (o.protocol !== 'https:' || v.protocol !== 'https:' || o.host.toLowerCase() !== v.host.toLowerCase()) return null;
  return getAddress(m.expectedSigner);
}

/** exampleshop UsdcSignedOrder DTO (openapi components.schemas.UsdcSignedOrder, dtoVersion exampleshop.usdc-deposit-order.v1) -> chain struct. */
export function normalizeSignedOrder(so) {
  if (!so || so.available !== true) return {ok: false, code: so?.reason ? 'signed_order_unavailable:' + String(so.reason).slice(0, 40) : 'signed_order_missing'};
  for (const k of ['signer', 'payee', 'adapter']) if (!isAddress(String(so[k] ?? ''))) return {ok: false, code: 'signed_order_bad_' + k};
  if (!/^0x[0-9a-fA-F]{64}$/.test(String(so.orderId ?? ''))) return {ok: false, code: 'signed_order_bad_orderId'};
  if (!/^0x[0-9a-fA-F]{130}$/.test(String(so.signature ?? ''))) return {ok: false, code: 'signed_order_bad_signature'};
  if (!/^[0-9]+$/.test(String(so.amountAtomic ?? '')) || !Number.isSafeInteger(Number(so.orderDeadline)) || !Number.isSafeInteger(Number(so.chainId))) return {ok: false, code: 'signed_order_bad_fields'};
  const payer = so.payer && isAddress(String(so.payer)) ? getAddress(so.payer) : '0x0000000000000000000000000000000000000000';
  return {ok: true, claimedSigner: getAddress(so.signer), signature: so.signature,
    order: {payee: getAddress(so.payee), amount: BigInt(so.amountAtomic), orderId: so.orderId, deadline: BigInt(so.orderDeadline),
      chainId: BigInt(so.chainId), adapter: getAddress(so.adapter), payer}};
}
export const recoverOrderSigner = ({order, signature}) =>
  recoverTypedDataAddress({domain: orderDomain({adapter: order.adapter, chainId: order.chainId}), types: ORDER_TYPES, primaryType: 'PaymentOrder', message: order, signature});

/** Owner grants (one per wallet + merchant), stored as the exact bytes the phone signed; revocation is on chain (untrust / deny). */
export function createGrantStore(kv, {now = () => Date.now()} = {}) {
  const key = (w, m) => `v54grant:${lc(w)}:${lc(m)}`;
  return {
    put(g) { const r = {wallet: getAddress(g.wallet), merchant: g.merchant, name: g.name, signers: g.signers.map(getAddress), single: String(g.single),
      daily: String(g.daily), expiry: Number(g.expiry), grant: g.grant, at: now()}; kv.set(key(r.wallet, r.merchant), JSON.stringify(r));
      for (const sg of r.signers) kv.set(`v54grant-s:${lc(r.wallet)}:${lc(sg)}`, r.merchant);
      /* t1241 §6#111: index of this wallet's grants (the app's trusted-merchants list) */
      try { const ik = `v54grant-list:${lc(r.wallet)}`; const l = (() => { try { return JSON.parse(kv.get(ik) ?? '[]'); } catch { return []; } })(); if (!l.includes(lc(r.merchant))) { l.push(lc(r.merchant)); kv.set(ik, JSON.stringify(l.slice(-200))); } } catch {}
      return r; },
    list(w) { let l = []; try { l = JSON.parse(kv.get(`v54grant-list:${lc(w)}`) ?? '[]'); } catch { l = []; } return l.map(m => this.get(w, m)).filter(Boolean); },
    bySigner(w, signer) { const m = kv.get(`v54grant-s:${lc(w)}:${lc(signer)}`); if (!m) return null; const g = this.get(w, m); return g && g.signers.map(lc).includes(lc(signer)) ? g : null; },
    get(w, m) { const s = kv.get(key(w, m)); return s ? JSON.parse(s) : null; },
    drop(w, m) { kv.delete?.(key(w, m)); }};
}
export function encodeGrant({merchant, name, signers, single, daily, expiry}, nonce, deadline, ownerSig) {
  return encodeAbiParameters(GRANT_PARAMS, [{merchant, name, signers, single: BigInt(single), daily: BigInt(daily), expiry: BigInt(expiry)}, nonce, BigInt(deadline), ownerSig]);
}

/**
 * The decision. Inputs come from the engine: the merchant's order response (paymentRequest + signedOrder DTO) fetched from the
 * merchant's verified origin, its capabilities, the wallet, the V5.4 adapter, the stored owner grant and the owner's live everyday
 * limits (single, left today; atomic USDC). orderUsed: optional on-chain read (replay is also refused by the chain and the ledger).
 */
export async function decide({env = process.env, suite, wallet, adapter, chainId, nowS, origin, caps, paymentRequest, signedOrder, grant,
  everyday, feeFor = a => (a * 1000n + 999_999n) / 1_000_000n, orderUsed}) {
  const card = (reason, extra = {}) => ({route: 'card', reason, ...extra});
  if (!enabled(env)) return card('flag_off');
  if (suite !== 'v5.4' && !(suite === 'v5.5' && String(env?.KIPURSE_V55 ?? '').trim() === '1')) return card('suite_not_v54');   // t1250: V5.5 keeps the V5.4 grant model (flag only)
  const n = normalizeSignedOrder(signedOrder); if (!n.ok) return card(n.code);
  const o = n.order;
  // 1) the signer: recovered == claimed == the one the merchant publishes on its verified origin
  const pub = publishedSigner(caps, origin); if (!pub) return card('signer_unpublished', {warn: true});
  let rec; try { rec = getAddress(await recoverOrderSigner({order: o, signature: n.signature})); } catch { return card('signer_bad_signature', {warn: true}); }
  if (rec !== n.claimedSigner) return card('signer_mismatch', {warn: true});
  if (rec !== pub) return card('signer_not_published', {warn: true});
  // 2) the order: this chain, this V5.4 adapter, bound to THIS wallet, same payee / amount / expiry as the merchant's payment request
  if (Number(o.chainId) !== Number(chainId) || lc(o.adapter) !== lc(adapter)) return card('order_domain_mismatch');
  if (lc(o.payer) !== lc(wallet)) return card(o.payer === '0x0000000000000000000000000000000000000000' ? 'order_payer_unbound' : 'order_for_other_payer');
  if (!paymentRequest || lc(paymentRequest.depositAddress) !== lc(o.payee) || String(paymentRequest.amountAtomic) !== o.amount.toString()) return card('order_mismatch_payment_request');
  if (paymentRequest.expiresAt != null && o.deadline > BigInt(paymentRequest.expiresAt)) return card('order_mismatch_payment_request');
  if (o.deadline <= BigInt(nowS) + 60n) return card('order_expired');
  if (orderUsed && await orderUsed(rec, o.orderId)) return card('order_already_paid');
  // 3) the owner's grant for this merchant + signer, still within its expiry
  const name = merchantName(origin), m = merchantId(name);
  if (!grant || lc(grant.wallet) !== lc(wallet) || lc(grant.merchant) !== lc(m) || !grant.signers.map(lc).includes(lc(rec))) return card('signer_not_trusted');
  if (Number(grant.expiry) <= Number(nowS) + 60) return card('grant_expired');
  // 4) caps: grant single, owner's everyday single and what is left today (amount + fee); the chain re-checks grant daily + policy
  const fee = feeFor(o.amount);
  if (o.amount > BigInt(grant.single)) return card('over_trust_single');
  if (everyday?.single != null && o.amount > BigInt(everyday.single)) return card('over_everyday_single');
  if (everyday?.leftToday != null && o.amount + fee > BigInt(everyday.leftToday)) return card('over_everyday_today');
  return {route: 'auto', merchant: m, name, signer: rec, order: o, signature: n.signature, grant: grant.grant};
}

export function encodePaySignedTrusted({permission, order, signature, grant, networkFee = 0n, txDeadline}) {
  return encodeFunctionData({abi: V54_ABI, functionName: 'paySignedTrusted', args: [permission, order, signature, grant, BigInt(networkFee), Number(txDeadline)]});
}

/* t1214: the phone's kind-5 approval (KipursePhoneApproverV4.KIND_SIGNER_TRUST), wrapped for the Coinbase Smart Wallet:
   SignatureWrapper(ownerIndex, abi.encode(uint8 5, abi.encode(SignerTrust, nonce, deadline), r, s)). */
const ST_T = {type: 'tuple', components: [{name: 'merchant', type: 'bytes32'}, {name: 'name', type: 'string'}, {name: 'signers', type: 'address[]'},
  {name: 'single', type: 'uint160'}, {name: 'daily', type: 'uint160'}, {name: 'expiry', type: 'uint64'}]};
const stOf = m => ({merchant: m.merchant, name: m.name, signers: m.signers.map(getAddress), single: BigInt(m.single), daily: BigInt(m.daily), expiry: BigInt(m.expiry)});
export function phoneSignerTrustWrapper(ownerIndex, m, r, s) {
  const body = encodeAbiParameters([ST_T, {type: 'bytes32'}, {type: 'uint256'}], [stOf(m), m.nonce, BigInt(m.deadline)]);
  const data = encodeAbiParameters([{type: 'uint8'}, {type: 'bytes'}, {type: 'uint256'}, {type: 'uint256'}], [5, body, BigInt(r), BigInt(s)]);
  return encodeAbiParameters([{type: 'tuple', components: [{name: 'ownerIndex', type: 'uint256'}, {name: 'signatureData', type: 'bytes'}]}], [{ownerIndex: BigInt(ownerIndex), signatureData: data}]);
}
const TRUST_V54_VIEWS = parseAbi(['function signerTrustStructHash(address account,(bytes32 merchant,string name,address[] signers,uint160 single,uint160 daily,uint64 expiry) t,bytes32 nonce,uint256 deadline) view returns (bytes32)',
  'function ownerDigest(bytes32 structHash) view returns (bytes32)', 'function trustOf(address,bytes32) view returns (uint64 epoch,uint64 expiry,bool active,uint160 single,uint160 daily)']);
/** KipurseTrustV54.signerTrustStructHash, computed for a given epoch (the contract's view only knows the current one). */
const SIGNER_TRUST_TYPEHASH = keccak256(toBytes('OwnerSignerTrust(address account,bytes32 merchant,string name,uint64 epoch,address[] signers,uint160 single,uint160 daily,uint64 expiry,bytes32 nonce,uint256 deadline)'));
export function signerTrustStructHashLocal(account, t, epoch, nonce, deadline) {
  return keccak256(encodeAbiParameters([{type: 'bytes32'}, {type: 'address'}, {type: 'bytes32'}, {type: 'bytes32'}, {type: 'uint64'}, {type: 'bytes32'}, {type: 'uint160'}, {type: 'uint160'}, {type: 'uint64'}, {type: 'bytes32'}, {type: 'uint256'}],
    [SIGNER_TRUST_TYPEHASH, account, t.merchant, keccak256(toBytes(t.name)), BigInt(epoch), keccak256(encodePacked(['address[]'], [t.signers])), BigInt(t.single), BigInt(t.daily), BigInt(t.expiry), nonce, BigInt(deadline)]));
}
/** The trust-card hook (trust-approve-public.mjs phone-prepare / phone-sign): kind-5 grant from the kind-1 trust message, same Face ID. */
export function createSignerGrantHook({pub, trust, wallet, store, nowS = () => Math.floor(Date.now() / 1000), randomNonce}) {
  return {
    /** from the kind-1 trust message the phone is about to sign: same merchant / name / signers / caps / expiry; fresh nonce, deadline = expiry */
    async fromTrust(tm) {
      const signers = (tm.signers ?? []).map(getAddress); if (!signers.length) return null;
      const t = {merchant: tm.merchant, name: tm.name, signers, single: BigInt(tm.single), daily: BigInt(tm.daily), expiry: BigInt(tm.expiry)};
      if (merchantId(t.name) !== String(t.merchant).toLowerCase() && merchantId(t.name) !== t.merchant) return null;
      const nonce = randomNonce(), deadline = t.expiry;
      const [ep] = await pub.readContract({address: trust, abi: TRUST_V54_VIEWS, functionName: 'trustOf', args: [getAddress(wallet), t.merchant]});
      /* t1240 §6#110: the grant is bound to the merchant's trust EPOCH, and the kind-1 trust signed in the same Face ID bumps that epoch by one when it
         lands (setTrust: epoch + 1). A grant for the current epoch is therefore dead the moment the trust lands (fork: Approval() revert on the 2nd order).
         Sign it for epoch + 1: check our local struct hash equals the contract's at the current epoch, then hash the next epoch the same way. */
      const local = e => signerTrustStructHashLocal(getAddress(wallet), t, BigInt(e), nonce, deadline);
      const shNow = await pub.readContract({address: trust, abi: TRUST_V54_VIEWS, functionName: 'signerTrustStructHash', args: [getAddress(wallet), t, nonce, deadline]});
      if (String(shNow).toLowerCase() !== local(ep).toLowerCase()) return null;
      const next = BigInt(ep) + 1n, sh = local(next);
      const digest = await pub.readContract({address: trust, abi: TRUST_V54_VIEWS, functionName: 'ownerDigest', args: [sh]});
      return {digest, message: {account: getAddress(wallet), merchant: t.merchant, name: t.name, epoch: String(next), signers, single: String(t.single), daily: String(t.daily), expiry: String(t.expiry), nonce, deadline: String(deadline)}};
    },
    wrapper: phoneSignerTrustWrapper,
    store(m, wrapper) { return store.put({wallet, merchant: m.merchant, name: m.name, signers: m.signers, single: m.single, daily: m.daily, expiry: Number(m.expiry),
      grant: encodeGrant(stOf(m), m.nonce, BigInt(m.deadline), wrapper)}); },
  };
}
