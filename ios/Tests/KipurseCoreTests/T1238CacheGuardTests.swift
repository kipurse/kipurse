import XCTest
@testable import KipurseCore

final class T1238CacheGuardTests: XCTestCase {
  let old = "0x515010c2e41F98CdDd76B819EE69DC832c0939B6", new = "0xeF6B64EB64a7f28215b0b97d51a2008458BF0dEb"
  func testOldWalletCacheIsNotShownForTheNewWallet() {
    XCTAssertFalse(CacheGuard.usable(cachedWallet: old, current: new))
    XCTAssertTrue(CacheGuard.usable(cachedWallet: new.lowercased(), current: new))
    XCTAssertFalse(CacheGuard.usable(cachedWallet: nil, current: new), "a cache without a wallet is not shown once a wallet is chosen")
    XCTAssertTrue(CacheGuard.usable(cachedWallet: old, current: ""), "before any wallet is chosen: unchanged behaviour")
  }
}
