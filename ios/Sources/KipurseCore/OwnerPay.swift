import Foundation

/// Owner-initiated payment: what the phone signs, recomputed ON THE PHONE from the fields it shows (never a blind hash).
/// approval = EIP-712 OwnerApproval(account, purchaseKey, payee, amount, deadline) under "Kipurse Owner" v5 (same domain as trust);
/// the Secure Enclave key signs the wallet's replay-safe hash of it. On chain: KipursePhoneApproverV2 KIND_PAY + adapter payDirect.
public enum OwnerPay {
  public struct Challenge: Equatable {
    public var id: String, digest: String, approvalDigest: String, purchaseKey: String, payee: String, amount: String, deadline: String, wallet: String, chainId: Int
    public var fee: String, newPayee: Bool
    public init(id: String, digest: String, approvalDigest: String, purchaseKey: String, payee: String, amount: String, deadline: String, wallet: String, chainId: Int, fee: String, newPayee: Bool) {
      self.id = id; self.digest = digest; self.approvalDigest = approvalDigest; self.purchaseKey = purchaseKey; self.payee = payee; self.amount = amount
      self.deadline = deadline; self.wallet = wallet; self.chainId = chainId; self.fee = fee; self.newPayee = newPayee }
    public init?(_ j: [String: Any]) {
      func s(_ k: String) -> String? { (j[k] as? String) ?? (j[k] as? NSNumber)?.stringValue }
      guard let id = s("id"), let d = s("digest"), let a = s("approvalDigest"), let k = s("purchaseKey"), let p = s("payee"), let m = s("amount"), let dl = s("deadline"), let w = s("wallet"),
            let c = (j["chainId"] as? NSNumber)?.intValue else { return nil }
      self.init(id: id, digest: d, approvalDigest: a, purchaseKey: k, payee: p, amount: m, deadline: dl, wallet: w, chainId: c, fee: s("fee") ?? "0", newPayee: (j["newPayee"] as? Bool) ?? false)
    }
  }
  public static func approvalDigest(account: String, purchaseKey: String, payee: String, amount: String, deadline: String, adapter: String = PhoneTrust.mainnetAdapter) -> [UInt8]? {
    let th = Keccak.hash("OwnerApproval(address account,bytes32 purchaseKey,address payee,uint256 amount,uint256 deadline)")
    guard let acc = PhoneTrust.addr(account), let k = PhoneTrust.b32(purchaseKey), let p = PhoneTrust.addr(payee), let a = PhoneTrust.u256(amount), let d = PhoneTrust.u256(deadline),
          let ds = PhoneTrust.domain("Kipurse Owner", "5", adapter) else { return nil }
    return Keccak.hash([0x19, 0x01] + ds + Keccak.hash(th + acc + k + p + a + d))
  }
  /// The hash to sign, or why not: wrong wallet / chain / payee / amount, or the server's digest differs from the phone's own.
  public static func toSign(_ c: Challenge, wallet: String, payee: String, amount: Int64, now: Date = Date()) -> Result<[UInt8], PayCheckError> {
    if c.wallet.lowercased() != wallet.lowercased() || wallet.isEmpty { return .failure(.wrongWallet) }
    if String(c.chainId) != PhoneTrust.chainId { return .failure(.wrongChain) }
    if c.payee.lowercased() != payee.lowercased() { return .failure(.wrongPayee) }
    if c.amount != String(amount) { return .failure(.wrongAmount) }
    guard let dl = Double(c.deadline), dl > now.timeIntervalSince1970 + 10, dl < now.timeIntervalSince1970 + 3600 else { return .failure(.expired) }
    guard let a = approvalDigest(account: wallet, purchaseKey: c.purchaseKey, payee: payee, amount: c.amount, deadline: c.deadline),
          Hex.encode(a).lowercased() == c.approvalDigest.lowercased(),
          let h = PhoneTrust.walletHash(a, wallet: wallet), Hex.encode(h).lowercased() == c.digest.lowercased() else { return .failure(.digestMismatch) }
    return .success(h)
  }
  public enum PayCheckError: Error, Equatable { case wrongWallet, wrongChain, wrongPayee, wrongAmount, expired, digestMismatch }
}
