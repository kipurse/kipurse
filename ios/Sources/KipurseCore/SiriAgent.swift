import Foundation

/// Siri is a free, server-authorized agent (POST /siri/buy, phone session auth). Plain-language answer Siri speaks.
public enum SiriAgentAnswer {
  public static func text(_ j: [String: Any], zh: Bool) -> String {
    let say = (j["say_to_user"] as? String).flatMap { $0.isEmpty ? nil : $0 }
    switch j["decision"] as? String {
    case "can_pay", "paid", "done": return say ?? (zh ? "付好了。" : "Paid.")
    case "ask_owner": return say ?? (zh ? "这笔超出了 AI 付款上限，已推送到你的手机，用 Face ID 批准后就会付。" : "This is over your AI payment limit. Approve it with Face ID on your phone and it will be paid.")
    default: return say ?? (zh ? "没有付款，钱没有动。" : "Not paid. No money moved.")
    }
  }
}

/// Siri skip-confirm (handbook §4.1): only saved payees reach Siri pay (it cannot pick a new address). Inside the per-payment cap and
/// today's remaining allowance -> no extra "are you sure" step. Display-side only; the server decides (ask_owner -> Face ID push otherwise).
public enum SiriSkip {
  public static func inside(_ amount: Int64, _ s: WalletState?) -> Bool {
    guard let s, amount > 0, let c = s.capSingle, let d = s.capDaily else { return false }
    // t934: while AI payments are paused (globally or Siri itself) never skip the confirm step; the server refuses anyway.
    if s.raw["paused"]?.bool == true || s.raw["paused"]?["active"]?.bool == true { return false }
    if s.agents.contains(where: { ($0["id"]?.string == "siri" || $0["kind"]?.string == "siri") && $0["paused"]?.bool == true }) { return false }
    return amount <= c && amount <= max(0, d - (s.serverSpentToday ?? 0))
  }
}

/// t899 (owner): Siri works like Muse / Grok / Claude. The owner freely sets Siri's own allowance (per payment + per day, same
/// agent_limits mandate as every AI, one Face ID to save). Inside it (and the wallet's AI limit, known payee) Siri pays with NO Face ID;
/// over it, a new payee or resuming a paused Siri -> the server answers ask_owner -> Face ID. The server enforces; this only validates input.
public enum AgentLimits {
  /// "1.5" -> 1_500_000 (USDC, 6 decimals). nil = not a positive amount.
  public static func atomic(_ s: String) -> Int64? {
    let t = s.trimmingCharacters(in: .whitespaces).replacingOccurrences(of: ",", with: ".")
    guard !t.isEmpty, t.allSatisfy({ $0.isNumber || $0 == "." }), t.filter({ $0 == "." }).count <= 1 else { return nil }
    let p = t.split(separator: ".", omittingEmptySubsequences: false); let w = String(p[0]); let f = p.count > 1 ? String(p[1]) : ""
    guard f.count <= 6, w.count <= 9, let wi = Int64(w.isEmpty ? "0" : w), let fi = Int64((f + String(repeating: "0", count: 6 - f.count))) else { return nil }
    let v = wi * 1_000_000 + fi; return v > 0 ? v : nil
  }
  /// nil = OK; otherwise a short sentence for the owner.
  public static func problem(single: String, daily: String, zh: Bool) -> String? {
    guard let s = atomic(single), let d = atomic(daily) else { return zh ? "请填大于 0 的金额（最多 6 位小数）。" : "Enter amounts above 0 (up to 6 decimals)." }
    if s > d { return zh ? "每笔额度不能大于每天额度。" : "Per payment can't be more than per day." }
    return nil
  }
  /// The owner draft item (server normalizeItem kind agent_limits). Monthly is kept only when it is still >= the new daily.
  public static func item(agentId: String, single: String, daily: String, monthly: String?, resume: Bool) -> [String: Any] {
    var i: [String: Any] = ["kind": "agent_limits", "agentId": agentId, "single": single.trimmingCharacters(in: .whitespaces), "daily": daily.trimmingCharacters(in: .whitespaces)]
    if let m = monthly, let ma = atomic(m), let da = atomic(daily), ma >= da { i["monthly"] = m }
    if resume { i["resume"] = true }
    return i
  }
  /// Server answer for one Siri payment: does the owner have to approve it with Face ID?
  public static func needsFaceID(_ j: [String: Any]) -> Bool { (j["decision"] as? String) == "ask_owner" }
}
