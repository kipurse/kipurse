// SPDX-License-Identifier: Apache-2.0
import XCTest
@testable import KipurseCore

/// t1346 (decision 169, owner t1302): every fee the app lets a batch pay goes to the company Safe 0x82ec…64fD; the retired
/// placeholder 0xf14E…0Dd9 and old ops account 0xfc0E…345B are refused; past fees paid to them still read as fees in records.
final class T1346CompanySafeFeeTests: XCTestCase {
  let safe = "0x82ecf6e2f76ee100e4676dabe193bca6bcab64fd"
  let old = "0xf14ef5dc4723245866c22c749a0a84afceba0dd9", ops = "0xfc0e68572cdba016c1c90a45e1792f3fe0ee345b"
  let W = "0x1000000000000000000000000000000000000001", O = "0x2000000000000000000000000000000000000002"

  func testOneFeeAddressEverywhere() {
    XCTAssertEqual(FeeAddress.company, safe)
    for a in [UsdcGas.feeTo, OwnerExit.withdrawFeeTo, RequestVerify.duesTo, KipurseV55.feeTo, ChainLedger.feeTo] { XCTAssertEqual(a.lowercased(), safe) }
    XCTAssertEqual(FeeAddress.retired, [old, ops])
    XCTAssertTrue(FeeAddress.isRetired(old) && FeeAddress.isRetired(ops.uppercased().replacingOccurrences(of: "0X", with: "0x")) && FeeAddress.isRetired(" \(old) "))
    XCTAssertFalse(FeeAddress.isRetired(safe) || FeeAddress.isRetired(nil) || FeeAddress.isRetired(""))
    XCTAssertEqual(SignHost.setPrefix, "/v13"); XCTAssertEqual(SignHost.previousPrefix, "/v12")
  }

  func testWithdrawPlanToRetiredAddressIsRefused() throws {
    let good = try XCTUnwrap(OwnerExit.withdrawBatchWalletPays(wallet: W, owner: O, vault: nil, amount: 1_000_000, fee: 11_336))
    let calls = good.map { ["to": $0.to, "value": "0x0", "data": $0.data] }
    XCTAssertNil(OwnerExit.verifyAnyPlan(calls: calls, wallet: W, owner: O, planOwner: O, vault: nil, amount: 1_000_000))
    XCTAssertTrue(calls[0]["data"]!.lowercased().contains(String(safe.dropFirst(2))), "fee leg pays the Safe")
    for r in [old, ops] {
      let bad = calls.map { c -> [String: String] in var c = c; c["data"] = c["data"]!.lowercased().replacingOccurrences(of: String(safe.dropFirst(2)), with: String(r.dropFirst(2))); return c }
      XCTAssertNotEqual(bad, calls)
      XCTAssertNotNil(OwnerExit.verifyAnyPlan(calls: bad, wallet: W, owner: O, planOwner: O, vault: nil, amount: 1_000_000), "fee to \(r) must be refused")
    }
  }

  func testWalletFeeLegOnlyToTheSafe() throws {
    let ok = try XCTUnwrap(OwnerExit.executeData(to: FeeAddress.company, amount: 3_000))
    XCTAssertEqual(RequestVerify.walletFeeLeg(["to": W, "value": "0x0", "data": ok], wallet: W).fee, 3_000)
    for r in [old, ops] {
      let d = try XCTUnwrap(OwnerExit.executeData(to: r, amount: 3_000))
      let v = RequestVerify.walletFeeLeg(["to": W, "value": "0x0", "data": d], wallet: W)
      XCTAssertNil(v.fee); XCTAssertNotNil(v.problem)
    }
  }

  func testRecordsStillShowPastFeesPaidToRetiredAddresses() {
    let w = W.lowercased(), o = O.lowercased()
    let t: [ChainLedger.Transfer] = [
      .init(tx: "0xa", t: 1, from: w, to: old, amount: 1_000, block: 1),
      .init(tx: "0xb", t: 2, from: w, to: safe, amount: 2_000, block: 2),
      .init(tx: "0xc", t: 3, from: w, to: o, amount: 500_000, block: 3, li: 0), .init(tx: "0xc", t: 3, from: w, to: ops, amount: 3_000, block: 3, li: 1)]
    let rows = ChainLedger.classify(transfers: t, wallet: w, owner: o)
    XCTAssertEqual(rows.map { $0["kind"]?.string ?? "" }, ["walletfee", "walletfee", "withdraw"])
    XCTAssertEqual(rows[2]["detail"]?["fee"]?.string, "3000")
  }
}
