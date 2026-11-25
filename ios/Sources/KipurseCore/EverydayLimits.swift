import Foundation
/// t609 two-layer limits. Layer 1 = on-chain safety floor ([zh]); Layer 2 = everyday limits ([zh]):
/// stored on the server, set only from this phone (device key + Face ID), free and instant, ALWAYS <= the floor.
public enum EverydayLimits {
  public enum Cost: Equatable { case free; case floorChange(firstFree: Bool) }
  /// Changing everyday limits anywhere under the floor (up or down) is free; anything above needs a floor change.
  public static func cost(single: Int64, daily: Int64, floorSingle: Int64, floorDaily: Int64, firstFloorDone: Bool = true) -> Cost {
    (single > floorSingle || daily > floorDaily) ? .floorChange(firstFree: Principles.firstLimitsFree && !firstFloorDone) : .free }
  /// Locked invariant: everyday never above the floor.
  public static func clamp(single: Int64, daily: Int64, floorSingle: Int64, floorDaily: Int64) -> (Int64, Int64) { (min(single, floorSingle), min(daily, floorDaily)) }
  public static let whyZh = "钱包安全上限写在区块链上，就算我们的服务器出问题也突破不了。修改它要付实际网络费，用 USDC，从你的启付钱包扣，我们不加价。这一页会显示报价。"
  public static let whyEn = "The wallet safety limit lives on the blockchain, so it holds even if our servers fail. Changing it costs the actual network fee in USDC, taken from your Kipurse wallet, and we add nothing. This page shows the quote."
  public static let freeZh = "不收手续费：在钱包安全上限以内改 AI 花钱上限，调高调低都不收费，马上生效。"
  public static let freeEn = "No fee: change AI spending limits anywhere within the wallet safety limit, up or down. Instant."
  public static let paidZh = "修改钱包安全上限要付实际网络费（USDC）。报价在这一页显示，报价出来之前不会确认。不会自动改这个上限。"
  public static let paidEn = "Changing the wallet safety limit costs the actual network fee in USDC. The quote is on this page, and nothing is confirmed before it appears. This limit is never changed for you automatically."
  public static let stayFreeZh = "平时只改 AI 花钱上限，免费。钱包安全上限留在钱包页。"
  public static let stayFreeEn = "Day to day, change only the AI spending limits. That is free. The wallet safety limit stays on the wallet page."
  public static let aiTitleZh = "AI 花钱上限"
  public static let aiTitleEn = "AI spending limits"
  public static let aiExplainZh = "所有 AI 共用，每笔、每天、总共最多花多少；免费修改"
  public static let aiExplainEn = "Shared by every AI: the most per payment, per day, and in total. Free to change."
  public static let walletTitleZh = "钱包安全上限"
  public static let walletTitleEn = "Wallet safety limits"
  public static let walletExplainZh = "这是最高的保护边界。修改它要付实际网络费，用 USDC。报价在这一页显示。"
  public static let walletExplainEn = "This is the highest safety boundary. Changing it costs the actual network fee in USDC. The quote is shown on this page."
  public static let aboveWalletZh = "超过钱包安全上限，请调低金额或修改安全上限"
  public static let aboveWalletEn = "Above the wallet safety limit. Lower the amount, or change the safety limit."
}

/// t1076: a shared AI total limit is single, daily, AND an explicit total. Chain caps are not that policy.
/// A row without a total does not authorize connecting or spending.
public enum AISpendLimits {
  public struct Saved: Equatable {
    public let single: Int64
    public let daily: Int64
    public let term: Int64
    public init(single: Int64, daily: Int64, term: Int64) {
      self.single = single; self.daily = daily; self.term = term
    }
  }
  public static func saved(_ raw: JSONValue?) -> Saved? {
    guard let ev = raw?["everyday"] else { return nil }
    if let flag = ev["authorized"], case .bool(let on) = flag, !on { return nil }
    let authorized = flag(ev["authorized"])
    let custom = flag(ev["custom"])
    guard authorized || custom else { return nil }
    guard hasStamp(ev["at"]) else { return nil }
    guard let single = positive(ev["requestedSingle"] ?? ev["single"]),
          let daily = positive(ev["requestedDaily"] ?? ev["daily"]), single <= daily else { return nil }
    let termValue = ev["requestedTerm"] ?? ev["term"]
    guard let term = positive(termValue), term >= daily else { return nil }
    return Saved(single: single, daily: daily, term: term)
  }
  /// `parts` is atomic "single,daily,total". Two numbers are not a policy.
  public static func parseList(_ parts: String) -> Saved? {
    let p = parts.split(separator: ",").compactMap { Int64($0) }
    guard p.count >= 3, p[0] > 0, p[1] > 0, p[2] > 0, p[0] <= p[1], p[1] <= p[2] else { return nil }
    return Saved(single: p[0], daily: p[1], term: p[2])
  }
  private static func flag(_ v: JSONValue?) -> Bool { if let v, case .bool(let on) = v { return on }; return false }
  private static func positive(_ v: JSONValue?) -> Int64? { guard let n = v?.atomic, n > 0 else { return nil }; return n }
  private static func hasStamp(_ v: JSONValue?) -> Bool {
    guard let v, v != .null else { return false }
    if case .number(let n) = v { return n.isFinite && n > 0 }
    if case .string(let s) = v, let n = Int64(s) { return n > 0 }
    return false
  }
}
