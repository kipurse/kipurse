import SwiftUI
import KipurseCore

/// t1071: AppShortcutsProvider already makes Siri available on installation. No Shortcuts app/setup text.
/// Reuse the existing phone approval flow only when this phone is not yet authorized; never set connected locally.
enum SiriLauncher {
  @MainActor static func open(_ m: AppModel) {
    let armed = AIConnect.takeResume()
    if !armed && AIConnect.block(.siri, m) { return }
    if AIConnect.needsChoice(m) {
      guard armed, AIConnect.pendingAmounts != nil else { return }
      // No phone key yet: the existing enrollment is its own confirmation and does not write the AI policy.
      // Staged amounts stay in memory. After enrollment, Continue can reach the one spend signature.
      if !PhoneKey.isPresent() { enroll(m); return }
      Task { await AIConnect.confirmFirst(m, agent: "siri") }
      return
    }
    enroll(m)
  }
  /// Existing phone enrollment or, when this phone is already the signer, the Siri phrase sheet. Neither writes an AI total.
  @MainActor static func enroll(_ m: AppModel) {
    Task {
      #if DEBUG
      if m.demo != nil {
        m.lastLaunch = "siri:approval"
        if CommandLine.arguments.contains("-kpSiriOn") {
          NotificationCenter.default.post(name: .kpShowSiri, object: nil)
        } else {
          m.gasGate = GasGate(url: URL(string: "https://sign.kipurse.com/phone/enroll?id=demo")!, kind: .phoneUpgrade) {}
        }
        return
      }
      #endif
      if PhoneKey.isPresent(), let status = await PhoneKey.status(),
         let remote = status["fingerprint"] as? String,
         let local = PhoneKey.cachedFingerprint(), remote == local {
        NotificationCenter.default.post(name: .kpShowSiri, object: nil)
      } else {
        // Existing enrollment verifies the batch and presents fee/USDC + owner confirmation. No bypass.
        await PhoneKey.startUpgrade(m)
      }
    }
  }
}
