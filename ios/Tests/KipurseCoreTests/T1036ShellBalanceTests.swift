import XCTest
@testable import KipurseCore

final class T1036ShellBalanceTests: XCTestCase {
  func testShellTakesOnchainBalance() {
    let s = WalletState.shell(wallet: "0x515010c2e41f98cddd76b819ee69dc832c0939b6", owner: "0x4242b022a8296cb18b0e0b1cb9879c518170a718")
    XCTAssertEqual(s.balance, 0)
    let t = s.withBalance(12_340_000)
    XCTAssertEqual(t.balance, 12_340_000)
    XCTAssertTrue(t.active); XCTAssertEqual(t.wallet, s.wallet); XCTAssertEqual(t.owner, s.owner)
  }

  func testWithLedgerKeepsBalance() {
    let s = WalletState.shell(wallet: "0x515010c2e41f98cddd76b819ee69dc832c0939b6", owner: "0x4242b022a8296cb18b0e0b1cb9879c518170a718")
      .withBalance(12_340_000)
    let row: JSONValue = .object([
      "tx": .string("0xd5d5d5d5d500000000000000000000000000000000000000000000000000005d"),
      "t": .string("1790000000"), "account": .string("wallet"), "kind": .string("deposit"),
      "delta": .string("12340000"), "balance": .string("12340000"), "zh": .string("充值"),
    ])
    let t = s.withLedger([row])
    XCTAssertEqual(t.balance, 12_340_000)
    XCTAssertEqual(t.ledger.count, 1)
    XCTAssertEqual(t.ledger[0].signedShort, "+12.34")
  }
}
