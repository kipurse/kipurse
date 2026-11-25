// SPDX-License-Identifier: Apache-2.0
import XCTest
@testable import KipurseCore

/// t147 (decision 147): plain-HTTP LAN servers are Debug-only; Release accepts HTTPS only.
final class T147ReleaseLANTests: XCTestCase {
  func testReleaseRefusesPlainHTTPLAN() {
    for s in ["http://192.168.1.5:8787", "http://10.0.0.2", "http://localhost:8080", "http://mac.local", "http://172.16.0.9"] {
      XCTAssertFalse(Server.isAllowed(URL(string: s)!, allowLAN: false), s)
      XCTAssertTrue(Server.isAllowed(URL(string: s)!, allowLAN: true), s)
    }
    XCTAssertTrue(Server.isAllowed(URL(string: "https://pay.kipurse.com")!, allowLAN: false))
    XCTAssertFalse(Server.isAllowed(URL(string: "http://example.com")!, allowLAN: true))
    XCTAssertFalse(Server.isAllowed(URL(string: "ftp://192.168.1.5")!, allowLAN: true))
  }
  func testDebugTestBuildKeepsLAN() {
    #if DEBUG
    XCTAssertTrue(Server.lanHTTPAllowed)
    #else
    XCTAssertFalse(Server.lanHTTPAllowed)
    #endif
  }
}
