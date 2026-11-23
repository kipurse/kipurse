import XCTest
@testable import KipurseCore

final class T1071AgentConnectTests: XCTestCase {
  func testClaudeConnectorFieldsArePrefilled() throws {
    let c = try XCTUnwrap(AgentCard.mainnet.first { $0.id == "claude" })
    let u = try XCTUnwrap(URLComponents(url: c.open, resolvingAgainstBaseURL: false))
    XCTAssertEqual(u.host, "claude.ai")
    XCTAssertEqual(u.path, "/customize/connectors")
    XCTAssertEqual(u.queryItems?.first { $0.name == "modal" }?.value, "add-custom-connector")
    XCTAssertEqual(u.queryItems?.first { $0.name == "connectorName" }?.value, "Kipurse")
    XCTAssertEqual(u.queryItems?.first { $0.name == "connectorUrl" }?.value, Mainnet.mcpURL)
  }
  func testGrokPromptCarriesCompleteConnectionURL() throws {
    let c = try XCTUnwrap(AgentCard.mainnet.first { $0.id == "grok-bot" })
    let u = try XCTUnwrap(URLComponents(url: try XCTUnwrap(c.app), resolvingAgainstBaseURL: false))
    XCTAssertEqual(u.scheme, "grokbot")
    XCTAssertEqual(u.queryItems?.first { $0.name == "text" }?.value, "Add this MCP server: " + Mainnet.mcpURL)
    XCTAssertTrue(c.prefill)
  }
}
