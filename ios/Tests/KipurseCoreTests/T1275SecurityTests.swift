// SPDX-License-Identifier: Apache-2.0
import XCTest
@testable import KipurseCore

/// t1275: security review fixes — hidden trust signers (#1), the trust ceiling from the limits signed on this phone (#2),
/// no success without the server's confirming fields (#3), two-node chain reads where a decision is made (#7).
final class T1275SecurityTests: XCTestCase {
  let W = "0x0eBd05A4a2226a59790600a54129f4b0E90fC817", v53 = "0xe635ab8852c3cb3b2125d3cb45018657ef73946b"
  let payee = "0x" + String(repeating: "3", count: 40), signer = "0x" + String(repeating: "4", count: 40)
  func msg(single: String = "2000000", daily: String = "10000000", signers: [String] = []) -> OwnerTrustMessage {
    OwnerTrustMessage(account: "0x" + String(repeating: "2", count: 40), merchant: "0x" + String(repeating: "a", count: 64), name: "shop.example", epoch: "0",
      payees: [payee], signers: signers, single: single, daily: daily, expiry: "1", nonce: "0x01", deadline: "1")
  }
  var savedT: ChainRPC.Transport!, savedAny: ChainRPC.AnyTransport!, store: UserDefaults!
  override func setUp() { savedT = ChainRPC.transport; savedAny = ChainRPC.anyTransport; store = UserDefaults(suiteName: "t1275-\(UUID().uuidString)"); SafetyCaps.store = store
    KipurseSuite.pin(nil); UserDefaults.standard.removeObject(forKey: "kp.suite." + W.lowercased()) }
  override func tearDown() { ChainRPC.transport = savedT; ChainRPC.anyTransport = savedAny; SafetyCaps.store = .standard; SafetyCaps.query = nil
    UserDefaults.standard.removeObject(forKey: "kp.suite." + W.lowercased()) }

  // MARK: #1 signers only with a verified grant
  func testSignersRefusedWithoutVerifiedGrant() {
    XCTAssertEqual(PhoneTrust.signerProblems(msg(), grantVerified: false), [])
    XCTAssertEqual(PhoneTrust.signerProblems(msg(), grantVerified: true), [])
    XCTAssertFalse(PhoneTrust.signerProblems(msg(signers: [signer]), grantVerified: false).isEmpty, "approve-trust card never shows signers without a grant")
    XCTAssertEqual(PhoneTrust.signerProblems(msg(signers: [signer]), grantVerified: true), [])
    // the stored (kind 1) V5.5 contract rule allows signers — the phone rule is what refuses them on the plain approve-trust path
    XCTAssertFalse(KipurseV55.trustProblems(KipurseV55.trustParams(msg(signers: [signer])), inline: false, deadline: "99999999999", now: Date(timeIntervalSince1970: 0)).contains { $0.contains("signer") })
    // same rule as the new-payee card
    XCTAssertTrue(OwnerAsk.trustProblems(msg(signers: [signer]), payee: payee, single: "2000000").contains("trust must not add order signers"))
  }

  // MARK: #2 ceiling = limits signed on this phone
  func testCeilingOnlyFromLocalSignedCopy() {
    let local = AISpendLimits.Saved(single: 2_000_000, daily: 10_000_000, term: 50_000_000)
    XCTAssertNil(SignedLimits.ceiling(local: nil, server: local), "no local copy -> no ceiling granted, whatever the server says")
    XCTAssertTrue(SignedLimits.ceiling(local: local, server: nil)! == (2_000_000, 10_000_000))
    let inflated = AISpendLimits.Saved(single: 500_000_000, daily: 900_000_000, term: 999_000_000)
    XCTAssertTrue(SignedLimits.ceiling(local: local, server: inflated)! == (2_000_000, 10_000_000), "a server value above the signed one is ignored")
    let lower = AISpendLimits.Saved(single: 1_000_000, daily: 3_000_000, term: 9_000_000)
    XCTAssertTrue(SignedLimits.ceiling(local: local, server: lower)! == (1_000_000, 3_000_000), "the server may only lower it")
  }
  func testServerInflatingEverydayCannotWidenTrust() {
    let raw: JSONValue = .object(["everyday": .object(["single": .string("500000000"), "daily": .string("900000000"), "term": .string("999000000"),
      "custom": .bool(true), "authorized": .bool(true), "at": .number(1_710_000_000_000)])])
    let server = AISpendLimits.saved(raw); XCTAssertNotNil(server)
    let local = AISpendLimits.Saved(single: 2_000_000, daily: 10_000_000, term: 50_000_000)
    let big = msg(single: "400000000", daily: "800000000")
    XCTAssertTrue(OwnerAsk.trustCapProblems(big, ceiling: OwnerAsk.trustCeiling(saved: server)).isEmpty, "the old source (server reply) would have allowed it")
    XCTAssertFalse(OwnerAsk.trustCapProblems(big, localCeiling: SignedLimits.ceiling(local: local, server: server)).isEmpty)
    XCTAssertFalse(OwnerAsk.trustCapProblems(big, localCeiling: SignedLimits.ceiling(local: nil, server: server)).isEmpty, "limits set elsewhere: refused")
    XCTAssertFalse(OwnerAsk.trustCapProblems(msg(single: "1", daily: "1"), localCeiling: nil).isEmpty, "nothing signed here refuses even a tiny trust")
    XCTAssertEqual(OwnerAsk.trustCapProblems(msg(), localCeiling: SignedLimits.ceiling(local: local, server: server)), [])
  }
  func testStoredFormAndAccount() {
    let g = AISpendLimits.Saved(single: 2_000_000, daily: 10_000_000, term: 50_000_000)
    XCTAssertEqual(SignedLimits.decode(SignedLimits.encode(g)), g)
    XCTAssertNil(SignedLimits.decode("5,1,9")); XCTAssertNil(SignedLimits.decode(nil)); XCTAssertNil(SignedLimits.decode("1,2"))
    XCTAssertEqual(SignedLimits.account(wallet: W), "everyday." + W.lowercased())
    XCTAssertNil(SignedLimits.account(wallet: "")); XCTAssertNil(SignedLimits.account(wallet: "0x1234"))
  }

  // MARK: #3 success needs the server's confirming field
  func testTrustReplyNeedsStatus() {
    XCTAssertFalse(TrustSignReply.trusted([:]), "an empty 200 is not a success")
    XCTAssertFalse(TrustSignReply.trusted(["ok": true])); XCTAssertFalse(TrustSignReply.trusted(["status": "awaiting_signature"]))
    XCTAssertFalse(TrustSignReply.trusted(["inline": true]))
    XCTAssertTrue(TrustSignReply.trusted(["status": "trusted", "txHash": "0xab"]))
    XCTAssertFalse(TrustSignReply.rejected([:])); XCTAssertFalse(TrustSignReply.rejected(["status": "trusted"])); XCTAssertTrue(TrustSignReply.rejected(["status": "rejected"]))
    XCTAssertFalse(TrustSignReply.notConfirmedEN.contains("✅")); XCTAssertFalse(TrustSignReply.notConfirmedZH.contains("✅"))
  }

  // MARK: #7 two nodes must agree
  func testAgreedAnyAndHead() async {
    let log: [String: Any] = ["topics": ["0xAA"], "data": "0x01", "blockNumber": "0x10", "logIndex": "0x1"]
    ChainRPC.anyTransport = { url, _, _ in url == ChainRPC.nodes[0] ? [log] as [Any] : [log.merging(["removed": false, "blockTimestamp": "0x5"]) { a, _ in a }] as [Any] }
    let ok = await ChainRPC.agreedAny("eth_getLogs", [], canon: ChainRPC.logsCanon)
    XCTAssertEqual((ok as? [Any])?.count, 1, "extra node fields don't matter")
    ChainRPC.anyTransport = { url, _, _ in url == ChainRPC.nodes[0] ? [log] as [Any] : [] as [Any] }
    let bad = await ChainRPC.agreedAny("eth_getLogs", [], canon: ChainRPC.logsCanon)
    XCTAssertNil(bad, "one node hiding a log = can't confirm")
    ChainRPC.transport = { url, _, _ in url == ChainRPC.nodes[0] ? "0x64" : "0x63" }
    let h = await ChainRPC.agreedHead(); XCTAssertEqual(h, 0x63, "the lower head: a block both nodes have")
    ChainRPC.transport = { url, _, _ in if url == ChainRPC.nodes[0] { return "0x64" }; throw URLError(.timedOut) }
    let one = await ChainRPC.agreedHead(); XCTAssertNil(one, "one node alone is not enough")
  }
  func testSafetyCapsScanNeedsTwoNodes() async {
    ChainRPC.transport = { _, m, _ in if m == "eth_blockNumber" { return "0x" + String(56_750_000, radix: 16) }; throw URLError(.badServerResponse) }
    // one node invents a permission event, the others see none -> unreadable, never a cap to celebrate
    ChainRPC.anyTransport = { url, m, _ in
      guard m == "eth_getLogs" else { throw URLError(.badServerResponse) }
      return url == ChainRPC.nodes[0] ? [["topics": [SafetyCaps.eventTopic], "data": "0x" + String(repeating: "0", count: 64), "blockNumber": "0x3614a0d", "logIndex": "0x1"]] as [Any] : [] as [Any]
    }
    let r = await SafetyCaps.read(account: "0x" + String(repeating: "5", count: 40))
    XCTAssertEqual(r.caps, .unreadable)
  }
  func testSuiteDetectUsesTwoNodes() async {
    ChainRPC.transport = { url, _, _ in url == ChainRPC.nodes[0] ? "0x6080" : "0x" }   // one node says the V5.3 vault has code, the other says no
    let s = await KipurseSuite.detect(wallet: W, serverVault: v53)
    XCTAssertEqual(s, .v52); XCTAssertNil(KipurseSuite.stored(wallet: W))
    ChainRPC.transport = { _, _, _ in "0x6080" }
    let yes = await KipurseSuite.detect(wallet: W, serverVault: v53)
    XCTAssertEqual(yes, .v53)
  }

  // MARK: app wiring (source guards for the app target, which SwiftPM does not build)
  func root(_ f: String) throws -> String { try String(contentsOf: URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().appendingPathComponent(f), encoding: .utf8) }
  func testAppWiring() throws {
    let yml = try root("project.yml"), dbg = try root("App/KipurseDebug.entitlements")
    let rel = try root("App/Kipurse.entitlements")
    XCTAssertTrue(rel.contains("$(KIPURSE_BUNDLE_ID_PREFIX).keys</string>") && rel.contains("$(KIPURSE_BUNDLE_ID_PREFIX).app</string>"), "Release keeps .keys (phone key, default group) and .app")
    XCTAssertTrue(rel.range(of: "keys</string>")!.lowerBound < rel.range(of: ".app</string>")!.lowerBound, ".keys stays the first (default) group: existing items stay readable")
    XCTAssertFalse(rel.contains(".app.$(KIPURSE_DEBUG_SUFFIX)</string>"), "#5: Release no longer lists the Debug build's group")
    XCTAssertTrue(yml.contains("Release: { PRODUCT_BUNDLE_IDENTIFIER: \"$(KIPURSE_BUNDLE_ID_PREFIX).app\", KIPURSE_ONBOARD: \"YES\", CODE_SIGN_ENTITLEMENTS: App/Kipurse.entitlements }"))
    XCTAssertTrue(dbg.contains(".app.$(KIPURSE_DEBUG_SUFFIX)</string>") && dbg.contains(".keys</string>"))
    XCTAssertTrue(yml.contains("CODE_SIGN_ENTITLEMENTS: App/KipurseDebug.entitlements"))
    XCTAssertTrue(yml.contains("if [ \"$CONFIGURATION\" = \"Release\" ]; then /usr/libexec/PlistBuddy -c \"Delete :NSAppTransportSecurity:NSAllowsLocalNetworking\""), "#6")
    let app = try root("App/Sources/KipurseApp.swift"), dg = try root("App/Sources/DemoGuard.swift"), am = try root("App/Sources/AppModel.swift")
    XCTAssertTrue(app.contains("    LaunchFlags.releaseStrip()"), "#6: Release drops -demo / -kp… flags first thing")
    XCTAssertTrue(dg.contains("#if !DEBUG\n    CommandLine.arguments = CommandLine.arguments"))
    XCTAssertTrue(am.contains("if LaunchFlags.has(\"-kpKeyDiag\")"))
    XCTAssertTrue(am.contains("url.host == \"review-demo\"") && am.contains("{ startDemo() }"), "App Review demo is the deep link, not a launch flag")
    XCTAssertTrue(DeepLinkGate.reviewDemoAllowed(hasState: false, inDemo: false, wallet: "", owner: nil, rememberedWallet: nil, hasSession: false))
    let plat = try root("App/Sources/Platform.swift")
    XCTAssertTrue(plat.contains("static let maxBytes = 256 * 1024") && plat.contains("#if DEBUG\n    NSLog(\"[kp-auth] %@\", line)\n    #endif"), "#4: capped, NSLog Debug only")
    XCTAssertEqual(plat.components(separatedBy: "NSLog(").count - 1, 1)
    let ca = try root("App/Sources/ConnectApprove.swift"), av = try root("App/Sources/AllowancesView.swift"), ps = try root("App/Sources/PhoneSigner.swift")
    XCTAssertTrue(ca.contains("SignedLimitsStore.save(g, wallet: PhoneTrust.mainnetWallet)"), "#2: first connect stores the signed amounts")
    XCTAssertTrue(am.contains("SignedLimitsStore.clear()"), "#2: cleared with the wallet")
    XCTAssertTrue(av.contains("let cap = SignedLimitsStore.ceiling(m)") && ps.contains("let ceil0 = SignedLimitsStore.ceiling(app)"))
    XCTAssertFalse(av.contains("OwnerAsk.trustCeiling(saved: overallAtomic)"), "#2: never the server's overall numbers")
    XCTAssertTrue(ps.contains("PhoneTrust.signerProblems(om, grantVerified:") && av.contains("PhoneTrust.signerProblems(om, grantVerified:"), "#1 on both trust paths")
    XCTAssertEqual(ps.components(separatedBy: "guard TrustSignReply.").count - 1, 3, "#3: approve, approve+grant, reject")
  }
}
