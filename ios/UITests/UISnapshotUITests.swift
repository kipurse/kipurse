import XCTest
import UIKit

/// t991 UI FREEZE: approved reference screenshots for every main screen, zh/en × light/dark, on one fixed device (iPhone 18 Pro).
/// Any visual drift beyond the tolerance fails. References: Kipurse/UISnapshots/<name>.png (read from the source tree).
/// Re-approve ONLY after the owner signs off a design change: run with TEST_RUNNER_KPSNAP_RECORD=1 and update ~/t968/UI_SPEC.md.
final class UISnapshotUITests: XCTestCase {
  static let refDir = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().appendingPathComponent("UISnapshots")
  var app: XCUIApplication!

  struct Screen { let name: String; let args: [String]; var open: String? = nil }
  static let screens: [Screen] = [
    Screen(name: "home", args: ["-demo", "main", "-tab", "home"]),
    Screen(name: "home-empty", args: ["-demo", "main-new", "-tab", "home"]),
    Screen(name: "life", args: ["-demo", "main", "-tab", "life"]),
    Screen(name: "settings", args: ["-demo", "main", "-tab", "settings"]),
    Screen(name: "deposit", args: ["-demo", "main", "-tab", "home", "-kpApplePayMock"], open: "home.deposit"),
    Screen(name: "withdraw", args: ["-demo", "main", "-tab", "home"], open: "home.withdraw"),
  ]

  @MainActor func testUIFrozen() throws {
    let model = UIDevice.current.name
    guard model.contains("iPhone 18 Pro") && !model.contains("Max") else { throw XCTSkip("snapshots are approved on iPhone 18 Pro only (this is \(model))") }
    let record = ProcessInfo.processInfo.environment["KPSNAP_RECORD"] == "1"
    try? FileManager.default.createDirectory(at: Self.refDir, withIntermediateDirectories: true)
    var failures: [String] = []
    for s in Self.screens { for L in ["zh", "en"] { for C in ["Light", "Dark"] {
      let name = "\(s.name)-\(L)-\(C.lowercased())"
      app?.terminate(); app = XCUIApplication()
      app.launchArguments = s.args + ["-kp.lang", L, "-kpSkipFaceID", "-kpStill", "-kp" + C]; app.launch()
      XCTAssertTrue(app.wait(for: .runningForeground, timeout: 10))
      sleep(3)
      if let id = s.open { let b = app.descendants(matching: .any).matching(identifier: id).firstMatch
        XCTAssertTrue(b.waitForExistence(timeout: 8), "\(name): \(id) missing"); b.tap(); sleep(3) }
      let png = app.screenshot().pngRepresentation
      let ref = Self.refDir.appendingPathComponent(name + ".png")
      if record || !FileManager.default.fileExists(atPath: ref.path) { try png.write(to: ref); continue }
      let d = Self.diff(png, try Data(contentsOf: ref))
      if d > 0.02 {
        failures.append("\(name): \(String(format: "%.2f", d * 100))% of the screen changed")
        try? png.write(to: Self.refDir.appendingPathComponent("_failed-" + name + ".png"))
        let a = XCTAttachment(data: png, uniformTypeIdentifier: "public.png"); a.name = "actual-" + name; a.lifetime = .keepAlways; add(a)
      }
    } } }
    XCTAssertTrue(failures.isEmpty, "UI drift (frozen design, see UI_SPEC.md):\n" + failures.joined(separator: "\n"))
  }

  /// Fraction of cells (8×8 px blocks, status bar excluded) whose mean colour moved by more than 6 %.
  static func diff(_ a: Data, _ b: Data) -> Double {
    guard let ia = UIImage(data: a)?.cgImage, let ib = UIImage(data: b)?.cgImage else { return 1 }
    guard ia.width == ib.width, ia.height == ib.height else { return 1 }
    let w = ia.width / 8, h = ia.height / 8
    func px(_ i: CGImage) -> [UInt8] {
      var buf = [UInt8](repeating: 0, count: w * h * 4)
      let ctx = CGContext(data: &buf, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4, space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
      ctx.interpolationQuality = .medium; ctx.draw(i, in: CGRect(x: 0, y: 0, width: w, height: h)); return buf
    }
    let pa = px(ia), pb = px(ib); let top = Int(Double(h) * 0.06)   // skip the status bar (clock, battery)
    var bad = 0, all = 0
    for y in top..<h { for x in 0..<w { let o = (y * w + x) * 4; all += 1
      let m = max(abs(Int(pa[o]) - Int(pb[o])), abs(Int(pa[o+1]) - Int(pb[o+1])), abs(Int(pa[o+2]) - Int(pb[o+2])))
      if m > 15 { bad += 1 } } }
    return all == 0 ? 1 : Double(bad) / Double(all)
  }
}
