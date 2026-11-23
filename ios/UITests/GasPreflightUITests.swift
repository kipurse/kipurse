import XCTest

#if KP_VARIANT_fork
/// Network-fee preflight (fork build with a chain RPC): the user pays their own gas; signing is blocked when ETH is short.
/// Needs the local mock RPC (/tmp/kp-mockrpc.py, balance read from /tmp/kp-mockrpc-balance) — simulator only, no real chain.
final class GasPreflightUITests: XCTestCase {
  var app: XCUIApplication!
  override func setUp() { continueAfterFailure = false }
  func open(_ lang: String, balanceWei: String) {
    try? balanceWei.write(toFile: "/tmp/kp-mockrpc-balance", atomically: true, encoding: .utf8)
    app = XCUIApplication(); app.launchArguments = ["-kpGasGate", "-kpGasEth", "-kp.lang", lang]; app.launch()
  }
  func sign() -> XCUIElement { let b = app.buttons["gas.sign"]; var n = 0; while !b.exists && n < 4 { app.swipeUp(); n += 1 }; return b }
  func shot(_ name: String) { let a = XCTAttachment(screenshot: app.screenshot()); a.name = name; a.lifetime = .keepAlways; add(a) }
  func testShortBlocksSigning() {
    open("zh", balanceWei: "2000000000000")
    XCTAssertTrue(app.descendants(matching: .any)["gas.missing"].waitForExistence(timeout: 10))
    let why = app.descendants(matching: .any)["gas.why"].firstMatch; if why.waitForExistence(timeout: 10) { why.tap() }  // t796: details under Why?
    XCTAssertTrue(app.descendants(matching: .any)["gas.notice"].firstMatch.label.contains("不收一分钱"))
    XCTAssertFalse(sign().isEnabled); shot("gas-short-zh")
  }
  func testShortEnglish() {
    open("en", balanceWei: "2000000000000")
    XCTAssertTrue(app.descendants(matching: .any)["gas.missing"].waitForExistence(timeout: 10))
    XCTAssertFalse(sign().isEnabled); shot("gas-short-en")
  }
  func testEnoughAllowsSigning() {
    open("zh", balanceWei: "577000000000000")
    XCTAssertTrue(app.descendants(matching: .any)["gas.balance"].waitForExistence(timeout: 10))
    XCTAssertFalse(app.descendants(matching: .any)["gas.missing"].exists)
    XCTAssertTrue(sign().isEnabled); shot("gas-ok-zh")
  }
  func testRPCDownFailsClosed() {
    open("zh", balanceWei: "bad")   // mock answers no result -> read error
    XCTAssertTrue(app.descendants(matching: .any)["gas.error"].waitForExistence(timeout: 15))
    XCTAssertFalse(sign().isEnabled); shot("gas-rpcdown-zh")
  }
}
#endif
