import XCTest
@testable import KipurseCore

final class AgentBuyTests: XCTestCase {
  func testExamplesAndOpenLinks() {
    for zh in [true, false] {
      Loc.override = zh ? "zh" : "en"; defer { Loc.override = nil }
      let e = AgentBuy.examples(for: "grok-bot"); XCTAssertEqual(e.count, 3)
      XCTAssertTrue(e[0].text.contains("Kipurse")); XCTAssertFalse(e.contains { $0.text.contains("x402") || $0.text.contains("ExampleShop") })   // t927: no jargon / self-promo in examples
      XCTAssertTrue(AgentBuy.examples(for: "siri")[0].text.contains("Siri"))
    }
    XCTAssertTrue(AgentBuy.openURL(for: "grok-bot", text: "a b&c")!.absoluteString.hasPrefix("grokbot://app/v1/prompt?text=a%20b%26c"))
    XCTAssertTrue(AgentBuy.openURL(for: "claude", text: "x")!.absoluteString.hasPrefix("https://claude.ai/new?q="))
    XCTAssertNil(AgentBuy.openURL(for: "siri", text: ""), "t922: no Shortcuts for Siri")
    XCTAssertNil(AgentBuy.openURL(for: "unknown", text: ""))
  }
  func testPurchasesMatchOnlyThisAgent() {
    XCTAssertTrue(AgentBuy.isAgent("oauth-claude-desktop", kinds: ["claude", "claude-desktop"]))
    XCTAssertTrue(AgentBuy.isAgent("grok-bot", kinds: ["grok-bot"]))
    XCTAssertFalse(AgentBuy.isAgent("grok-bot", kinds: ["claude", "claude-desktop"]))
    XCTAssertFalse(AgentBuy.isAgent("muse", kinds: ["grok-bot"]))
  }
}
