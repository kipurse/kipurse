import Foundation

/// t1128u (owner "允许再扣", handbook §6#66): turning Face ID on AFTER opening may carry one actual-cost network fee, but only in the
/// wallet-pays shape: the Kipurse wallet pays at most 0.05 USDC to Kipurse's fixed fee address in the same batch, and the owner's Base
/// account only confirms (never fronts, never ETH). Fee 0 (the opening-batch key) needs no check here.
public enum EnrollFee {
  public static let cap: UInt64 = 50_000
  /// nil = OK; otherwise a short reason. Nothing is opened or sent when this returns a reason.
  public static func problem(_ r: [String: Any], owner: String) -> String? {
    let raw = (r["fee"] as? String) ?? (r["fee"] as? NSNumber)?.stringValue ?? "0"
    guard let fee = UInt64(raw) else { return T("手续费读不出来，已停止。没有扣钱。", "The fee couldn't be read. Stopped; nothing was charged.") }
    if fee == 0 { return nil }
    if fee > cap { return T("网络费超过 0.05 USDC 上限，已停止。没有扣钱。", "The network fee is over the 0.05 USDC cap. Stopped; nothing was charged.") }
    let pays = (r["walletPays"] as? Bool) == true, to = ((r["feeTo"] as? String) ?? "").lowercased()
    guard pays, to == RequestVerify.duesTo else {
      return T("这笔网络费必须从启付钱包付到启付的手续费地址，已停止。没有扣钱。", "This network fee must be paid from your Kipurse wallet to Kipurse's fee address. Stopped; nothing was charged.") }
    let pad = { (h: String) in String(repeating: "0", count: max(0, 64 - h.count)) + h }
    let want = "a9059cbb" + pad(String(to.dropFirst(2))) + pad(String(fee, radix: 16))
    let calls = (r["calls"] as? [[String: Any]]) ?? []
    let datas = calls.compactMap { ($0["data"] as? String)?.lowercased() }
    let o = owner.lowercased().replacingOccurrences(of: "0x", with: "")
    guard datas.filter({ $0.contains(want) }).count == 1, !datas.contains(where: { $0.contains("a9059cbb" + pad(o)) }) else {
      return T("批次里的网络费和报价不一致，已停止。没有扣钱。", "The fee in the batch doesn't match the quote. Stopped; nothing was charged.") }
    return nil
  }
}
