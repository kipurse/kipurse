import Foundation

/// What the phone signs for a Kipurse trust approval, computed ON THE PHONE from the fields it shows (never a blind hash from the server).
/// digest = EIP-712 OwnerTrust under domain "Kipurse Owner" v5 (verifyingContract = adapter); hash = the wallet's replay-safe hash
/// (EIP-712 CoinbaseSmartWalletMessage(bytes32 hash) under "Coinbase Smart Wallet" v1, verifyingContract = wallet).
public struct OwnerTrustMessage: Equatable {
  public var account: String, merchant: String, name: String, epoch: String, payees: [String], signers: [String]
  public var single: String, daily: String, expiry: String, nonce: String, deadline: String
  public init(account: String, merchant: String, name: String, epoch: String, payees: [String], signers: [String], single: String, daily: String, expiry: String, nonce: String, deadline: String) {
    self.account = account; self.merchant = merchant; self.name = name; self.epoch = epoch; self.payees = payees; self.signers = signers
    self.single = single; self.daily = daily; self.expiry = expiry; self.nonce = nonce; self.deadline = deadline }
}

/// t1214: the V5.4 kind-5 grant fields (no payees: the merchant's signer names the payee per order).
public struct OwnerSignerTrustMessage: Equatable {
  public var account: String, merchant: String, name: String, epoch: String, signers: [String], single: String, daily: String, expiry: String, nonce: String, deadline: String
  public init(account: String, merchant: String, name: String, epoch: String, signers: [String], single: String, daily: String, expiry: String, nonce: String, deadline: String) {
    self.account = account; self.merchant = merchant; self.name = name; self.epoch = epoch; self.signers = signers; self.single = single; self.daily = daily
    self.expiry = expiry; self.nonce = nonce; self.deadline = deadline }
}

public enum PhoneTrust {
  /// This user's wallet (from enrollment / operator config; never compiled in).
  public static var mainnetWallet: String { Operator.wallet }
  /// t1197u (§6#92): the Kipurse adapter of THIS wallet's suite (V5.2 0x0532… for 0x5150 and older wallets, V5.3 0xb150… for new ones).
  public static var mainnetAdapter: String { KipurseSuite.active.adapter }
  public static let chainId = "8453"
  static let p256n: [UInt8] = Hex.decode("FFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551")!

  /// Decimal string -> 32-byte big-endian word (nil if not a plain non-negative integer < 2^256).
  public static func u256(_ dec: String) -> [UInt8]? {
    guard !dec.isEmpty, dec.allSatisfy({ $0.isASCII && $0.isNumber }) else { return nil }
    var out = [UInt8](repeating: 0, count: 32)
    for ch in dec { var carry = Int(ch.asciiValue! - 48)
      for i in stride(from: 31, through: 0, by: -1) { let v = Int(out[i]) * 10 + carry; out[i] = UInt8(v & 0xff); carry = v >> 8 }
      if carry != 0 { return nil } }
    return out
  }
  static func addr(_ a: String) -> [UInt8]? { guard let b = Hex.decode(a), b.count == 20 else { return nil }; return [UInt8](repeating: 0, count: 12) + b }
  static func b32(_ h: String) -> [UInt8]? { guard let b = Hex.decode(h), b.count == 32 else { return nil }; return b }
  static func domain(_ name: String, _ version: String, _ verifying: String) -> [UInt8]? {
    guard let c = u256(chainId), let v = addr(verifying) else { return nil }
    return Keccak.hash(Keccak.hash("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)") + Keccak.hash(name) + Keccak.hash(version) + c + v)
  }
  /// OwnerTrust EIP-712 digest (what KipurseTrustV5.ownerDigest returns).
  public static func digest(_ m: OwnerTrustMessage, adapter: String = mainnetAdapter) -> [UInt8]? {
    let th = Keccak.hash("OwnerTrust(address account,bytes32 merchant,string name,uint64 epoch,address[] payees,address[] signers,uint160 single,uint160 daily,uint64 expiry,bytes32 nonce,uint256 deadline)")
    guard let acc = addr(m.account), let mer = b32(m.merchant), let ep = u256(m.epoch), let s1 = u256(m.single), let d1 = u256(m.daily),
          let ex = u256(m.expiry), let n = b32(m.nonce), let dl = u256(m.deadline), let ds = domain("Kipurse Owner", "5", adapter) else { return nil }
    var pay = [UInt8](), sig = [UInt8]()
    for p in m.payees { guard let a = addr(p) else { return nil }; pay += a }
    for p in m.signers { guard let a = addr(p) else { return nil }; sig += a }
    let sh = Keccak.hash(th + acc + mer + Keccak.hash(m.name) + ep + Keccak.hash(pay) + Keccak.hash(sig) + s1 + d1 + ex + n + dl)
    return Keccak.hash([0x19, 0x01] + ds + sh)
  }
  /// t1250 (§6#119, KR-01): V5.5 OwnerInlineTrust (seat kind 6): the KPTR "approve & remember" form. Same fields and order as OwnerTrust; only the
  /// type name differs, so a stored-trust signature can never be used inline and the reverse.
  public static func inlineTrustDigest(_ m: OwnerTrustMessage, adapter: String = KipurseSuite.v55.adapter) -> [UInt8]? {
    KipurseV55.ownerDigest(.inlineTrust(KipurseV55.trustParams(m), nonce: m.nonce, deadline: m.deadline), account: m.account, epoch: m.epoch, adapter: adapter)
  }
  /// The trust digest for THIS wallet's suite: on V5.5 a reusable ("remember") trust is OwnerInlineTrust (kind 6), any other trust OwnerTrust (kind 1);
  /// earlier suites always OwnerTrust exactly as before. Domain = the suite's adapter.
  public static func trustDigest(_ m: OwnerTrustMessage, suite: KipurseSuite = KipurseSuite.active) -> [UInt8]? {
    suite.seatV2 && RequestVerify.isReusableTrust(m) ? inlineTrustDigest(m, adapter: suite.adapter) : digest(m, adapter: suite.adapter)
  }
  /// t1250: the KR-05 rules KipurseTrustV55 enforces (V5.5 wallets only; nothing changes for earlier suites).
  public static func suiteProblems(_ m: OwnerTrustMessage, suite: KipurseSuite = KipurseSuite.active, now: Date = Date()) -> [String] {
    guard suite.seatV2 else { return [] }
    return KipurseV55.trustProblems(KipurseV55.trustParams(m), inline: RequestVerify.isReusableTrust(m), deadline: m.deadline, now: now)
  }
  /// t1214 (§6#100/#102): V5.4 OwnerSignerTrust (kind 5) — "trust the order signer(s) of merchant M, any per-order payee, within these caps,
  /// until expiry". Same domain as OwnerTrust ("Kipurse Owner" v5, verifyingContract = the V5.4 adapter); computed here from the shown fields.
  public static func signerTrustDigest(_ m: OwnerSignerTrustMessage, adapter: String = KipurseSuite.v54.adapter) -> [UInt8]? {
    let th = Keccak.hash("OwnerSignerTrust(address account,bytes32 merchant,string name,uint64 epoch,address[] signers,uint160 single,uint160 daily,uint64 expiry,bytes32 nonce,uint256 deadline)")
    guard let acc = addr(m.account), let mer = b32(m.merchant), let ep = u256(m.epoch), let s1 = u256(m.single), let d1 = u256(m.daily),
          let ex = u256(m.expiry), let n = b32(m.nonce), let dl = u256(m.deadline), let ds = domain("Kipurse Owner", "5", adapter), !m.signers.isEmpty else { return nil }
    var sig = [UInt8](); for p in m.signers { guard let a = addr(p) else { return nil }; sig += a }
    let sh = Keccak.hash(th + acc + mer + Keccak.hash(m.name) + ep + Keccak.hash(sig) + s1 + d1 + ex + n + dl)
    return Keccak.hash([0x19, 0x01] + ds + sh)
  }
  /// The grant must say exactly what the trust card shows: same wallet, merchant, name, signers, caps and expiry (deadline = expiry).
  public static func signerTrustProblems(_ g: OwnerSignerTrustMessage, card m: OwnerTrustMessage, wallet: String = mainnetWallet) -> [String] {
    var p = [String]()
    if g.account.lowercased() != wallet.lowercased() { p.append("wrong wallet") }
    if g.merchant.lowercased() != m.merchant.lowercased() || g.name != m.name || Hex.encode(Keccak.hash(g.name)).lowercased() != g.merchant.lowercased() { p.append("merchant differs") }
    if g.signers.isEmpty || g.signers.map({ $0.lowercased() }) != m.signers.map({ $0.lowercased() }) { p.append("signers differ") }
    if g.single != m.single || g.daily != m.daily || g.expiry != m.expiry || g.deadline != g.expiry { p.append("caps differ") }
    // t1240 (§6#110): the trust signed in the same Face ID moves the merchant's epoch up by one when it lands; the grant is for that next epoch
    if let ge = UInt64(g.epoch), let me = UInt64(m.epoch), ge == me + 1 {} else { p.append("grant epoch is not the trust's next epoch") }
    return p
  }
  /// The wallet's replay-safe hash of `digest` (what the phone's P-256 key signs).
  public static func walletHash(_ digest: [UInt8], wallet: String = mainnetWallet) -> [UInt8]? {
    guard let ds = domain("Coinbase Smart Wallet", "1", wallet) else { return nil }
    return Keccak.hash([0x19, 0x01] + ds + Keccak.hash(Keccak.hash("CoinbaseSmartWalletMessage(bytes32 hash)") + digest))
  }
  /// Checks the phone must do before signing: right wallet, merchant = keccak(name), caps within the phone ceiling.
  public static func problems(_ m: OwnerTrustMessage, wallet: String = mainnetWallet, maxSingle: String, maxDaily: String) -> [String] {
    var p = [String]()
    if m.account.lowercased() != wallet.lowercased() { p.append("wrong wallet") }
    if Hex.encode(Keccak.hash(m.name)).lowercased() != m.merchant.lowercased() { p.append("merchant id does not match name") }
    if m.payees.isEmpty { p.append("no payee") }
    if let a = u256(m.single), let b = u256(maxSingle), a.lexicographicallyPrecedes(b) == false && a != b { p.append("per-payment cap above phone limit") }
    if let a = u256(m.daily), let b = u256(maxDaily), a.lexicographicallyPrecedes(b) == false && a != b { p.append("daily cap above phone limit") }
    return p
  }
  /// DER ECDSA signature -> (r, s) 32 bytes each, s normalized to the low half (n - s if needed).
  public static func rs(fromDER der: [UInt8]) -> ([UInt8], [UInt8])? {
    guard der.count > 8, der[0] == 0x30 else { return nil }; var i = 2
    func int() -> [UInt8]? { guard i + 2 <= der.count, der[i] == 0x02 else { return nil }; let l = Int(der[i + 1]); i += 2; guard i + l <= der.count else { return nil }
      var v = Array(der[i..<(i + l)]); i += l; while v.count > 32, v.first == 0 { v.removeFirst() }; guard v.count <= 32 else { return nil }
      return [UInt8](repeating: 0, count: 32 - v.count) + v }
    guard let r = int(), let s = int() else { return nil }
    return (r, lowS(s))
  }
  /// floor(n / 2) of the P-256 order.
  static let p256halfN: [UInt8] = { var half = p256n; var c: UInt8 = 0; for k in 0..<32 { let v = UInt16(half[k]) | (UInt16(c) << 8); half[k] = UInt8(v >> 1); c = UInt8(v & 1) }; return half }()
  /// KL-5 (V5.5 key seat V2 requires it; every earlier approver accepts it too): s > n/2 becomes n - s, otherwise s unchanged. 32-byte big-endian.
  public static func lowS(_ s: [UInt8]) -> [UInt8] {
    guard s.count == 32, p256halfN.lexicographicallyPrecedes(s) else { return s }
    var out = [UInt8](repeating: 0, count: 32); var borrow = 0
    for k in stride(from: 31, through: 0, by: -1) { var v = Int(p256n[k]) - Int(s[k]) - borrow; borrow = v < 0 ? 1 : 0; if v < 0 { v += 256 }; out[k] = UInt8(v) }
    return out
  }
  /// Fingerprint shown on the phone and the enrollment page: first 8 bytes of keccak(x || y), 4 groups.
  public static func fingerprint(x: [UInt8], y: [UInt8]) -> String {
    let h = Hex.encode(Array(Keccak.hash(x + y).prefix(8))).dropFirst(2).uppercased(); var g = [String](); var s = Substring(h)
    while !s.isEmpty { g.append(String(s.prefix(4))); s = s.dropFirst(4) }; return g.joined(separator: "-")
  }
  /// t1280 (Q4): the trust epoch the server put into a trust / signer-grant message must be the merchant's CURRENT epoch on chain:
  /// trust.trustOf(wallet, merchant).epoch (first word of the record in every Kipurse trust version), read by the phone itself from two
  /// agreeing public nodes. Any read failure, disagreement or different epoch = false (the phone refuses to sign).
  public static func chainEpochMatches(account: String, merchant: String, epoch: String, trust: String = KipurseSuite.active.trust,
                                       call: RequestVerify.ChainCall = { to, d in await ChainRPC.ethCall(to, d, agreed: true) }) async -> Bool {
    guard let a = addr(account), let m = b32(merchant), let want = UInt64(epoch), String(want) == epoch else { return false }
    let data = BatchVerify.sel("trustOf(address,bytes32)") + String(Hex.encode(a + m).dropFirst(2))
    guard let v = await call(trust, data), let b = Hex.decode(v), b.count >= 32, b.count % 32 == 0, b.prefix(24).allSatisfy({ $0 == 0 }) else { return false }
    return b[24..<32].reduce(UInt64(0)) { $0 << 8 | UInt64($1) } == want
  }
  public static func rejectMessage(id: String, payee: String) -> String { "Kipurse: I reject trust request \(id) for payee \(payee). Nothing is trusted." }
}
