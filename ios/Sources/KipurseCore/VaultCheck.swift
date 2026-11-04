import Foundation

/// t767s: the phone reads adapter.vaultAddress(wallet) on-chain itself and refuses when it differs from the server's vault.
public enum VaultCheck {
  public static let selVaultAddress = "1cb3d314"
  public static let publicRPC = URL(string: "https://mainnet.base.org")!
  public static func callData(wallet: String) -> String? {
    let h = wallet.lowercased().replacingOccurrences(of: "0x", with: "")
    guard h.count == 40, h.allSatisfy({ $0.isHexDigit }) else { return nil }
    return "0x" + selVaultAddress + String(repeating: "0", count: 24) + h }
  /// ABI address word -> 0x-lowercase, nil if malformed
  public static func decode(_ result: String) -> String? {
    let h = result.lowercased().replacingOccurrences(of: "0x", with: "")
    guard h.count == 64, h.allSatisfy({ $0.isHexDigit }), h.prefix(24).allSatisfy({ $0 == "0" }) else { return nil }
    let a = "0x" + h.suffix(40); return a == "0x" + String(repeating: "0", count: 40) ? nil : a }
  /// nil = OK; otherwise a problem. A missing server vault is OK here (BatchVerify then refuses any fee-slot step).
  public static func problem(server: String?, chain: String?) -> String? {
    guard let s = server else { return nil }
    guard let c = chain else { return "couldn't confirm your vault address on-chain" }
    return s.lowercased() == c ? nil : "the server's vault address does not match the chain" }
  public static func fetch(adapter: String = PhoneTrust.mainnetAdapter, wallet: String, rpc: URL? = nil) async -> String? {
    guard let d = callData(wallet: wallet) else { return nil }
    guard let r = try? await GasCheck.call(rpc ?? GasCheck.rpc ?? publicRPC, "eth_call", [["to": adapter, "data": d], "latest"]) else { return nil }
    return decode(r) }

  // t784: pre-sign facts read from the chain by the phone itself (never from the Kipurse server).
  public static let usdc = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913"
  public static let selBalanceOf = "70a08231", selIsOwnerAddress = "a2e1a8d8"
  public static func addrCall(_ sel: String, _ a: String) -> String? {
    let h = a.lowercased().replacingOccurrences(of: "0x", with: "")
    guard h.count == 40, h.allSatisfy({ $0.isHexDigit }) else { return nil }
    return "0x" + sel + String(repeating: "0", count: 24) + h }
  /// uint256 word -> Int64 (nil when malformed or too large for USDC amounts we show)
  public static func decodeUInt(_ result: String) -> Int64? {
    let h = result.lowercased().replacingOccurrences(of: "0x", with: "")
    guard h.count == 64, h.allSatisfy({ $0.isHexDigit }), h.prefix(48).allSatisfy({ $0 == "0" }) else { return nil }
    return Int64(h.suffix(16), radix: 16) }
  public static func decodeBool(_ result: String) -> Bool? { decodeUInt(result).flatMap { $0 == 1 ? true : $0 == 0 ? false : nil } }
  public static func usdcBalance(_ holder: String, rpc: URL? = nil) async -> Int64? {
    guard let d = addrCall(selBalanceOf, holder), let r = try? await GasCheck.call(rpc ?? GasCheck.rpc ?? publicRPC, "eth_call", [["to": usdc, "data": d], "latest"]) else { return nil }
    return decodeUInt(r) }
  /// Coinbase Smart Wallet isOwnerAddress(address)
  public static func isOwner(wallet: String, address: String, rpc: URL? = nil) async -> Bool? {
    guard let d = addrCall(selIsOwnerAddress, address), let r = try? await GasCheck.call(rpc ?? GasCheck.rpc ?? publicRPC, "eth_call", [["to": wallet, "data": d], "latest"]) else { return nil }
    return decodeBool(r) }
  /// nil = OK. The amount the server wants to withdraw may never exceed what the chain says is in the wallet + its vault.
  public static func withdrawProblem(planAmount: Int64, onchainTotal: Int64?) -> String? {
    guard let t = onchainTotal else { return "couldn't read the balance on-chain" }
    return planAmount <= t ? nil : "the amount is more than the on-chain balance" }
}
