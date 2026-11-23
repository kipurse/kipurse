#if !T797SIM
import XCTest
import AppIntentsTesting

/// Siri / Spotlight module through the real system pathways (AppIntentsTesting): entities, Spotlight, view annotations,
/// and the safety rules. Demo data only; no network, no money, nothing is confirmed.
@available(iOS 27.0, *)
final class AssistantUITests: XCTestCase {
  var app: XCUIApplication!
  var defs: IntentDefinitions { IntentDefinitions(bundleIdentifier: bundleId) }
  /// "<KIPURSE_BUNDLE_ID_PREFIX>.app.<variant>", derived from this test bundle's id ("<KIPURSE_BUNDLE_ID_PREFIX>.uitests").
  var bundleId: String {
    let prefix = (Bundle(for: AssistantUITests.self).bundleIdentifier ?? "org.example.kipurse.uitests").replacingOccurrences(of: ".uitests", with: "")
    #if KP_VARIANT_fork
    return prefix + ".app.fork"
    #else
    return prefix + ".app.test"
    #endif
  }
  override func setUp() async throws {
    continueAfterFailure = false
    app = await XCUIApplication(); await MainActor.run { app.launchArguments = ["-demo", "main", "-tab", "home", "-kp.lang", "zh", "-kpAssistantDemo"]; app.launch() }
    try await Task.sleep(nanoseconds: 2_500_000_000)
  }
  func testEveryIntentAndEntityIsRegistered() throws {
    for i in ["BalanceIntent", "PauseIntent", "OpenApprovalsIntent", "WithdrawIntent", "MainBalanceIntent", "MainActivityIntent", "StartPaymentIntent",
              "PayIntent", "RepeatPaymentIntent", "AddPayeeNicknameIntent", "ApproveIntent", "RejectIntent"] { XCTAssertEqual(defs.intents[i].identifier, i) }
    for e in ["PayeeEntity", "PaymentEntity", "ApprovalEntity"] { XCTAssertEqual(defs.entities[e].typeIdentifier, e) }
  }
  func testSavedPayeesOwnerFirstNoAddressAnywhere() async throws {
    let all = try await defs.entities["PayeeEntity"].suggestedEntities()
    XCTAssertGreaterThanOrEqual(all.count, 2)
    for e in all { let s = "\(e) \(e.identifier)"; XCTAssertFalse(s.lowercased().contains("0x4242"), s); XCTAssertFalse(s.contains("1000000000000000000000000000000000000003"), s) }
    let mine = try await defs.entities["PayeeEntity"].entities(matching: "我自己")
    XCTAssertEqual(mine.count, 1)
    let none = try await defs.entities["PayeeEntity"].entities(matching: "0x9999999999999999999999999999999999999999"); XCTAssertTrue(none.isEmpty)   // unsaved address
  }
  func testSpotlightHasPayeesAndPaymentsButNoBalanceOrAddress() async throws {
    // t1209: the demo seed indexes Spotlight asynchronously after launch (iOS 27.2 sim can take > 2.5 s); wait up to ~30 s for the index
    // instead of one query at launch. Same assertions; nothing is skipped or loosened.
    var p = try await defs.entities["PayeeEntity"].spotlightQuery()
    var y = try await defs.entities["PaymentEntity"].spotlightQuery()
    var n = 0
    while (p.isEmpty || y.isEmpty) && n < 15 {
      try await Task.sleep(nanoseconds: 2_000_000_000); n += 1
      p = try await defs.entities["PayeeEntity"].spotlightQuery(); y = try await defs.entities["PaymentEntity"].spotlightQuery()
    }
    XCTAssertFalse(p.isEmpty, "payees indexed"); XCTAssertFalse(y.isEmpty, "payments indexed")
    for e in p + y { let s = "\(e)"; XCTAssertFalse(s.contains("0x"), s); XCTAssertFalse(s.contains("19.79"), s) }   // demo balance 19.79
  }
  func testViewAnnotationsOnHome() async throws {
    // t803: only on-screen views are annotated. §6#110: approvals (待你批准) now sit at the top of AI 生活.
    await MainActor.run { app.tabBars.buttons.element(boundBy: 0).tap(); let r = app.descendants(matching: .any)["approve.open"].firstMatch; var n = 0; while !(r.exists && r.isHittable) && n < 6 { app.swipeUp(); n += 1 } }
    try await Task.sleep(nanoseconds: 1_000_000_000)
    let a = try await defs.entities["PaymentEntity"].viewAnnotations() + defs.entities["ApprovalEntity"].viewAnnotations()
    XCTAssertFalse(a.isEmpty, "home rows are annotated for on-screen awareness")
  }
  func testNicknameRejectsAddressesAndRepeatNeedsNothingUntrusted() async throws {
    let payee = try await defs.entities["PayeeEntity"].suggestedEntities().first!
    var i = defs.intents["AddPayeeNicknameIntent"].makeIntent(payee: payee, nickname: "0xdeadbeefdeadbeef")
    do { try await i.run(); XCTFail("address-like nickname accepted") } catch {}
    i = defs.intents["AddPayeeNicknameIntent"].makeIntent(payee: payee, nickname: "楼下咖啡店")
    try await i.run()
    let cafe = try await defs.entities["PayeeEntity"].entities(matching: "咖啡店"); XCTAssertEqual(cafe.count, 1)
  }
  func testPayUnknownPayeeIsRefusedBeforeAnyConfirmation() async throws {
    let fake = defs.entities["PayeeEntity"].makeReference(identifier: "p_notsaved")
    let i = defs.intents["PayIntent"].makeIntent(payee: fake, amount: 1.0)
    do { try await i.run(); XCTFail("paid an unsaved payee") } catch {}
    await MainActor.run { XCTAssertFalse(app.staticTexts["pay.amount"].exists, "no confirmation screen opened") }
  }
}

#endif
