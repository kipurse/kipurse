import Foundation

/// "Use this AI to buy": what a CONNECTED agent's card opens (never the connect flow again).
public enum AgentBuy {
  public struct Example: Hashable { public let zh: String, en: String; public var text: String { T(zh, en) } }
  /// Ready-to-copy first purchases. Small amounts, inside the default allowances; the AI asks you first for anything new.
  public static func examples(for id: String) -> [Example] {
    if id == "siri" {
      return [Example(zh: "嘿 Siri，用 Kipurse 付款", en: "Hey Siri, pay with Kipurse"),  // i18n-ok: paired zh/en or zh-only data
              Example(zh: "嘿 Siri，查 Kipurse 余额", en: "Hey Siri, check Kipurse balance"),  // i18n-ok: paired zh/en or zh-only data
              Example(zh: "嘿 Siri，Kipurse 最近付款", en: "Hey Siri, recent Kipurse payments")]  // i18n-ok: paired zh/en or zh-only data
    }
    return [
      Example(zh: "用 Kipurse 付一点钱，帮我查一下现在比特币多少美元（测试一下，花不到 0.01 USDC）。",  // i18n-ok: paired zh/en or zh-only data
              en: "Use Kipurse to pay a little and tell me the current Bitcoin price in USD (a test, under 0.01 USDC)."),
      Example(zh: "用 Kipurse 帮我买一杯咖啡的优惠券，预算 2 USDC。",  // i18n-ok: paired zh/en or zh-only data
              en: "Use Kipurse to buy me a coffee voucher, budget 2 USDC."),
      Example(zh: "用 Kipurse 查一下：我今天还能花多少？最近买了什么？", en: "Using Kipurse: how much can I still spend today, and what did I buy recently?"),  // i18n-ok: paired zh/en or zh-only data
    ]
  }
  static func q(_ s: String) -> String { var cs = CharacterSet.urlQueryAllowed; cs.remove(charactersIn: "&+=?#"); return s.addingPercentEncoding(withAllowedCharacters: cs) ?? s }
  /// Opens the AI with the sentence already typed in when the app supports it (Grok Bot, Claude); Muse opens its chat; Siri opens Shortcuts.
  public static func openURL(for id: String, text: String) -> URL? {
    switch id {
    case "grok-bot": return URL(string: "grokbot://app/v1/prompt?text=" + q(text))
    case "claude": return URL(string: "https://claude.ai/new?q=" + q(text))
    case "muse": return URL(string: "https://muse.ai/chat")
    case "siri": return nil   // t922: Siri needs no Shortcuts; never send the user there
    default: return nil
    }
  }
  /// t915: tapping an orb opens that AI's own app. Verified 2026-11-01: muse.ai/chat and claude.ai/new are universal links in the
  /// apps' apple-app-site-association (Muse from Meta com.facebook.hatch, Claude com.anthropic.claude) - without the app they open the web.
  /// Grok Bot: custom scheme grokbot:// (declared in LSApplicationQueriesSchemes); if it can't open -> its App Store page. Siri -> Shortcuts.
  public struct AppLink: Equatable { public let primary: URL; public let fallback: URL? }
  public static func appLink(for key: String) -> AppLink? {
    switch key.lowercased() {
    case "muse": return AppLink(primary: URL(string: "https://muse.ai/chat")!, fallback: URL(string: "https://apps.apple.com/app/id6760173601"))
    case "claude": return AppLink(primary: URL(string: "https://claude.ai/new")!, fallback: URL(string: "https://apps.apple.com/app/id6473753684"))
    case "grok", "grok-bot": return AppLink(primary: URL(string: "grokbot://")!, fallback: URL(string: "https://apps.apple.com/app/id6794501026"))
    case "siri": return AppLink(primary: URL(string: "shortcuts://")!, fallback: URL(string: "https://apps.apple.com/app/id915249334"))
    default: return nil
    }
  }
  public static func prefills(_ id: String) -> Bool { id == "grok-bot" || id == "claude" }
  /// A purchase row's `agent` belongs to this AI (server ids: "grok-bot", "oauth-claude-desktop", "muse", "siri"/"owner-phone").
  public static func isAgent(_ agent: String, kinds: [String]) -> Bool {
    let a = agent.lowercased()
    return kinds.contains { k in a == k || a == "oauth-" + k || (k == "siri" && (a == "owner" || a.hasPrefix("owner-") || a.contains("siri"))) }
  }
}
