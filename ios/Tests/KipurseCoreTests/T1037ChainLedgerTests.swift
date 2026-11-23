import XCTest
@testable import KipurseCore

final class T1037ChainLedgerTests: XCTestCase {
  let W = "0x515010c2e41f98cddd76b819ee69dc832c0939b6"
  let O = "0x4242b022a8296cb18b0e0b1cb9879c518170a718"
  let TX = "0xd5d5d5d5d500000000000000000000000000000000000000000000000000005d"

  func testTopicAddressPads() {
    XCTAssertEqual(ChainLedger.topicAddress(W), "0x000000000000000000000000515010c2e41f98cddd76b819ee69dc832c0939b6")
    XCTAssertNil(ChainLedger.topicAddress("0x12"))
  }

  func testParseDepositLog() {
    let log: [String: Any] = [
      "topics": [
        ChainLedger.transferTopic,
        "0x0000000000000000000000004242b022a8296cb18b0e0b1cb9879c518170a718",
        "0x000000000000000000000000515010c2e41f98cddd76b819ee69dc832c0939b6",
      ],
      "data": "0x0000000000000000000000000000000000000000000000000000000000bc4b20",
      "transactionHash": TX,
      "blockTimestamp": "0x6ab13b80",
      "blockNumber": "0x3000000",
    ]
    let tr = ChainLedger.parseLog(log)
    XCTAssertEqual(tr?.amount, 12_340_000)
    XCTAssertEqual(tr?.from, O)
    XCTAssertEqual(tr?.to, W)
    XCTAssertEqual(tr?.tx, TX)
    XCTAssertEqual(tr?.t, 0x6ab13b80)
  }

  func testRowsDepositFillsLedger() {
    let tr = ChainLedger.Transfer(tx: TX, t: 1_790_000_000, from: O, to: W, amount: 12_340_000)
    let rows = ChainLedger.rows(transfers: [tr], wallet: W, owner: O, endingBalance: 12_340_000)
    XCTAssertEqual(rows.count, 1)
    let st = WalletState.shell(wallet: W, owner: O).withBalance(12_340_000).withLedger(rows)
    XCTAssertEqual(st.balance, 12_340_000)
    XCTAssertEqual(st.ledger.count, 1)
    XCTAssertEqual(st.ledger[0].kind, "deposit")
    XCTAssertEqual(st.ledger[0].delta, 12_340_000)
    XCTAssertEqual(st.ledger[0].balance, 12_340_000)
    XCTAssertEqual(st.ledger[0].tx, TX)
    XCTAssertFalse(st.ledger[0].suspicious)
  }

  func testRowsWithdrawAndRunningBalance() {
    let dep = ChainLedger.Transfer(tx: "0xaaa", t: 100, from: O, to: W, amount: 10_000_000)
    let wdr = ChainLedger.Transfer(tx: "0xbbb", t: 200, from: W, to: O, amount: 3_000_000)
    let rows = ChainLedger.rows(transfers: [dep, wdr], wallet: W, owner: O, endingBalance: 7_000_000)
    XCTAssertEqual(rows.count, 2)
    XCTAssertEqual(rows[0]["kind"]?.string, "withdraw")
    XCTAssertEqual(rows[0]["delta"]?.atomic, -3_000_000)
    XCTAssertEqual(rows[0]["balance"]?.atomic, 7_000_000)
    XCTAssertEqual(rows[1]["kind"]?.string, "deposit")
    XCTAssertEqual(rows[1]["balance"]?.atomic, 10_000_000)
  }

  func testWithLedgerOnlyWhenEmptyDoesNotMatterPure() {
    let s = WalletState.shell(wallet: W, owner: O)
    XCTAssertTrue(s.ledger.isEmpty)
    let filled = s.withLedger([.object([
      "tx": .string(TX), "t": .string("1790000000"), "account": .string("wallet"),
      "kind": .string("deposit"), "delta": .string("12340000"), "balance": .string("12340000"), "zh": .string("充值"),
    ])])
    XCTAssertEqual(filled.ledger.count, 1)
  }

  func testRecentUsesMockLogs() async {
    let saved = ChainRPC.transport; let savedAny = ChainRPC.anyTransport
    defer { ChainRPC.transport = saved; ChainRPC.anyTransport = savedAny }
    let node = URL(string: "https://mock.example")!
    ChainRPC.transport = { _, method, _ in
      if method == "eth_blockNumber" { return "0x3000000" }
      throw URLError(.badServerResponse)
    }
    ChainRPC.anyTransport = { _, method, params in
      if method == "eth_getLogs" {
        let filter = params[0] as! [String: Any]
        let topics = filter["topics"] as! [Any]
        // only return the inbound match
        let t2 = topics[2]
        if t2 is NSNull { return [] as [Any] }
        return [[
          "topics": [
            ChainLedger.transferTopic,
            "0x0000000000000000000000004242b022a8296cb18b0e0b1cb9879c518170a718",
            "0x000000000000000000000000515010c2e41f98cddd76b819ee69dc832c0939b6",
          ],
          "data": "0x0000000000000000000000000000000000000000000000000000000000bc4b20",
          "transactionHash": self.TX,
          "blockTimestamp": "0x6ab13b80",
          "blockNumber": "0x3000000",
        ]] as [Any]
      }
      throw URLError(.badServerResponse)
    }
    let rows = await ChainLedger.recent(wallet: W, owner: O, endingBalance: 12_340_000, nodes: [node])
    XCTAssertEqual(rows?.count, 1)
    XCTAssertEqual(rows?[0]["delta"]?.atomic, 12_340_000)
    XCTAssertEqual(rows?[0]["kind"]?.string, "deposit")
  }
}
