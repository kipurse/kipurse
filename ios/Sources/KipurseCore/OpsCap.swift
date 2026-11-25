import Foundation

/// t1185 (decision 85): daily on-chain operations of the owner's vault (V5.3 vaults). Default 500 per UTC day; the owner changes it
/// in [zh] and confirms it in the SAME Coinbase batch as the wallet limits (wallet -> vault.setOpsPerDay(n)). The server and the AI
/// can never change it. When today's number is used up, AI payments wait calmly until 00:00 UTC (nothing paid, nothing lost).
public enum OpsCap {
  public static let defaultPerDay = 500, minPerDay = 1, maxPerDay = 100_000
  public static let presets = ["100", "200", "500", "1000", "2000", "5000"]
  /// vault.setOpsPerDay(uint32)
  public static let selSetOpsPerDay = "c7fa10a2"
  /// V5.3 PayerVaultFactoryV5 (deterministic deployer, salt keccak("kipurse-v5.3-factory")); its first CREATE is the vault implementation.
  public static let v53Factory = "0x34d9bdc9e10815fb6913af5bc0daad7e53dbd57d"
  public static let v53VaultImpl = "0x0bf04254cf9a16c83c10159a79e2420528608cda"
  /// keccak256(EIP-1167 creation code for v53VaultImpl) (OpenZeppelin Clones).
  public static func cloneInitHash(impl: String = v53VaultImpl) -> [UInt8]? {
    guard let i = Hex.decode(impl), i.count == 20, let a = Hex.decode("0x3d602d80600a3d3981f3363d3d373d3d3d363d73"), let b = Hex.decode("0x5af43d82803e903d91602b57fd5bf3") else { return nil }
    return Keccak.hash(a + i + b) }
  /// This wallet's V5.3 vault, computed on the phone (never taken from the server): CREATE2(factory, salt = wallet, clone init hash).
  public static func vault(wallet: String) -> String? {
    guard let f = Hex.decode(v53Factory), f.count == 20, let w = Hex.decode(wallet), w.count == 20, let h = cloneInitHash() else { return nil }
    return Hex.encode(Array(Keccak.hash([0xff] + f + ([UInt8](repeating: 0, count: 12) + w) + h).suffix(20))).lowercased() }
  /// "1"..."100000" -> n, else nil.
  public static func parse(_ s: String) -> Int? { let t = s.trimmingCharacters(in: .whitespaces); guard !t.isEmpty, t.count <= 6, t.allSatisfy(\.isNumber), let n = Int(t), n >= minPerDay, n <= maxPerDay else { return nil }; return n }
  public static func error(_ s: String) -> String? { parse(s) == nil ? T("每天链上操作次数：填 1 到 100000 的整数", "On-chain operations per day: a whole number from 1 to 100000") : nil }

  /// Server state.ops: {supported, perDayCount, usedTodayCount, leftCount, resetsAt}. nil = not shown (older vault or not reported).
  public struct State: Equatable { public var perDay: Int; public var used: Int; public var left: Int; public var resetsAt: Date? }
  public static func state(_ raw: JSONValue?) -> State? {
    guard let o = raw?["ops"], o["supported"]?.bool == true, let p = o["perDayCount"]?.atomic, let u = o["usedTodayCount"]?.atomic, p >= 1 else { return nil }
    let l = o["leftCount"]?.atomic ?? max(0, p - u)
    let f = ISO8601DateFormatter(); f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    let r = (o["resetsAt"]?.string).flatMap { f.date(from: $0) ?? ISO8601DateFormatter().date(from: $0) }
    return State(perDay: Int(p), used: Int(u), left: Int(max(0, l)), resetsAt: r) }
  /// One calm line for the limits page.
  public static func line(_ s: State) -> String { T("今天已用 \(s.used) / \(s.perDay) 次 · 每天 UTC 0 点自动恢复", "Used today \(s.used) / \(s.perDay) · resets every day at 00:00 UTC") }
  public static let explainZh = "每次 AI 付款大约用 1 次链上操作。用完了 AI 付款只是等到 UTC 0 点自动恢复，不会丢钱，也可以在这里随时调高。这个上限保护你的手续费：就算有人乱发请求，一天最多也只花这么多次的手续费。"
  public static let explainEn = "Each AI payment uses about 1 on-chain operation. If today's number runs out, AI payments simply wait until 00:00 UTC and then continue; no money is lost, and you can raise it here any time. The limit protects your network fees: even if someone floods requests, at most this many fees can be spent per day."
}
