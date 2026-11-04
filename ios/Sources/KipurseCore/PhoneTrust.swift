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

public enum PhoneTrust {
  /// This user's wallet (from enrollment / operator config; never compiled in).
  public static var mainnetWallet: String { Operator.wallet }
  public static let mainnetAdapter = "0x05320BeD08309F66316F7d73e2D0be110400FbB2"
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
    guard let r = int(), var s = int() else { return nil }
    var half = p256n; var c: UInt8 = 0; for k in 0..<32 { let v = UInt16(half[k]) | (UInt16(c) << 8); half[k] = UInt8(v >> 1); c = UInt8(v & 1) }
    if half.lexicographicallyPrecedes(s) { var out = [UInt8](repeating: 0, count: 32); var borrow = 0
      for k in stride(from: 31, through: 0, by: -1) { var v = Int(p256n[k]) - Int(s[k]) - borrow; borrow = v < 0 ? 1 : 0; if v < 0 { v += 256 }; out[k] = UInt8(v) }; s = out }
    return (r, s)
  }
  /// Fingerprint shown on the phone and the enrollment page: first 8 bytes of keccak(x || y), 4 groups.
  public static func fingerprint(x: [UInt8], y: [UInt8]) -> String {
    let h = Hex.encode(Array(Keccak.hash(x + y).prefix(8))).dropFirst(2).uppercased(); var g = [String](); var s = Substring(h)
    while !s.isEmpty { g.append(String(s.prefix(4))); s = s.dropFirst(4) }; return g.joined(separator: "-")
  }
  public static func rejectMessage(id: String, payee: String) -> String { "Kipurse: I reject trust request \(id) for payee \(payee). Nothing is trusted." }
}
