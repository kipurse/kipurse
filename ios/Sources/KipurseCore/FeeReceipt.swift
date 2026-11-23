// SPDX-License-Identifier: Apache-2.0
import Foundation
/// t968: the gateway's receipt (server/src/v5/receipt.mjs), shown as-is before Face ID. Exact USDC, all from the wallet balance.
public struct FeeReceipt: Equatable {
  public let amount: UInt64, protocolFee: UInt64, networkFee: UInt64, total: UInt64, networkFeeAtPayment: Bool
  public init?(_ d: [String: Any]?) {
    func u(_ k: String) -> UInt64? { if let s = d?[k] as? String { return UInt64(s) }; if let n = d?[k] as? NSNumber { return n.uint64Value }; return nil }
    guard let d, (d["paidFrom"] as? String) == "wallet_balance", (d["token"] as? String) == "USDC",
          let a = u("amount"), let p = u("protocolFee"), let n = u("networkFee"), let t = u("total"), a + p + n == t else { return nil }
    amount = a; protocolFee = p; networkFee = n; total = t; networkFeeAtPayment = (d["networkFeeAtPayment"] as? Bool) ?? false
  }
  public static func usdc(_ v: UInt64) -> String {
    let w = v / 1_000_000, f = String(format: "%06llu", v % 1_000_000).replacingOccurrences(of: "0+$", with: "", options: .regularExpression)
    return (f.isEmpty ? "\(w)" : "\(w).\(f)") + " USDC" }
  /// (label, value) rows. When the network cost is only known at payment time it says so instead of guessing.
  public func rows(zh: Bool) -> [(String, String)] {
    var r: [(String, String)] = [(zh ? "付给收款方（每笔最多）" : "To payee (max per payment)", Self.usdc(amount)),
                                 (zh ? "启付服务费" : "Kipurse service fee", Self.usdc(protocolFee))]
    if networkFeeAtPayment { r.append((zh ? "链上手续费" : "On-chain cost", zh ? "按实际成本，付款时显示" : "actual cost, shown at payment")) }
    else { r.append((zh ? "链上手续费" : "On-chain cost", Self.usdc(networkFee))); r.append((zh ? "合计（从钱包余额扣）" : "Total (from wallet balance)", Self.usdc(total))) }
    return r }
}
/// t968: dispute state from the gateway (dispute-window.mjs) -> one plain label.
public enum DisputeState {
  public static func label(state: String?, status: String?, zh: Bool) -> String {
    switch state ?? status ?? "open" {
    case "refunded": return zh ? "已全部退款" : "Fully refunded"
    case "resolved": return zh ? "已解决" : "Resolved"
    case "withdrawn": return zh ? "已撤回" : "Withdrawn"
    case "partially_refunded": return zh ? "已部分退款" : "Partly refunded"
    case "merchant_overdue": return zh ? "商家超过 7 天没有退款" : "Merchant is over 7 days late"
    default: return zh ? "等待商家退款" : "Waiting for the merchant" } }
}
