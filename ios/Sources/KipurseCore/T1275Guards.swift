// SPDX-License-Identifier: Apache-2.0
import Foundation

/// t1275: small pure rules from the t1275 security review. Every one only adds refusals (or a calmer "not confirmed" line).

public extension PhoneTrust {
  /// t1275 (#1): a trust may name merchant order signers ONLY when the same Face ID also signs a grant the phone has verified (V5.4+), because
  /// the card shows signers only through that grant. Every trust-approval path applies this (same rule as OwnerAsk.trustProblems).
  static func signerProblems(_ m: OwnerTrustMessage, grantVerified: Bool) -> [String] {
    m.signers.isEmpty || grantVerified ? [] : ["trust must not add order signers"]
  }
}

/// t1275 (#3): what /approve/trust/phone-sign and phone-reject answer when they really did it (gw trust-approve-public.mjs:
/// `{status: "trusted", txHash, signerGrant?}` / `{status: "rejected"}`). Anything else is "not confirmed yet", never a success.
public enum TrustSignReply {
  public static func trusted(_ j: [String: Any]) -> Bool { (j["status"] as? String) == "trusted" }
  public static func rejected(_ j: [String: Any]) -> Bool { (j["status"] as? String) == "rejected" }
  public static let notConfirmedZH = "已发送，但还没收到服务器确认。请稍后刷新看看结果。"
  public static let notConfirmedEN = "Sent, but the server hasn't confirmed it yet. Refresh in a moment to see the result."
}

/// t1275 (#2): the AI everyday limits the owner SIGNED on this phone are the only source of the ceiling for trust caps and for the
/// "AI can pay up to…" line. The server's `everyday` reply may only LOWER it (never raise it above the last locally signed numbers);
/// no local copy (e.g. limits set on another phone) = no ceiling granted (nil) -> every trust above nothing is refused.
public enum SignedLimits {
  public static func ceiling(local: AISpendLimits.Saved?, server: AISpendLimits.Saved?) -> (single: Int64, daily: Int64)? {
    guard let l = local, l.single > 0, l.daily > 0 else { return nil }
    guard let s = server, s.single > 0, s.daily > 0 else { return (l.single, l.daily) }
    return (min(l.single, s.single), min(l.daily, s.daily))
  }
  /// Stored form ("single,daily,term" atomic USDC) — the same parser the app already uses for three amounts.
  public static func encode(_ g: AISpendLimits.Saved) -> String { "\(g.single),\(g.daily),\(g.term)" }
  public static func decode(_ s: String?) -> AISpendLimits.Saved? { s.flatMap { AISpendLimits.parseList($0) } }
  /// Keychain account for a wallet (lowercased address); nil for anything that is not an address.
  public static func account(wallet: String) -> String? { Hex.decode(wallet)?.count == 20 ? "everyday." + wallet.lowercased() : nil }
}

public extension OwnerAsk {
  /// t1275 (#2): `trustCapProblems` against the phone's locally signed ceiling; nil (nothing signed on this phone) refuses every trust.
  static func trustCapProblems(_ m: OwnerTrustMessage, localCeiling: (single: Int64, daily: Int64)?) -> [String] {
    guard let c = localCeiling else { return ["no AI spending limits signed on this phone"] }
    return trustCapProblems(m, ceiling: c)
  }
}
