import Foundation
/// t609u two-layer limits. Layer 1 = on-chain safety floor (链上安全底线); Layer 2 = everyday limits (日常额度):
/// stored on the server, set only from this phone (device key + Face ID), free and instant, ALWAYS <= the floor.
public enum EverydayLimits {
  public enum Cost: Equatable { case free; case floorChange(firstFree: Bool) }
  /// Changing everyday limits anywhere under the floor (up or down) is free; anything above needs a floor change.
  public static func cost(single: Int64, daily: Int64, floorSingle: Int64, floorDaily: Int64, firstFloorDone: Bool = true) -> Cost {
    (single > floorSingle || daily > floorDaily) ? .floorChange(firstFree: Principles.firstLimitsFree && !firstFloorDone) : .free }
  /// Locked invariant: everyday never above the floor.
  public static func clamp(single: Int64, daily: Int64, floorSingle: Int64, floorDaily: Int64) -> (Int64, Int64) { (min(single, floorSingle), min(daily, floorDaily)) }
  public static let whyZh = "底线写在区块链上，就算我们的服务器出问题也突破不了；改它要付网络手续费（约 0.007 USDC，从你的启付钱包扣），我们不加价。"
  public static let whyEn = "The floor lives on the blockchain, so even if our servers fail it can’t be broken. Changing it costs a network fee (about 0.007 USDC, taken from your Kipurse wallet), and we add nothing on top."
  public static let freeZh = "不收手续费：在底线以下改日常额度，调高调低都不收费，马上生效。"
  public static let freeEn = "Free: change your everyday limits anywhere under the floor, up or down. Instant."
  public static let paidZh = "收费（约 0.007 USDC）：第一次以后，每次改链上底线本身。通常是想把日常额度调到底线以上，就得先调高底线；调低底线也是链上修改，同样收这点手续费（只有第一次设置由启付代付）。"
  public static let paidEn = "Charged (about 0.007 USDC): changing the on-chain floor itself, after the first time. Usually that’s when you want everyday limits above the floor, so the floor must go up first. Lowering the floor is also an on-chain change and costs the same small fee (only the first setup is paid by Kipurse)."
  public static let stayFreeZh = "怎么一直不花手续费：底线一次设得宽松一点，平时只调日常额度。"
  public static let stayFreeEn = "How to stay free: set the floor comfortably high once, then adjust everyday limits freely."
}
