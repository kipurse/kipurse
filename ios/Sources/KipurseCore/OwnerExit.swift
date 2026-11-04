// SPDX-License-Identifier: AGPL-3.0-only
import Foundation

/// "提现到我的账户": the wallet's own owner (the user's Coinbase wallet) sends ONE batch to the wallet:
///   [wallet.execute(vault, 0, sweep())]  (only if the wallet has a small fee reserve)
///   wallet.execute(USDC, 0, transfer(owner, amount))
/// The phone rebuilds this batch itself and refuses anything else (RequestVerify), so a server can never change where the money goes.
/// Public chain constants only; no user or operator data.
public enum OwnerExit {
  public static let usdcBase = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"
  public static func selector(_ sig: String) -> [UInt8] { Array(Keccak.hash(sig).prefix(4)) }
  static func word(_ b: [UInt8]) -> [UInt8] { [UInt8](repeating: 0, count: max(0, 32 - b.count)) + b.suffix(32) }
  static func uint(_ v: UInt64) -> [UInt8] { var x = v.bigEndian; return word(withUnsafeBytes(of: &x) { Array($0) }) }
  static func addr(_ s: String) -> [UInt8]? { guard let a = Hex.decode(s), a.count == 20 else { return nil }; return a }
  /// ERC-20 transfer(to, amount) calldata.
  public static func transferData(to: String, amount: UInt64) -> String? {
    guard let a = addr(to) else { return nil }
    return Hex.encode(selector("transfer(address,uint256)") + word(a) + uint(amount))
  }
  /// wallet.execute(target, 0, inner) calldata.
  public static func executeData(target: String, inner: [UInt8]) -> String? {
    guard let t = addr(target) else { return nil }
    let len = UInt64(inner.count); let pad = (32 - inner.count % 32) % 32
    return Hex.encode(selector("execute(address,uint256,bytes)") + word(t) + uint(0) + uint(96) + uint(len) + inner + [UInt8](repeating: 0, count: pad))
  }
  /// wallet.execute(USDC, 0, transfer(to, amount)).
  public static func executeData(to: String, amount: UInt64) -> String? {
    guard let inner = transferData(to: to, amount: amount).flatMap(Hex.decode) else { return nil }
    return executeData(target: usdcBase, inner: inner)
  }
  /// The exact batch the phone expects for "withdraw everything to my own account".
  public static func withdrawBatch(wallet: String, owner: String, vault: String?, amount: UInt64) -> [(to: String, data: String)]? {
    guard addr(wallet) != nil, amount > 0, let t = executeData(to: owner, amount: amount) else { return nil }
    var out: [(to: String, data: String)] = []
    if let v = vault { guard let s = executeData(target: v, inner: selector("sweep()")) else { return nil }; out.append((wallet, s)) }
    out.append((wallet, t)); return out
  }
  public enum PlanError: String, Error { case badShape, notOwner, wrongWallet, wrongAmount, notExpected, feeTooHigh, feeNotToKipurse }
  /// t789: the only fee address a withdrawal may pay (Kipurse mainnet ops account, fixed; same constant as the server and page).
  public static let withdrawFeeTo = "0xfc0E68572cDba016c1c90A45E1792f3fE0EE345B"
  /// t789: hard ceiling for the fee the wallet pays on a withdrawal: 0.25 USDC (250_000 units). Never raised.
  public static let maxWalletFee: UInt64 = 250_000
  /// t789 wallet-pays shape: [sweep?] + wallet pays `fee` USDC to the fixed fee address + the rest to the owner.
  public static func withdrawBatchWalletPays(wallet: String, owner: String, vault: String?, amount: UInt64, fee: UInt64) -> [(to: String, data: String)]? {
    guard addr(wallet) != nil, fee > 0, fee <= maxWalletFee, amount > fee,
          let f = executeData(to: withdrawFeeTo, amount: fee), let t = executeData(to: owner, amount: amount - fee) else { return nil }
    var out: [(to: String, data: String)] = []
    if let v = vault { guard let s = executeData(target: v, inner: selector("sweep()")) else { return nil }; out.append((wallet, s)) }
    out.append((wallet, f)); out.append((wallet, t)); return out
  }
  /// Reads (recipient, amount) out of wallet.execute(USDC, 0, transfer(to, amount)) calldata; nil for anything else.
  public static func decodeUSDCTransfer(_ hex: String) -> (to: String, amount: UInt64)? {
    guard let d = Hex.decode(hex), d.count == 4 + 32 * 4 + 68 + 28 else { return nil }
    guard Array(d.prefix(4)) == selector("execute(address,uint256,bytes)") else { return nil }
    guard Hex.encode(Array(d[16..<36])).lowercased() == usdcBase.lowercased() else { return nil }
    let i = 4 + 32 * 4; guard Array(d[i..<i+4]) == selector("transfer(address,uint256)") else { return nil }
    let to = Hex.encode(Array(d[(i+16)..<(i+36)])); let amt = Array(d[(i+36)..<(i+68)])
    guard amt.prefix(24).allSatisfy({ $0 == 0 }) else { return nil }
    let v = amt.suffix(8).reduce(UInt64(0)) { ($0 << 8) | UInt64($1) }
    return (to, v)
  }
  /// t789: the phone accepts exactly one of two batches, rebuilt byte for byte here:
  ///  (a) everything -> owner, or (b) fee (0 < fee <= 0.25 USDC) -> the fixed Kipurse fee address, the rest -> owner.
  /// Anything else (another fee address, a bigger fee, a third payee, a changed amount) is refused.
  public static func verifyAnyPlan(calls: [[String: String]], wallet: String, owner: String, planOwner: String, vault: String?, amount: UInt64) -> PlanError? {
    let plain = verifyPlan(calls: calls, wallet: wallet, owner: owner, planOwner: planOwner, vault: vault, amount: amount)
    if plain == nil { return nil }
    let feeIdx = vault == nil ? 0 : 1
    guard calls.count == feeIdx + 2, let fd = calls[feeIdx]["data"], let fee = decodeUSDCTransfer(fd) else { return plain }
    guard planOwner.lowercased() == owner.lowercased() else { return .notOwner }
    guard fee.to.lowercased() == withdrawFeeTo.lowercased() else { return .feeNotToKipurse }
    guard fee.amount > 0, fee.amount <= maxWalletFee, fee.amount < amount else { return .feeTooHigh }
    guard let want = withdrawBatchWalletPays(wallet: wallet, owner: owner, vault: vault, amount: amount, fee: fee.amount) else { return .badShape }
    for (c, w) in zip(calls, want) {
      guard let to = c["to"], let d = c["data"] else { return .badShape }
      guard to.lowercased() == w.to.lowercased() else { return .wrongWallet }
      let v = (c["value"] ?? "0").lowercased(); guard v == "0" || v == "0x0" || v == "0x" else { return .badShape }
      guard d.lowercased() == w.data.lowercased() else { return .notExpected }
    }
    return nil
  }
  /// Fee the wallet pays in a verified wallet-pays batch (0 for the plain batch).
  public static func walletFee(calls: [[String: String]], vault: String?) -> UInt64 {
    let i = vault == nil ? 0 : 1
    guard calls.count == i + 2, let d = calls[i]["data"], let f = decodeUSDCTransfer(d), f.to.lowercased() == withdrawFeeTo.lowercased() else { return 0 }
    return f.amount
  }
  /// RequestVerify for the withdrawal: the server's plan must be byte-for-byte the batch the phone builds itself,
  /// with the destination = `owner` (the Coinbase wallet this phone knows), from `wallet`, for `amount`.
  public static func verifyPlan(calls: [[String: String]], wallet: String, owner: String, planOwner: String, vault: String?, amount: UInt64) -> PlanError? {
    guard planOwner.lowercased() == owner.lowercased() else { return .notOwner }
    guard let want = withdrawBatch(wallet: wallet, owner: owner, vault: vault, amount: amount) else { return .badShape }
    guard calls.count == want.count else { return .badShape }
    for (c, w) in zip(calls, want) {
      guard let to = c["to"], let d = c["data"] else { return .badShape }
      guard to.lowercased() == w.to.lowercased() else { return .wrongWallet }
      let v = (c["value"] ?? "0").lowercased(); guard v == "0" || v == "0x0" || v == "0x" else { return .badShape }
      guard d.lowercased() == w.data.lowercased() else { return .notExpected }
    }
    return nil
  }
}
