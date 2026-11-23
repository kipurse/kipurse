import Foundation
import KipurseCore

/// Built-in demo ("先看看演示"): sample data only. While active, nothing touches Face ID, the keychain / Secure Enclave key,
/// the network, or this phone's real wallet data. Buttons that would need Face ID show a short note instead.
enum DemoGuard {
  static var active = false { didSet { if active { URLProtocol.registerClass(DemoNetworkBlock.self) } else { URLProtocol.unregisterClass(DemoNetworkBlock.self) } } }
  static var note: String { T("演示里不会真的付款", "The demo never really pays") }
  static func say(_ s: String? = nil) { let t = s ?? note; DispatchQueue.main.async { NotificationCenter.default.post(name: .kpDemoNote, object: t) } }
  struct Blocked: LocalizedError { var errorDescription: String? { DemoGuard.note } }
}
extension Notification.Name { static let kpDemoNote = Notification.Name("kp.demo.note") }

/// Every URLSession.shared request fails while the demo runs (no server, no chain RPC).
final class DemoNetworkBlock: URLProtocol {
  override class func canInit(with request: URLRequest) -> Bool { DemoGuard.active }
  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
  override func startLoading() { client?.urlProtocol(self, didFailWithError: URLError(.notConnectedToInternet)) }
  override func stopLoading() {}
}

/// t1275 (#6): test / demo launch flags (-demo, -kp…, -wipeSelfTest, -openURL) exist only in Debug builds (UI tests). A Release build
/// strips them first thing at launch, so even code that reads CommandLine.arguments outside #if DEBUG never sees them. App Review's
/// demo is the kipurse://review-demo link (AppModel.handle -> startDemo), which never uses a launch flag.
enum LaunchFlags {
  static func isTestFlag(_ a: String) -> Bool { a == "-demo" || a.hasPrefix("-kp") || a == "-wipeSelfTest" || a == "-openURL" }
  static func releaseStrip() {
    #if !DEBUG
    CommandLine.arguments = CommandLine.arguments.enumerated().filter { $0.offset == 0 || !isTestFlag($0.element) }.map(\.element)
    #endif
  }
  static func has(_ f: String) -> Bool {
    #if DEBUG
    return CommandLine.arguments.contains(f)
    #else
    return false
    #endif
  }
  /// Any demo / UI-test flag on this launch (Debug only).
  static var anyTest: Bool {
    #if DEBUG
    return CommandLine.arguments.contains { $0 == "-demo" || $0 == "-wipeSelfTest" || $0.hasPrefix("-kp") }
    #else
    return false
    #endif
  }
}
