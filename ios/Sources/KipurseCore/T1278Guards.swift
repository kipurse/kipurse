// SPDX-License-Identifier: Apache-2.0
import Foundation

/// t1278: small pure rules from the t1278 security review. Every one only adds refusals (or keeps the calmer "not confirmed yet" state).

// MARK: A1 - a request known only from a push never signs from that tap

/// A push-only card shows the push text (written by the server / AI), never the request the phone would sign. Tapping Approve there only
/// signs in (one Face ID, held <= 60 s for THIS request) and reloads: the card then re-renders from the server's real request (its own
/// lines parsed on the phone from signText), and the owner approves on that full card. The held Face ID may be reused by that tap.
public enum PushedApproval {
  public enum Next: Equatable { case showFullCard, reject }
  /// What the push card's tap does once the server's request is loaded. Approve NEVER signs here; Decline (safe) rejects.
  public static func next(approve: Bool) -> Next { approve ? .showFullCard : .reject }
  /// The sign-in's held Face ID is bound to this request, any choice ("<id>|*"); the full card's Approve takes it as "<id>|approve".
  public static func heldTag(id: String) -> String { id + "|*" }
  public static func approveTag(id: String) -> String { id + "|approve" }
}

// MARK: A3 - a merchant-signer grant only for the domain the card shows

public enum SignerGrantDomain {
  /// The trust card may sign a merchant-signer grant ONLY for the domain it shows ("Trust <domain> ..."): the card must show a domain
  /// (OwnerAsk.domainTrustLine) and the grant's merchant must be that same host (case-insensitive). No domain shown -> no grant.
  public static func ok(cardDomain: String?, merchant: String) -> Bool {
    guard let d = cardDomain, OwnerAsk.domainTrustLine(domain: d, merchantSigned: nil) != nil else { return false }
    func host(_ h: String) -> String { var t = h.trimmingCharacters(in: .whitespaces).lowercased(); if t.hasSuffix(".") { t.removeLast() }; return t }
    let m = host(merchant)
    return !m.isEmpty && m == host(d)
  }
  /// The trust sheet shows the grant's own name; it must be a plain domain the owner can read (same rule as the card's domain line).
  public static func shownNameOK(_ name: String) -> Bool { OwnerAsk.domainTrustLine(domain: name, merchantSigned: nil) != nil }
}

// MARK: A4 - "arrived" only when the phone sees it on chain

/// t1279 (R14): what the phone read on chain (two agreeing nodes) when a purchase started: the wallet's USDC balance and the chain head.
/// One purchase at a time; it goes stale after `maxAge` (an abandoned purchase's baseline is never reused for a later one).
public struct OnrampBaseline: Equatable {
  public let balance: Int64?
  /// Two-node agreed head when the purchase started (nil = not read: the tx path can't confirm anything).
  public let block: Int64?
  public let at: Date
  public init(balance: Int64?, block: Int64?, at: Date = Date()) { self.balance = balance; self.block = block; self.at = at }
  public static let maxAge: TimeInterval = 3 * 3600
  public func fresh(now: Date = Date()) -> Bool { now >= at && now.timeIntervalSince(at) <= Self.maxAge }
  /// Reads both from the chain. Head: the first two answering nodes must be within `maxHeadSkew` blocks; the HIGHER head is kept
  /// (stricter: a tx mined before the purchase started can never count). nil fields = could not confirm.
  public static let maxHeadSkew: Int64 = 30
  public static func read(wallet: String, nodes: [URL] = ChainRPC.nodes, balance: OnrampChainConfirm.BalanceRead = OnrampChainConfirm.agreedBalance) async -> OnrampBaseline {
    let h = await agreedHeadStrict(nodes: nodes)
    let b = await balance(wallet)
    return OnrampBaseline(balance: b, block: h)
  }
  public static func agreedHeadStrict(nodes: [URL] = ChainRPC.nodes) async -> Int64? {
    var first: Int64?
    for n in nodes {
      guard let h = try? await ChainRPC.transport(n, "eth_blockNumber", []), h.hasPrefix("0x"), let v = Int64(String(h.dropFirst(2)), radix: 16), v > 0 else { continue }
      if let f = first { return abs(f - v) <= maxHeadSkew ? max(f, v) : nil }
      first = v
    }
    return nil
  }
}

public enum OnrampChainConfirm {
  /// ERC-20 Transfer(address,address,uint256)
  public static let transferTopic = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"
  static func word(_ a: String) -> String? {
    let h = a.lowercased().replacingOccurrences(of: "0x", with: "")
    guard h.count == 40, h.allSatisfy(\.isHexDigit) else { return nil }
    return "0x" + String(repeating: "0", count: 24) + h
  }
  public static func validTx(_ t: String?) -> Bool {
    guard let t, t.count == 66, t.hasPrefix("0x") else { return false }; return t.dropFirst(2).allSatisfy(\.isHexDigit) }
  /// The server's decimal amount ("4.88") in USDC base units; nil when absent / unreadable.
  public static func claimed(_ amount: String?) -> Int64? { amount.flatMap(AnswerRules.parseUSDC).flatMap { $0 > 0 ? $0 : nil } }
  /// t1279 (R14): Coinbase's fee + network fee come out of the amount: allowed gap = 5 % of it, at least 0.50 USDC.
  public static func feeTolerance(_ expected: Int64) -> Int64 { max(expected / 20, 500_000) }
  /// The tx's net USDC is within the fee tolerance of what the owner typed (never more than typed + tolerance either).
  public static func withinFee(_ net: Int64, expected: Int64) -> Bool {
    guard net > 0, expected > 0 else { return false }
    return net >= expected - feeTolerance(expected) && net <= expected + feeTolerance(expected)
  }
  /// The balance rose by at least the expected amount minus the fee tolerance (other deposits may add more; never less).
  public static func roseEnough(now: Int64, baseline: Int64, expected: Int64) -> Bool {
    guard expected > 0, now > baseline else { return false }
    let (d, o) = now.subtractingReportingOverflow(baseline); if o { return false }
    return d >= expected - feeTolerance(expected)
  }
  /// Receipt's block number (hex); nil = missing / unreadable.
  public static func blockNumber(receipt: Any) -> Int64? {
    guard let r = receipt as? [String: Any], let h = r["blockNumber"] as? String, h.hasPrefix("0x"), let v = Int64(String(h.dropFirst(2)), radix: 16), v > 0 else { return nil }
    return v
  }
  /// t1279 (R14): successful receipt: USDC moved TO `wallet` minus USDC moved FROM `wallet` in the same tx (Transfer logs of the USDC
  /// contract). nil = not a successful receipt / unreadable.
  public static func usdcNetIn(receipt: Any, wallet: String, usdc: String = VaultCheck.usdc) -> Int64? {
    guard let r = receipt as? [String: Any], (r["status"] as? String)?.lowercased() == "0x1", let logs = r["logs"] as? [Any], let me = word(wallet) else { return nil }
    var sum: Int64 = 0
    for x in logs {
      guard let l = x as? [String: Any], (l["address"] as? String)?.lowercased() == usdc.lowercased(),
            let t = (l["topics"] as? [String])?.map({ $0.lowercased() }), t.count == 3, t[0] == transferTopic, t[1] == me || t[2] == me else { continue }
      guard let v = VaultCheck.decodeUInt(l["data"] as? String ?? "") else { return nil }
      if t[1] == me && t[2] == me { continue }   // self-transfer: no net change
      let (s, o) = t[2] == me ? sum.addingReportingOverflow(v) : sum.subtractingReportingOverflow(v); if o { return nil }; sum = s
    }
    return sum
  }
  /// Receipt reduced to what is read (status + block + logs) so two nodes can be compared.
  public static func receiptCanon(_ v: Any) -> String? {
    guard let r = v as? [String: Any], let st = r["status"] as? String, let logs = r["logs"] else { return nil }
    var rows = [String]()
    guard let arr = logs as? [Any] else { return nil }
    for x in arr { guard let l = x as? [String: Any] else { return nil }
      rows.append([(l["address"] as? String ?? "").lowercased(), (l["topics"] as? [String] ?? []).map { $0.lowercased() }.joined(separator: ","), (l["data"] as? String ?? "").lowercased()].joined(separator: "|")) }
    return st.lowercased() + "|" + (r["blockNumber"] as? String ?? "").lowercased() + "\n" + rows.sorted().joined(separator: "\n")
  }
  public typealias ReceiptRead = (String) async -> Any?
  public typealias BalanceRead = (String) async -> Int64?
  public static let agreedReceipt: ReceiptRead = { tx in await ChainRPC.agreedAny("eth_getTransactionReceipt", [tx], canon: receiptCanon) }
  public static let agreedBalance: BalanceRead = { w in await VaultCheck.usdcBalanceAgreed(w) }
  /// t1279 (R14): true only when two agreeing public nodes show it, and only against a FRESH baseline read when the purchase started:
  /// - tx path (only when the owner typed the amount on this phone): the server's tx is a successful receipt mined AFTER the baseline
  ///   block, and its net USDC to `wallet` is > 0 and within the fee tolerance of the typed amount;
  /// - balance path: balance(now) - baseline balance >= expected - fee tolerance, expected = typed amount, else the amount the screen
  ///   will show ("+X USDC" from the server; never "any amount > 0").
  /// Anything else (no / stale baseline, no amount at all, nodes disagree): not arrived yet.
  public static func confirmed(wallet: String, typed: Int64?, shown: String?, txHash: String?, baseline: OnrampBaseline?, now: Date = Date(),
                               receipt: ReceiptRead = agreedReceipt, balance: BalanceRead = agreedBalance) async -> Bool {
    guard word(wallet) != nil, let base = baseline, base.fresh(now: now) else { return false }
    let typed = typed.flatMap { $0 > 0 ? $0 : nil }
    if let t = typed, let startBlock = base.block, validTx(txHash), let tx = txHash, let r = await receipt(tx),
       let bn = blockNumber(receipt: r), bn > startBlock, let net = usdcNetIn(receipt: r, wallet: wallet), withinFee(net, expected: t) { return true }
    if let expected = typed ?? claimed(shown), let b = base.balance, let nowBal = await balance(wallet), roseEnough(now: nowBal, baseline: b, expected: expected) { return true }
    return false
  }
}

public extension OnrampState {
  /// The server's "arrived" counts only once the phone confirmed it on chain; until then it is the honest "arriving" state (not final).
  func gated(chainConfirmed: Bool) -> OnrampState {
    if case .arrived(let a, _) = self, !chainConfirmed { return .arriving(amount: a) }
    return self
  }
}

// MARK: A7 - chain reads that need two agreeing nodes

public extension VaultCheck {
  /// Coinbase Smart Wallet isOwnerAddress(address), only when two public nodes give the same answer (nil = can't confirm).
  static func isOwnerAgreed(wallet: String, address: String, call: (String, String) async -> String? = { to, data in await ChainRPC.ethCall(to, data, agreed: true) }) async -> Bool? {
    guard addrCall(selIsOwnerAddress, wallet) != nil, let d = addrCall(selIsOwnerAddress, address), let r = await call(wallet, d) else { return nil }
    return decodeBool(r)
  }
}

/// The wallet safety caps the phone acts on (AILimitGate, first-connect checks) come from the chain (two-node agreed SafetyCaps.read)
/// whenever the chain gives an answer; the server's numbers are only a fallback while no chain value has been read.
public enum CapsSource {
  /// Merge a chain read: a definitive chain answer (ready / unset) replaces the server's; an unreadable one keeps what is there (last good value).
  public static func merged(_ s: WalletState, chain r: SafetyCaps.Read) -> WalletState {
    if case .unreadable = r.caps { return s }
    return s.withSafetyCaps(r.caps, start: r.start, end: r.end, source: "chain")
  }
  /// A fresh server state keeps the last chain caps of the same wallet (so the server never overrides them between two refreshes).
  public static func carry(from old: WalletState?, into new: WalletState) -> WalletState {
    guard let o = old, o.raw["capsSrc"]?.string == "chain", (o.wallet ?? "").lowercased() == (new.wallet ?? "").lowercased() else { return new }
    if case .unreadable = o.capRead { return new }
    return new.withSafetyCaps(o.capRead, start: o.raw["caps"]?["start"]?.atomic, end: o.raw["caps"]?["end"]?.atomic, source: "chain")
  }
}

// MARK: A5 - the connect card names the AI only from the signed return address
/// The AI's own "name" is whatever its client registered (anyone can call itself "Claude"). The card's name and official avatar come ONLY
/// from the return host the phone extracted from the signed redirect; an unknown host is shown as the host itself.
public enum ConnectBrand {
  public static func verified(host: String) -> String? {
    var h = host.lowercased(); if h.hasSuffix(".") { h.removeLast() }
    func on(_ d: String) -> Bool { h == d || h.hasSuffix("." + d) }
    if on("claude.ai") || on("claude.com") { return "Claude" }
    if on("cursor.com") { return "Grok" }
    if on("muse.ai") { return "Muse" }
    return nil
  }
}
